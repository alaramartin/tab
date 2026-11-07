// Hub logic: routing, the predict loop, ghosts, payments, sequences, counters.
// Transport-free so the websocket server, replay, and tests can all drive it.
import type { Action, El, Ghost, HubToShell, HubToWeb, PaymentRequired, Rect, ScreenState, UserEvent } from "../../protocol/types.ts";
import { countStep, newHud } from "./counters.ts";
import { History, toTarget, type HistEntry } from "./history.ts";
import { log } from "./log.ts";
import type { Decider } from "./model.ts";
import { PatternEngine, type PatternAction, type Step } from "./pattern.ts";
import { CHROME, contentSig, findEl, StateStore, stateKey } from "./state.ts";
import type { Memory } from "./memory/store.ts";

/** STRETCH: native steps take this many times as long, so the audience can follow (human's call: 10% slower). */
const NATIVE_PACE = Number(process.env.TAB_NATIVE_PACE ?? 1.1);

const DEBOUNCE_MS = 150;
const IDLE_MS = 600; // model ghosts wait for this much quiet
const SHOW_AT = 0.6;
const EXEC_TIMEOUT_MS = 3000;
const STATE_WAIT_MS = 1000;
const ECHO_MS = 400; // user_events C reports for our own exec

type Shown = { ghost: Ghost; action?: Action; paymentId?: string };

export interface BrainOpts {
    sendShell(m: HubToShell): void;
    sendWeb(m: HubToWeb): void;
    decider: Decider | null;
    /** Replay/tests: predict right away instead of debouncing and waiting for idle. */
    immediate?: boolean;
    /** Where learned workflows are saved (`~/.tab/workflows.json` in the hub); omit for memory only (tests). */
    workflowsFile?: string | null;
    /** Name icon-only controls from their pixels (the hub's vision model); omit to leave them unnamed. */
    nameIcons?(items: { hash: string; png: string }[]): Promise<{ hash: string; label: string }[]>;
    /** Action memory (~/.tab/memory.db in the hub); omit in tests that don't need it. */
    memory?: Memory | null;
    onPredict?(info: { source: "pattern" | "model"; latencyMs: number; action: Action | null }): void;
}

export class Brain {
    store = new StateStore();
    history = new History();
    pattern: PatternEngine;
    hud = newHud();

    private gen = 0;
    private ghostSeq = 0;
    private shown: Shown | null = null;
    private dismissedKey: string | null = null;
    private lastInputTs = 0;
    private lastSig = "";
    private timer: NodeJS.Timeout | null = null;
    private payment: PaymentRequired | null = null;
    private paying: string | null = null; // paymentId accepted and settling
    private running: { stop: boolean } | null = null;
    private echoUntil = 0;
    private execWaiters = new Map<string, (r: { ok: boolean; error?: string }) => void>();
    private stateWaiters: { key: string; resolve: () => void }[] = [];
    private modelCache: { key: string; action: Action | null } | null = null;
    private modelAbort: AbortController | null = null;

    constructor(private o: BrainOpts) {
        this.pattern = new PatternEngine({ file: o.workflowsFile ?? null });
    }

    /** Fresh start for a rehearsal or the demo: no history, no learned units, counters at 0, nothing on screen. */
    reset(keepWorkflows = false): void {
        if (this.timer) clearTimeout(this.timer);
        this.history = new History();
        if (!keepWorkflows) this.pattern.forgetWorkflows();
        this.pattern = new PatternEngine({ file: this.o.workflowsFile ?? null }); // reloads what was kept
        this.hud = newHud();
        this.payment = null;
        this.paying = null;
        this.dismissedKey = null;
        this.modelCache = null;
        this.echoUntil = 0;
        this.lastSig = "";
        this.gen++;
        if (this.running) this.running.stop = true;
        this.shown = null;
        this.o.sendShell({ type: "ghost_hide" });
        this.sendHud();
    }

    private pushHistory(e: HistEntry): void {
        this.history.push(e);
        try {
            this.o.decider?.observe?.(e);
        } catch (err) {
            console.error("[decider] observe:", (err as Error).message);
        }
    }

    /** Memory writes never break prediction: a failed write is logged and dropped. */
    private remember(f: () => unknown): void {
        try {
            f();
        } catch (err) {
            console.error("[memory]", (err as Error).message);
        }
    }

    // ---------- inbound ----------

    fromShell(m: any): void {
        log.incoming("shell", m);
        switch (m.type) {
            case "hello":
                this.sendHud();
                break;
            case "frontmost":
                if (m.app === "dev.tab.shell") break;
                this.store.frontmost = { app: m.app, window: m.window };
                this.onActiveMaybeChanged();
                break;
            case "state":
                this.onState(m);
                break;
            case "user_event":
                // AX reads of Chrome duplicate what CDP reports when it's connected: let C speak for its pages then.
                if (m.app === CHROME && this.store.webLive()) break;
                this.onUserEvent(m);
                break;
            case "icon_request":
                if (this.o.nameIcons && Array.isArray(m.items) && m.items.length)
                    this.o.nameIcons(m.items).then(
                        (items) => this.o.sendShell({ type: "icon_labels", items }),
                        (err) => console.error("[icons]", (err as Error).message),
                    );
                break;
            case "input":
                this.hud.youDid++;
                this.onUserInput();
                break;
            case "accept":
                this.hud.youDid++;
                void this.onAccept(m.ghostId);
                break;
            case "dismiss":
                this.hud.youDid++;
                this.onDismiss(m.ghostId);
                break;
            case "exec_result":
                this.execWaiters.get(m.ghostId)?.(m);
                break;
            case "hud_click":
                if (m.item === "ledger" && this.hud.lastTx) this.o.sendWeb({ type: "open_url", url: this.hud.lastTx.explorerUrl });
                break;
        }
    }

    fromWeb(m: any): void {
        log.incoming("web", m);
        switch (m.type) {
            case "hello":
                break;
            case "state":
                this.onState(m);
                break;
            case "user_event":
                this.onUserEvent(m);
                break;
            case "exec_result":
                this.execWaiters.get(m.ghostId)?.(m);
                break;
            case "payment_required":
                this.payment = m;
                this.showPayment(m);
                break;
            case "payment_result":
                this.onPaymentResult(m);
                break;
        }
    }

    // ---------- state & input ----------

    private onState(s: ScreenState): void {
        if (s.source === "ax" && s.app === CHROME && this.store.webLive()) return; // CDP speaks for Chrome
        this.store.put(s);
        this.remember(() => this.o.memory?.putState(s));
        try {
            this.o.decider?.see?.(s);
        } catch {}
        const key = stateKey(s);
        this.stateWaiters = this.stateWaiters.filter((w) => (w.key === key ? (w.resolve(), false) : true));
        if (this.running) return;
        const active = this.store.active();
        if (!active || stateKey(active) !== key) return;
        const sig = contentSig(active);
        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.schedule(DEBOUNCE_MS);
        } else {
            this.refreshGhostRect(active);
        }
    }

    private onActiveMaybeChanged(): void {
        const active = this.store.active();
        const sig = active ? stateKey(active) + "\n" + contentSig(active) : "";
        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.schedule(DEBOUNCE_MS);
        }
    }

    private onUserEvent(e: UserEvent): void {
        if (this.running || Date.now() < this.echoUntil) return; // our own exec, echoed back by the page
        if (e.kind === "focus") return;
        const op = e.kind === "navigate" ? "navigate" : e.kind;
        this.remember(() =>
            this.o.memory?.addStep({ ts: e.ts, app: e.app, window: e.window, url: e.url, op, by: "user", target: e.target, value: e.value, before: e.before, partial: e.partial }),
        );
        this.pushHistory({
            op,
            app: e.app,
            url: e.url,
            window: e.window ?? this.store.forStep(e.app, e.url)?.window ?? (this.store.frontmost?.app === e.app ? this.store.frontmost.window : undefined),
            target: e.target ? toTarget(e.target) : undefined,
            value: e.value,
            ts: e.ts,
            by: "user",
        });
        this.dismissedKey = null; // the user did something on the page: everything may be offered again
        this.onUserInput(e.kind === "click" && e.target?.role === "button", true);
    }

    /**
     * Any real input hides the ghost; predict again after quiet. Button clicks may complete a pattern unit, so check that now.
     * Ignoring is sticky: a ghost hidden by input elsewhere isn't re-offered until the user acts on a page (onUserEvent).
     */
    private onUserInput(maybeUnitEnd = false, onPage = false): void {
        if (this.running) return;
        if (!onPage && this.shown?.action) this.dismissedKey = actionKey(this.shown.action);
        if (this.shown?.action) this.remember(() => this.o.memory?.ghostOutcome(this.shown!.ghost.id, "ignored"));
        this.hide();
        this.modelAbort?.abort(); // the screen is changing: a model answer for the old one is worthless
        this.lastInputTs = Date.now();
        this.gen++;
        this.schedule(maybeUnitEnd ? DEBOUNCE_MS : IDLE_MS);
    }

    // ---------- predict ----------

    private schedule(ms: number): void {
        if (this.o.immediate) return; // replay calls predictNow()
        if (this.timer) clearTimeout(this.timer);
        const gen = ++this.gen;
        this.timer = setTimeout(() => void this.predict(gen), ms);
    }

    async predictNow(): Promise<void> {
        await this.predict(++this.gen);
    }

    private async predict(gen: number): Promise<void> {
        if (this.running) return;
        if (this.payment) return this.paying === this.payment.paymentId ? undefined : this.showPayment(this.payment);
        const active = this.store.active();
        if (!active) return;

        // 1. Pattern rule.
        const now = Date.now();
        const t0 = performance.now();
        const pa = this.pattern.predict(this.history.entries, this.store.recent(now), now);
        const pMs = performance.now() - t0;
        if (pa) {
            const shown = this.maybeShow(pa, gen, pMs);
            this.logPred(gen, "pattern", pMs, pa, shown);
            if (shown) return;
        }

        // 1b. A saved workflow for this page, offered before the user starts (after a restart too).
        const t2 = performance.now();
        const rc = pa ? null : this.pattern.recall(active, this.store.recent(now), now, this.history.entries);
        if (rc) {
            const ms = performance.now() - t2;
            const shown = this.maybeShow(rc, gen, ms);
            this.logPred(gen, "pattern", ms, rc, shown);
            if (shown) return;
        }

        // 2. The decider: its fast tiers (habits, ~1 ms) may show a confident ghost right away; the local model runs only
        // after the user has paused, and is aborted as soon as anything changes.
        const decider = this.o.decider;
        if (!decider) return;
        if (decider.fast) {
            const t3 = performance.now();
            const fa = decider.fast({ active, others: this.store.recent(now), history: this.history.entries });
            const fMs = performance.now() - t3;
            if (fa) {
                const shown = this.maybeShow(fa, gen, fMs);
                this.logPred(gen, "pattern", fMs, fa, shown);
                if (shown) return;
            }
        }
        if (!this.o.immediate) {
            const wait = this.lastInputTs + IDLE_MS - Date.now();
            if (wait > 0) {
                this.timer = setTimeout(() => void this.predict(gen), wait);
                return;
            }
        }
        const key = `${stateKey(active)}\n${contentSig(active)}\n${this.history.entries.length}:${this.history.entries.at(-1)?.ts ?? 0}`;
        let action: Action | null;
        let ms = 0;
        if (this.modelCache?.key === key) {
            action = this.modelCache.action;
        } else {
            this.hud.mode = "predicting";
            this.sendHud();
            const t1 = performance.now();
            try {
                this.hud.modelCalls++;
                this.modelAbort?.abort();
                const ctl = (this.modelAbort = new AbortController());
                action = await decider.decide({
                    active,
                    others: this.store.recent(Date.now()),
                    history: this.history.entries,
                }, ctl.signal);
            } catch (err) {
                if ((err as Error).name !== "AbortError") console.error(`[model] ${decider.name}:`, (err as Error).message);
                action = null;
            }
            ms = performance.now() - t1;
            this.modelCache = { key, action };
            this.hud.mode = this.shown ? "shown" : "idle";
        }
        const shown = gen === this.gen && !!action && this.maybeShow(action, gen, ms);
        this.logPred(gen, "model", ms, action, shown);
        if (!shown) this.sendHud();
    }

    private maybeShow(a: Action, gen: number, latencyMs: number): boolean {
        if (gen !== this.gen || this.running) return false;
        if (a.confidence < SHOW_AT) return false;
        if (actionKey(a) === this.dismissedKey) return false;
        if (this.shown?.action && actionKey(this.shown.action) === actionKey(a)) return true; // already up
        const ghost = this.buildGhost(a);
        if (!ghost) return false;
        this.shown = { ghost, action: a };
        this.remember(() => this.o.memory?.ghostShown({ id: ghost.id, ts: Date.now(), action: a, latencyMs }));
        this.hud.shown++;
        this.hud.mode = "shown";
        this.hud.lastSource = a.source;
        this.hud.lastLatencyMs = Math.round(latencyMs);
        this.o.sendShell({ type: "ghost", ghost });
        this.sendHud();
        return true;
    }

    private buildGhost(a: Action): Ghost | null {
        const id = `g${++this.ghostSeq}`;
        const label = `${a.label} ⇥`;
        const active = this.store.active();

        if (active && active.source === "native") {
            // Terminal: no element rect, pill at the bottom-left of the window.
            const win = active.elements[0]?.rect;
            if (!win) return null;
            return { id, kind: "action", label, pillAt: { x: win.x + 16, y: win.y + win.h - 16 } };
        }

        const el = this.ghostTarget(a);
        if (!el) {
            // Offers without a target of their own (open a URL, a key, a sequence that starts in another app) anchor at
            // the insertion point of the focused field (a terminal prompt), else near the last click.
            if (a.op !== "navigate" && a.op !== "sequence" && a.op !== "key") return null;
            const focused = active?.elements.find((e) => e.focused);
            const caret = focused?.caret;
            if (caret) return { id, kind: "action", label, pillAt: { x: caret.x, y: caret.y + caret.h + 34 } };
            const near = this.lastClickedRect() ?? (focused && focused.rect.w > 0 ? { ...focused.rect, y: focused.rect.y + focused.rect.h - 60, h: 0 } : undefined);
            // STRETCH: a sequence that starts in another native app points at that app's Dock icon.
            const first = a.op === "sequence" ? (a.steps as Step[] | undefined)?.[0] : undefined;
            const dock = first && first.app !== CHROME && first.app !== active?.app ? { dockApp: first.app } : {};
            // pillAt is the pill's bottom-left corner; without an anchor, A centers the pill at the top of the screen.
            return near ? { id, kind: "action", label, pillAt: { x: near.x, y: near.y + near.h + 36 }, ...dock } : { id, kind: "action", label, ...dock };
        }
        const center = { x: el.rect.x + el.rect.w / 2, y: el.rect.y + el.rect.h / 2 };
        const empty = !el.value;
        const avoid = nearby(el.rect, active, el.id);
        if (a.op === "type" && empty && (el.role === "textfield" || el.role === "textarea")) {
            return { id, kind: "text", label: "⇥", rect: el.rect, ...(el.radius !== undefined ? { radius: el.radius } : {}), ghostText: a.value, ...(avoid.length ? { avoid } : {}) };
        }
        const ghost: Ghost = { id, kind: "action", label, rect: el.rect, ...(el.radius !== undefined ? { radius: el.radius } : {}), cursor: center, ...(avoid.length ? { avoid } : {}) };
        if (this.pillWouldCover(el, active)) ghost.place = "inside"; // ghost-spec amendment: dock in wide fields
        return ghost;
    }

    /** A pill below a wide field would sit on whatever comes right under it (flow 3: the first list row). */
    private pillWouldCover(el: El, active: ScreenState | undefined): boolean {
        if (!active || !["textfield", "textarea", "select"].includes(el.role) || el.rect.w < 160) return false;
        const top = el.rect.y + el.rect.h, bottom = top + 44; // pill gap + height, with margin
        return active.elements.some(
            (o) => o.id !== el.id && o.rect.y < bottom && o.rect.y + o.rect.h > top && o.rect.x < el.rect.x + 260 && o.rect.x + o.rect.w > el.rect.x,
        );
    }

    /** The element a ghost highlights: the target, or for a sequence, the first step we can find on screen. */
    private ghostTarget(a: Action): El | undefined {
        const steps: Step[] = a.op === "sequence" ? (a.steps as Step[]) ?? [] : [a];
        const front = this.store.active()?.app;
        for (const s of steps) {
            // Only what's on screen: a step in another (hidden) app would anchor on its last known, stale rect.
            if (front && s.app !== front) continue;
            const el = this.resolve(s);
            if (el) return el;
        }
        return undefined;
    }

    private refreshGhostRect(active: ScreenState): void {
        if (!this.shown?.action || !this.shown.ghost.rect) return;
        const el = this.ghostTarget(this.shown.action);
        if (!el || stateKey(active) !== (this.shown.action.url ?? stateKey(active))) return;
        const r = this.shown.ghost.rect;
        if (r.x === el.rect.x && r.y === el.rect.y && r.w === el.rect.w && r.h === el.rect.h) return;
        this.shown.ghost = {
            ...this.shown.ghost,
            rect: el.rect,
            ...(this.shown.ghost.cursor ? { cursor: { x: el.rect.x + el.rect.w / 2, y: el.rect.y + el.rect.h / 2 } } : {}),
        };
        this.o.sendShell({ type: "ghost", ghost: this.shown.ghost });
    }

    private hide(): void {
        if (!this.shown) return;
        this.shown = null;
        this.o.sendShell({ type: "ghost_hide" });
        this.hud.mode = "idle";
        this.sendHud();
    }

    // ---------- accept / dismiss ----------

    private async onAccept(ghostId: string): Promise<void> {
        const s = this.shown;
        if (!s || s.ghost.id !== ghostId) return;
        if (s.ghost.kind === "pay" && s.paymentId) {
            this.hud.accepted++;
            // In flight until payment_result (~10 s on venue wifi): the shell shows "Paying …"; input meanwhile must
            // not hide it or re-offer a live Pay ghost for a payment that's already settling.
            this.paying = s.paymentId;
            this.shown = null;
            this.hud.mode = "running";
            this.sendHud();
            this.o.sendWeb({ type: "pay", paymentId: s.paymentId });
            return;
        }
        if (!s.action) return;
        this.remember(() => this.o.memory?.ghostOutcome(ghostId, "accepted"));
        this.hud.accepted++;
        const steps: Step[] = s.action.op === "sequence" ? (s.action.steps as Step[]) : [s.action];
        const ok = await this.run(ghostId, steps);
        if (ok && s.action.source === "pattern") this.pattern.onAccepted((s.action as PatternAction).sig);
    }

    private onDismiss(ghostId: string): void {
        const s = this.shown;
        if (this.running) {
            this.running.stop = true; // Esc stops a sequence after the current step
            return;
        }
        if (!s || s.ghost.id !== ghostId) return;
        if (s.paymentId) {
            this.o.sendWeb({ type: "dismiss_payment", paymentId: s.paymentId });
            this.payment = null;
        }
        if (s.action) this.dismissedKey = actionKey(s.action);
        this.remember(() => this.o.memory?.ghostOutcome(ghostId, "dismissed"));
        if (s.action) {
            const a = s.action;
            this.remember(() => this.o.decider?.feedback?.(a, "dismissed", findEl(this.store.forStep(a.app, a.url), a.targetId, a.targetPath)));
        }
        this.hide();
    }

    // ---------- sequence runner ----------

    private resolve(s: Step): El | undefined {
        const st = this.store.forStep(s.app, s.url);
        if (s.match) {
            const c = s.match.contains.toLowerCase();
            return st?.elements.find((e) => e.list?.key === s.match!.listKey && e.label.toLowerCase().includes(c));
        }
        return findEl(st, s.targetId, s.targetPath);
    }

    private async run(ghostId: string, steps: Step[]): Promise<boolean> {
        const run = { stop: false };
        this.running = run;
        this.hud.mode = "running";
        this.sendHud();
        let ok = true;
        let at = -1;
        try {
            for (let k = 0; k < steps.length && !run.stop; k++) {
                at = k;
                const step = steps[k];
                if (step.onFail) continue; // only runs after a failure (below)
                const t0 = Date.now();
                if (step.app !== this.store.frontmost?.app && step.op !== "switch_app") {
                    const sw: Action = { op: "switch_app", app: step.app, value: step.app, label: "", confidence: 1, source: step.source };
                    const r = await this.exec(`${ghostId}:${k}a`, sw, "shell");
                    if (!r.ok) throw new Error(`switch_app ${step.app}: ${r.error}`);
                    countStep(this.hud, sw);
                    this.store.frontmost = { app: step.app, window: "" };
                }
                // A key step with a target (STRETCH: Return in Calendar's title field) needs it on screen like a click does.
                const needsTarget = step.op !== "navigate" && step.op !== "switch_app" && (step.op !== "key" || !!step.targetPath);
                let target = needsTarget ? this.resolve(step) : undefined;
                // A native app's screen arrives a beat after switching to it (STRETCH: Calendar): wait for it.
                for (let i = 0; !target && needsTarget && step.app !== CHROME && i < (step.optional ? 2 : 6); i++) {
                    await this.waitForState(step.app);
                    target = this.resolve(step);
                }
                // STRETCH: a step that must not run while something is still on screen (Escape with Calendar's event
                // popover open would discard the new event): wait for it to go, else skip.
                if (step.unlessPresent) {
                    for (let i = 0; i < 3 && findEl(this.store.forStep(step.app), step.unlessPresent, step.unlessPresent); i++) await this.waitForState(step.app);
                    if (findEl(this.store.forStep(step.app), step.unlessPresent, step.unlessPresent)) {
                        console.log(`[seq] ${ghostId}: step ${k} skipped, ${step.unlessPresent} still on screen`);
                        continue;
                    }
                }
                if (!target && needsTarget) {
                    if (step.optional) {
                        console.log(`[seq] ${ghostId}: step ${k} skipped, target not found (${step.targetPath ?? step.targetId})`);
                        continue;
                    }
                    throw new Error(`step ${k}: target not found (${step.targetPath ?? step.match?.contains ?? step.targetId})`);
                }
                const { match: _m, optional: _o, onFail: _f, unlessPresent: _u, ...wire } = step;
                const action: Action = { ...wire, targetId: target?.id ?? step.targetId, targetPath: target?.path ?? step.targetPath };
                const waitState = this.waitForState(step.app === CHROME && step.url ? step.url : step.app);
                const r = await this.exec(`${ghostId}:${k}`, action, step.op === "switch_app" ? "shell" : step.app === CHROME ? "web" : "shell");
                if (!r.ok) throw new Error(`step ${k} ${step.op}: ${r.error}`);
                countStep(this.hud, action, target);
                this.remember(() =>
                    this.o.memory?.addStep({ ts: Date.now(), app: action.app, url: step.url, op: action.op, by: "tab", target, value: action.value, ghostId }),
                );
                this.pushHistory({
                    op: action.op,
                    app: action.app,
                    window: this.store.forStep(action.app, step.url)?.window,
                    url: step.url ?? this.store.active()?.url,
                    target: target ? toTarget(target) : undefined,
                    value: action.value,
                    ts: Date.now(),
                    by: "tab",
                });
                this.sendHud();
                await waitState;
                // Native type posts keystrokes asynchronously (STRETCH: Calendar QuickEventCell).
                // waitForState can resolve on a stale poll while the field is still empty; Return then
                // discards the draft. Wait until the typed text is in the field, or ~1 s.
                if (step.op === "type" && step.value && step.app !== CHROME) await this.waitForTyped(step);
                if (step.app !== CHROME && step.op !== "switch_app" && NATIVE_PACE > 1) await new Promise((res) => setTimeout(res, (Date.now() - t0) * (NATIVE_PACE - 1)));
            }
        } catch (err) {
            ok = false;
            console.error(`[seq] ${ghostId}:`, (err as Error).message);
            // Never strand the user in another app after a failure: switch back (STRETCH: Calendar → Chrome).
            for (const s of steps.filter((s) => s.onFail && s.op === "switch_app")) {
                const { match: _m, optional: _o, onFail: _f, unlessPresent: _u, ...wire } = s;
                await this.exec(`${ghostId}:back`, wire, "shell");
            }
        } finally {
            this.running = null;
            this.echoUntil = Date.now() + ECHO_MS;
            this.shown = null;
            this.o.sendShell({ type: "ghost_hide" });
            this.hud.mode = "idle";
            this.sendHud();
            this.lastSig = ""; // force a fresh prediction on the next state
            this.schedule(DEBOUNCE_MS);
        }
        return ok && !run.stop;
    }

    private exec(ghostId: string, action: Action, to: "shell" | "web"): Promise<{ ok: boolean; error?: string }> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.execWaiters.delete(ghostId);
                resolve({ ok: false, error: "exec timeout" });
            }, action.app !== CHROME && action.op !== "switch_app" ? 8000 : EXEC_TIMEOUT_MS); // native steps wait up to 3 s for their target, then type
            this.execWaiters.set(ghostId, (r) => {
                clearTimeout(timer);
                this.execWaiters.delete(ghostId);
                resolve(r);
            });
            if (to === "shell") this.o.sendShell({ type: "exec", ghostId, action });
            else this.o.sendWeb({ type: "exec", ghostId, action });
        });
    }

    private waitForState(key: string): Promise<void> {
        return new Promise((resolve) => {
            const w = { key, resolve };
            this.stateWaiters.push(w);
            setTimeout(() => {
                this.stateWaiters = this.stateWaiters.filter((x) => x !== w);
                resolve();
            }, STATE_WAIT_MS);
        });
    }

    /** After a native `type`, wait until that field's reported value contains what we typed. */
    private async waitForTyped(step: Step, timeoutMs = 1000): Promise<void> {
        const want = step.value ?? "";
        if (!want) return;
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            const v = this.resolve(step)?.value ?? "";
            if (v === want || v.includes(want)) return;
            await new Promise((r) => setTimeout(r, 50));
        }
    }

    // ---------- payments ----------

    /** Corner radius of the element at `r` on the active page: pay, blocked and done ghosts only carry a rect (A fits its box to it). */
    private radiusAt(r: Rect | undefined): number | undefined {
        if (!r) return undefined;
        return this.store.active()?.elements.find((e) => e.rect.x === r.x && e.rect.y === r.y && e.rect.w === r.w && e.rect.h === r.h)?.radius;
    }

    private showPayment(p: PaymentRequired): void {
        if (!p.anchorRect) p.anchorRect = this.lastClickedRect(); // C should send it; fall back to what the user just clicked
        const id = `g${++this.ghostSeq}`;
        const ghost: Ghost = p.verdict.ok
            ? { id, kind: "pay", label: `Pay $${p.amountUsd} · ${p.payeeDomain} ⇥`, rect: p.anchorRect }
            : { id, kind: "blocked", label: `Blocked · ${p.verdict.reason ?? "payment does not match the page"}`, rect: p.anchorRect };
        if (p.anchorRect) {
            const radius = this.radiusAt(p.anchorRect);
            if (radius !== undefined) ghost.radius = radius;
            const avoid = nearby(p.anchorRect, this.store.active());
            if (avoid.length) ghost.avoid = avoid;
        }
        if (this.shown?.paymentId === p.paymentId && this.shown.ghost.kind === ghost.kind) return;
        this.shown = { ghost, paymentId: p.paymentId };
        this.hud.shown++;
        this.hud.mode = "shown";
        this.o.sendShell({ type: "ghost", ghost });
        this.sendHud();
    }

    private onPaymentResult(r: { paymentId: string; ok: boolean; txHash?: string; explorerUrl?: string; error?: string }): void {
        const p = this.payment;
        if (p && p.paymentId !== r.paymentId) return; // about a payment we've already moved past
        const wasPaying = this.paying === r.paymentId;
        if (wasPaying) this.paying = null;
        this.payment = null;
        if (!r.ok && r.error === "cancelled") {
            // The page went away (navigation, tab closed): nothing to pay or block anymore.
            if (this.shown?.paymentId === r.paymentId) this.hide();
            else if (wasPaying) this.o.sendShell({ type: "ghost_hide" }); // take down the shell's "Paying …" pill
            if (wasPaying) {
                this.hud.mode = "idle";
                this.sendHud();
            }
            return;
        }
        const id = `g${++this.ghostSeq}`;
        const rect = p?.anchorRect;
        const ghost: Ghost = r.ok
            ? { id, kind: "done", label: `Paid $${p?.amountUsd ?? "?"} ✓`, rect, ttlMs: 1500 }
            : { id, kind: "blocked", label: `Blocked · ${r.error ?? "payment failed"}`, rect };
        const radius = this.radiusAt(rect);
        if (radius !== undefined) ghost.radius = radius;
        if (r.ok && r.txHash && r.explorerUrl) this.hud.lastTx = { hash: r.txHash, explorerUrl: r.explorerUrl, amountUsd: p?.amountUsd ?? "" };
        this.shown = r.ok ? null : { ghost, paymentId: r.paymentId };
        this.o.sendShell({ type: "ghost", ghost });
        this.hud.mode = r.ok ? "idle" : "shown";
        this.sendHud();
    }

    // ---------- misc ----------

    /** Where the user (or Tab) last clicked, with the element's current rect. */
    private lastClickedRect(): Rect | undefined {
        for (let k = this.history.entries.length - 1; k >= 0; k--) {
            const e = this.history.entries[k];
            if (e.op !== "click" || !e.target) continue;
            return findEl(this.store.forStep(e.app, e.url), e.target.id, e.target.path)?.rect;
        }
        return undefined;
    }

    private sendHud(): void {
        this.o.sendShell({ type: "hud", hud: this.hud });
    }

    private logPred(gen: number, source: "pattern" | "model", latencyMs: number, action: Action | null, shown: boolean): void {
        const brief = action && { op: action.op, label: action.label, targetId: action.targetId, value: action.value, confidence: action.confidence, steps: action.steps?.length };
        log.prediction({ ts: Date.now(), gen, source, latencyMs: Math.round(latencyMs * 10) / 10, action: brief, shown });
        this.o.onPredict?.({ source, latencyMs, action });
    }
}

/**
 * Rects of the other elements within 120 pt of the target (any role, text included), for `Ghost.avoid`:
 * the shell knows the pill's real size and places it where it covers none of them (ghost-spec amendment, A).
 */
export function nearby(r: Rect, state: ScreenState | undefined, excludeId?: string): Rect[] {
    if (!state) return [];
    const gap = (a: Rect, b: Rect) => Math.max(0, a.x - (b.x + b.w), b.x - (a.x + a.w)) + Math.max(0, a.y - (b.y + b.h), b.y - (a.y + a.h));
    const same = (o: Rect) => o.x === r.x && o.y === r.y && o.w === r.w && o.h === r.h;
    return state.elements.filter((o) => o.id !== excludeId && !same(o.rect) && gap(o.rect, r) <= 120).map((o) => o.rect).slice(0, 40);
}

function actionKey(a: Action): string {
    return a.op === "sequence" ? `seq|${a.label}` : `${a.op}|${a.app}|${a.targetPath ?? a.targetId ?? ""}|${a.value ?? ""}`;
}
