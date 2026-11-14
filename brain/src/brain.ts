// Hub logic: the predict loop, ghosts, the sequence runner, payments, counters.
// Transport-free so the websocket server and tests drive it the same way.
import type { Action, El, Ghost, HubToDetector, HubToShell, MemoryHit, Rect, ScreenState, UserEvent } from "../../protocol/types.ts";
import { countStep, newHud } from "./counters.ts";
import { History, toTarget, type HistEntry } from "./history.ts";
import type { Memory } from "./memory/store.ts";
import type { Decider } from "./model.ts";
import { PatternEngine, type PatternAction, type Step } from "./pattern.ts";
import { fmtUsd, intentCheck } from "./pay/intent.ts";
import { parseChallenge, pay, type Paid } from "./pay/x402.ts";
import { contentSig, findEl, StateStore, stateKey } from "./state.ts";
import { deriveProvenance } from "./memory/provenance.ts";
import { toPast } from "./predict/decider.ts";
import { allowedNearPayment, isPaymentScreen } from "./payguard.ts";
import type { RuleBook, RuleChecker, RuleMatch } from "./rules.ts";

const DEBOUNCE_MS = 40; // fast tiers take ~1 ms: predict as soon as a screen settles
const IDLE_MS = 600; // model ghosts wait for this much quiet
const SHOW_AT = 0.6;
const GOAL_SHOW_AT = 0.4; // working toward a rule's goal: the model's step is offered at lower confidence
const GOAL_MS = 3 * 60_000; // a goal lapses after this long without an accepted step
const EXEC_TIMEOUT_MS = 8000; // a step may wait up to 3 s for its target, then type
const STATE_WAIT_MS = 1000;
const ECHO_MS = 400; // input caused by our own steps, still arriving after a sequence

type Shown = { ghost: Ghost; action?: Action; paymentId?: string };

/** A payment request, checked against the screen. */
interface Payment {
    paymentId: string;
    request: { url: string; method: string; headers: Record<string, string>; body?: string };
    domain: string;
    payTo: string;
    amountUsd: string;
    verdict: { ok: boolean; reason?: string };
    anchorRect?: Rect;
}

export interface BrainOpts {
    sendShell(m: HubToShell): void;
    sendDetector?(m: HubToDetector): void;
    decider: Decider | null;
    /** Search Memory in the menu bar: past tasks by meaning (memory/episodes.ts). */
    searchMemory?(query: string): Promise<MemoryHit[]>;
    /** The user's rules (menu bar dropdown) and what checks them against what just happened (src/rules.ts). */
    rules?: { book: RuleBook; checker: RuleChecker };
    /** Tests: predict right away instead of debouncing and waiting for idle. */
    immediate?: boolean;
    /** Name icon-only controls from their pixels (the local vision model); omit to leave them unnamed. */
    nameIcons?(items: { hash: string; png: string }[]): Promise<{ hash: string; label: string }[]>;
    /** Action memory (~/.tab/memory.db in the hub); omit in tests that don't need it. */
    memory?: Memory | null;
    /** Pay a held request (x402); tests replace it. */
    pay?(url: string, init: RequestInit): Promise<Paid>;
    /** Keep a record of each payment (the hub writes ~/.tab/payments.jsonl). */
    recordPayment?(p: { domain: string; payTo: string; amountUsd: string; url: string; txHash?: string; ok: boolean; error?: string }): void;
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
    private activeKey = "";
    private activeSince = 0;
    private timer: NodeJS.Timeout | null = null;
    private payment: Payment | null = null;
    private paying: string | null = null; // paymentId accepted and settling
    private running: { stop: boolean } | null = null;
    private echoUntil = 0;
    private execWaiters = new Map<string, (r: { ok: boolean; error?: string }) => void>();
    private stateWaiters: { app: string; resolve: () => void }[] = [];
    private modelCache: { key: string; action: Action | null } | null = null;
    private modelAbort: AbortController | null = null;
    private paused = false;
    /** A rule being carried out: the model's ghosts work toward `task` until it lapses or the user stops it. */
    private goal: { task: string; ruleId: string; until: number } | null = null;
    private ruleCheckDue = false; // the user finished something: check the rules once they pause
    private ruleBefore: ScreenState | undefined; // the screen at that finishing step, to see what it changed
    private inputScreen: ScreenState | undefined; // the screen when the last key or click happened, before it had any effect

    constructor(private o: BrainOpts) {
        this.pattern = new PatternEngine(o.memory ?? null);
        this.syncRules();
    }

    private syncRules(): void {
        const list = this.o.rules?.book.list();
        if (list) this.hud.rules = list.map(({ id, text, enabled }) => ({ id, text, enabled }));
    }

    private setGoal(g: Brain["goal"]): void {
        this.goal = g;
        if (g) this.hud.goal = g.task;
        else delete this.hud.goal;
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
                this.onUserEvent(m);
                break;
            case "paused":
                this.paused = !!m.paused;
                if (this.paused) this.hide();
                break;
            case "forget": {
                const since = Date.now() - Number(m.sinceMs ?? 3_600_000);
                this.remember(() => {
                    const n = this.o.memory?.forget({ since }) ?? 0;
                    this.history.entries = this.history.entries.filter((e) => e.ts < since);
                    this.o.decider?.rebuild?.(this.o.memory ?? null);
                    this.pattern.reload();
                    console.log(`[memory] forgot ${n} steps since ${new Date(since).toLocaleTimeString()}`);
                });
                this.hide();
                break;
            }
            case "memory_search": {
                const query = String(m.query ?? "").slice(0, 200);
                const reply = (results: MemoryHit[]) => this.o.sendShell({ type: "memory_results", query, results });
                if (!this.o.searchMemory) reply([]);
                else this.o.searchMemory(query).then(reply, (err) => (console.error("[memory] search:", (err as Error).message), reply([])));
                break;
            }
            case "rule_add":
                if (this.o.rules?.book.add(String(m.text ?? ""))) this.syncRules();
                this.sendHud();
                break;
            case "rule_remove":
                if (this.o.rules?.book.remove(String(m.id))) this.syncRules();
                this.sendHud();
                break;
            case "rule_toggle":
                if (this.o.rules?.book.setEnabled(String(m.id), !!m.enabled)) this.syncRules();
                this.sendHud();
                break;
            case "goal_clear":
                this.setGoal(null);
                this.hide();
                break;
            case "icon_request":
                if (this.o.nameIcons && Array.isArray(m.items) && m.items.length)
                    this.o.nameIcons(m.items).then(
                        (items) => this.o.sendShell({ type: "icon_labels", items }),
                        (err) => console.error("[icons]", (err as Error).message),
                    );
                break;
            case "input":
                this.inputScreen = this.store.active();
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
        }
    }

    /** A payment detector: it holds a request that got an HTTP 402 and asks Tab what to do. */
    fromDetector(m: any): void {
        switch (m.type) {
            case "payment_required":
                this.onPaymentRequired(m);
                break;
            case "payment_cancelled":
                this.onPaymentCancelled(m.paymentId);
                break;
        }
    }

    // ---------- state & input ----------

    private onState(s: ScreenState): void {
        this.store.put(s);
        this.remember(() => this.o.memory?.putState(s));
        try {
            this.o.decider?.see?.(s);
        } catch {}
        this.stateWaiters = this.stateWaiters.filter((w) => (w.app === s.app ? (w.resolve(), false) : true));
        if (this.running) return;
        const active = this.store.active();
        if (!active || stateKey(active) !== stateKey(s)) return;
        if (stateKey(active) !== this.activeKey) {
            this.activeKey = stateKey(active);
            this.activeSince = Date.now();
        }
        const sig = contentSig(active);
        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.schedule(DEBOUNCE_MS);
        } else {
            this.refreshGhostRect();
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
        if (this.running || Date.now() < this.echoUntil) return; // our own steps, reported back
        const prov = e.kind === "type" && e.value && !e.partial && !e.target?.secure
            ? deriveProvenance(e.value, e.target, e.ts, this.store.recent(e.ts), this.history.entries.map(toPast), this.o.decider?.facts)
            : undefined;
        this.remember(() =>
            this.o.memory?.addStep({ ts: e.ts, app: e.app, window: e.window, url: e.url, op: e.kind, by: "user", target: e.target, value: e.value, before: e.before, partial: e.partial, prov }),
        );
        this.pushHistory({
            prov,
            op: e.kind,
            app: e.app,
            url: e.url,
            window: e.window ?? this.store.latest(e.app)?.window,
            target: e.target ? toTarget(e.target) : undefined,
            value: e.value,
            ts: e.ts,
            by: "user",
        });
        this.dismissedKey = null; // the user did something: everything may be offered again
        const finishing = (e.kind === "click" && e.target?.role === "button") || (e.kind === "key" && (e.value === "Return" || e.value === "Enter"));
        if (finishing) {
            this.ruleCheckDue = true;
            this.ruleBefore = this.inputScreen ?? this.store.active();
        }
        this.onUserInput(finishing, true);
    }

    /**
     * Any real input hides the ghost; predict again after quiet. A finishing step may complete a pattern unit: check now.
     * Ignoring is sticky: a ghost hidden by other input isn't offered again until the user acts (onUserEvent).
     */
    private onUserInput(finishing = false, acted = false): void {
        if (this.running) return;
        // Typing on past a completion isn't ignoring it: the next letters just update it.
        if (!acted && this.shown?.action && !this.shown.ghost.caret) this.dismissedKey = actionKey(this.shown.action);
        if (this.shown?.action) this.remember(() => this.o.memory?.ghostOutcome(this.shown!.ghost.id, "ignored"));
        this.hide();
        this.modelAbort?.abort(); // the screen is changing: a model answer for the old one is worthless
        this.lastInputTs = Date.now();
        this.gen++;
        this.schedule(finishing ? DEBOUNCE_MS : IDLE_MS);
    }

    // ---------- predict ----------

    private schedule(ms: number): void {
        if (this.o.immediate) return; // tests call predictNow()
        if (this.timer) clearTimeout(this.timer);
        const gen = ++this.gen;
        this.timer = setTimeout(() => void this.predict(gen), ms);
    }

    async predictNow(): Promise<void> {
        await this.predict(++this.gen);
    }

    private async predict(gen: number): Promise<void> {
        if (this.running || this.paused) return;
        if (this.payment) return this.paying === this.payment.paymentId ? undefined : this.showPayment(this.payment);
        const active = this.store.active();
        if (!active) return;
        // Another app's window covers this one (a Screen Time block): what's behind it can't be clicked, so offer nothing.
        if (active.covered) return this.hide();
        const now = Date.now();
        if (this.goal && now > this.goal.until) this.setGoal(null);

        // 1. A chore taught once, repeated for the next row; or one learned earlier, for a whole list.
        // (Not while working toward a rule's goal: then every ghost is the model's step toward it.)
        const t0 = performance.now();
        const pa = this.goal
            ? null
            : (this.pattern.predict(this.history.entries, this.store.recent(now), now) ??
              this.pattern.recall(active, this.store.recent(now), now, this.history.entries, this.activeSince));
        const pMs = performance.now() - t0;
        if (pa && this.maybeShow(pa, gen, pMs)) return this.logPred("pattern", pMs, pa);

        // 2. The decider: its fast tiers (~1 ms) may show a confident ghost right away; the local model runs only after
        // the user has paused, and is aborted as soon as anything changes.
        const decider = this.o.decider;
        if (!decider) return;
        if (decider.fast && !this.goal) {
            const t3 = performance.now();
            const fa = decider.fast({ active, others: this.store.recent(now), history: this.history.entries });
            const fMs = performance.now() - t3;
            if (fa && this.maybeShow(fa, gen, fMs)) return this.logPred("pattern", fMs, fa);
        }
        if (!this.o.immediate) {
            const wait = this.lastInputTs + IDLE_MS - Date.now();
            if (wait > 0) {
                this.timer = setTimeout(() => void this.predict(gen), wait);
                return;
            }
        }
        // A screen asking for card details gets no model ghost and no rule (only a checkout click from the fast tiers).
        if (isPaymentScreen(active)) return this.sendHud();
        // 3. The user finished something and paused: does one of their rules apply?
        if (this.ruleCheckDue && (await this.checkRules(active, gen))) return;
        if (gen !== this.gen) return;
        const goal = this.goal?.task;
        const key = `${stateKey(active)}\n${contentSig(active)}\n${this.history.entries.length}:${this.history.entries.at(-1)?.ts ?? 0}\n${goal ?? ""}`;
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
                action = await decider.decide({ active, others: this.store.recent(Date.now()), history: this.history.entries, ...(goal ? { goal } : {}) }, ctl.signal);
            } catch (err) {
                if ((err as Error).name !== "AbortError") console.error(`[model] ${decider.name}:`, (err as Error).message);
                action = null;
            }
            ms = performance.now() - t1;
            this.modelCache = { key, action };
            this.hud.mode = this.shown ? "shown" : "idle";
        }
        const shown = gen === this.gen && !!action && this.maybeShow(action, gen, ms);
        this.logPred("model", ms, action);
        if (!shown) this.sendHud();
    }

    /** Check the enabled rules against what just happened; offer the best match as a ghost. True if one is up. */
    private async checkRules(active: ScreenState, gen: number): Promise<boolean> {
        this.ruleCheckDue = false;
        const r = this.o.rules;
        const rules = r?.book.enabled() ?? [];
        if (!r || !rules.length || this.goal) return false;
        let match: RuleMatch | null = null;
        const t0 = performance.now();
        try {
            this.modelAbort?.abort();
            const ctl = (this.modelAbort = new AbortController());
            match = await r.checker.check(rules, { now: Date.now(), active, before: this.ruleBefore, history: this.history.entries.map(toPast) }, ctl.signal);
        } catch (err) {
            if ((err as Error).name !== "AbortError") console.error("[rules]", (err as Error).message);
            return false;
        }
        if (!match || gen !== this.gen) return false;
        const { parsed } = match;
        const a: Action = {
            op: "goal",
            app: active.app,
            value: match.task,
            label: match.task,
            confidence: Math.max(match.score, SHOW_AT),
            source: "model",
            goal: { ruleId: match.rule.id, task: match.task, ...(parsed.app ? { app: parsed.app } : {}) },
        };
        return this.maybeShow(a, gen, performance.now() - t0);
    }

    private maybeShow(a: Action, gen: number, latencyMs: number): boolean {
        if (gen !== this.gen || this.running) return false;
        if (a.confidence < (this.goal && a.source === "model" ? GOAL_SHOW_AT : SHOW_AT)) return false;
        if (actionKey(a) === this.dismissedKey) return false;
        // Payments are the user's: never a click that spends money, and on a card form nothing but the way to checkout.
        if (!allowedNearPayment(a, this.store.active(), (s) => this.resolve(s as Step))) return false;
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
        const el = this.ghostTarget(a);
        if (!el) {
            // Offers without a target of their own (open a URL, a key, a sequence that starts elsewhere) sit at the
            // insertion point of the focused field, else near the last click, else at the top of the screen.
            if (a.op !== "navigate" && a.op !== "sequence" && a.op !== "key" && a.op !== "goal") return null;
            const focused = active?.elements.find((e) => e.focused);
            if (focused?.caret) return { id, kind: "action", label, pillAt: { x: focused.caret.x, y: focused.caret.y + focused.caret.h + 34 } };
            const near = this.lastClickedRect() ?? (focused && focused.rect.w > 0 ? { ...focused.rect, y: focused.rect.y + focused.rect.h - 60, h: 0 } : undefined);
            return near ? { id, kind: "action", label, pillAt: { x: near.x, y: near.y + near.h + 36 } } : { id, kind: "action", label };
        }
        const empty = !el.value;
        const avoid = nearby(el.rect, active, el.id);
        // Completing what the user is typing: only the rest, drawn after the insertion point.
        if (a.op === "type" && !empty && el.caret && a.value && el.value && a.value.length > el.value.length && a.value.toLowerCase().startsWith(el.value.toLowerCase())) {
            return { id, kind: "text", label: "⇥", rect: el.rect, caret: el.caret, ghostText: a.value.slice(el.value.length) };
        }
        if (a.op === "type" && empty && (el.role === "textfield" || el.role === "textarea")) {
            return { id, kind: "text", label: "⇥", rect: el.rect, ghostText: a.value, ...(avoid.length ? { avoid } : {}) };
        }
        const ghost: Ghost = { id, kind: "action", label, rect: el.rect, cursor: { x: el.rect.x + el.rect.w / 2, y: el.rect.y + el.rect.h / 2 }, ...(avoid.length ? { avoid } : {}) };
        if (this.pillWouldCover(el, active)) ghost.place = "inside";
        return ghost;
    }

    /** A pill below a wide field would sit on whatever comes right under it (the first row of a list). */
    private pillWouldCover(el: El, active: ScreenState | undefined): boolean {
        if (!active || !["textfield", "textarea", "select"].includes(el.role) || el.rect.w < 160) return false;
        const top = el.rect.y + el.rect.h, bottom = top + 44; // pill gap + height, with margin
        return active.elements.some((o) => o.id !== el.id && o.rect.y < bottom && o.rect.y + o.rect.h > top && o.rect.x < el.rect.x + 260 && o.rect.x + o.rect.w > el.rect.x);
    }

    /** The element a ghost highlights: the target, or for a sequence, the first step that's on screen. */
    private ghostTarget(a: Action): El | undefined {
        const steps: Step[] = a.op === "sequence" ? ((a.steps as Step[]) ?? []) : [a];
        const front = this.store.active();
        for (const s of steps) {
            // Only what's on screen now: a step elsewhere would anchor on its last known, stale rect.
            if (!front || s.app !== front.app || (s.window && s.window !== front.window)) continue;
            const el = this.resolve(s);
            if (el) return el;
        }
        return undefined;
    }

    private refreshGhostRect(): void {
        if (!this.shown?.action || !this.shown.ghost.rect) return;
        const el = this.ghostTarget(this.shown.action);
        if (!el) return;
        const r = this.shown.ghost.rect;
        if (r.x === el.rect.x && r.y === el.rect.y && r.w === el.rect.w && r.h === el.rect.h) return;
        this.shown.ghost = { ...this.shown.ghost, rect: el.rect, ...(this.shown.ghost.cursor ? { cursor: { x: el.rect.x + el.rect.w / 2, y: el.rect.y + el.rect.h / 2 } } : {}) };
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
        if (s.ghost.kind === "pay" && s.paymentId && this.payment?.paymentId === s.paymentId) {
            this.hud.accepted++;
            return this.payNow(this.payment);
        }
        if (!s.action) return;
        this.remember(() => this.o.memory?.ghostOutcome(ghostId, "accepted"));
        this.hud.accepted++;
        if (s.action.op === "goal" && s.action.goal) return this.startGoal(ghostId, s.action.goal);
        if (this.goal) this.goal.until = Date.now() + GOAL_MS; // a step toward it: keep going
        const steps: Step[] = s.action.op === "sequence" ? (s.action.steps as Step[]) : [s.action];
        const ok = await this.run(ghostId, steps);
        if (ok && s.action.source === "pattern" && (s.action as PatternAction).sig) this.pattern.onAccepted((s.action as PatternAction).sig);
    }

    /** A rule's ghost was accepted: open the app its goal names, then let the model's ghosts work toward the goal. */
    private async startGoal(ghostId: string, g: NonNullable<Action["goal"]>): Promise<void> {
        this.hide();
        this.setGoal({ task: g.task, ruleId: g.ruleId, until: Date.now() + GOAL_MS });
        if (g.app) {
            const sw: Action = { op: "switch_app", app: `name:${g.app}`, value: `name:${g.app}`, label: "", confidence: 1, source: "model" };
            const r = await this.exec(`${ghostId}:open`, sw);
            if (r.ok) countStep(this.hud, sw);
            else console.log(`[rules] couldn't open ${g.app}: ${r.error}; working toward the goal here`);
        }
        this.onUserInput(false, true);
    }

    private onDismiss(ghostId: string): void {
        const s = this.shown;
        if (this.running) {
            this.running.stop = true; // Esc stops a sequence after the current step
            return;
        }
        if (!s || s.ghost.id !== ghostId) return;
        if (s.paymentId) {
            this.o.sendDetector?.({ type: "payment_declined", paymentId: s.paymentId });
            this.payment = null;
        }
        if (this.goal && s.action?.op !== "goal") this.setGoal(null); // Esc on a step toward a goal stops working on it
        if (s.action) {
            const a = s.action;
            this.dismissedKey = actionKey(a);
            this.remember(() => this.o.memory?.ghostOutcome(ghostId, "dismissed"));
            this.remember(() => this.o.decider?.feedback?.(a, "dismissed", findEl(this.store.forStep(a.app, a.window), a.targetId, a.targetPath)));
        }
        this.hide();
    }

    // ---------- sequence runner ----------

    private resolve(s: Step): El | undefined {
        const st = this.store.forStep(s.app, s.window);
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
        try {
            for (let k = 0; k < steps.length && !run.stop; k++) {
                const step = steps[k];
                if (step.app !== this.store.frontmost?.app && step.op !== "switch_app") {
                    const sw: Action = { op: "switch_app", app: step.app, value: step.app, label: "", confidence: 1, source: step.source };
                    const r = await this.exec(`${ghostId}:${k}a`, sw);
                    if (!r.ok) throw new Error(`switch_app ${step.app}: ${r.error}`);
                    countStep(this.hud, sw);
                    this.store.frontmost = { app: step.app, window: step.window ?? "" };
                }
                const needsTarget = step.op !== "navigate" && step.op !== "switch_app" && (step.op !== "key" || !!step.targetPath);
                let target = needsTarget ? this.resolve(step) : undefined;
                // An app or window that just came forward reports its screen a beat later: wait for it.
                for (let i = 0; !target && needsTarget && i < 6; i++) {
                    await this.waitForState(step.app);
                    target = this.resolve(step);
                }
                if (!target && needsTarget) throw new Error(`step ${k}: target not found (${step.targetPath ?? step.match?.contains ?? step.targetId})`);
                const { match: _m, ...wire } = step;
                const action: Action = { ...wire, targetId: target?.id ?? step.targetId, targetPath: target?.path ?? step.targetPath };
                const waitState = this.waitForState(step.app);
                const r = await this.exec(`${ghostId}:${k}`, action);
                if (!r.ok) throw new Error(`step ${k} ${step.op}: ${r.error}`);
                countStep(this.hud, action, target);
                this.remember(() => this.o.memory?.addStep({ ts: Date.now(), app: action.app, window: step.window, url: step.url, op: action.op, by: "tab", target, value: action.value, ghostId }));
                this.pushHistory({
                    op: action.op,
                    app: action.app,
                    window: step.window ?? this.store.latest(action.app)?.window,
                    url: step.url,
                    target: target ? toTarget(target) : undefined,
                    value: action.value,
                    ts: Date.now(),
                    by: "tab",
                });
                this.sendHud();
                await waitState;
            }
        } catch (err) {
            ok = false;
            console.error(`[seq] ${ghostId}:`, (err as Error).message);
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

    private exec(ghostId: string, action: Action): Promise<{ ok: boolean; error?: string }> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.execWaiters.delete(ghostId);
                resolve({ ok: false, error: "exec timeout" });
            }, EXEC_TIMEOUT_MS);
            this.execWaiters.set(ghostId, (r) => {
                clearTimeout(timer);
                this.execWaiters.delete(ghostId);
                resolve(r);
            });
            this.o.sendShell({ type: "exec", ghostId, action });
        });
    }

    private waitForState(app: string): Promise<void> {
        return new Promise((resolve) => {
            const w = { app, resolve };
            this.stateWaiters.push(w);
            setTimeout(() => {
                this.stateWaiters = this.stateWaiters.filter((x) => x !== w);
                resolve();
            }, STATE_WAIT_MS);
        });
    }

    // ---------- payments ----------

    private onPaymentRequired(m: { paymentId: string; request: Payment["request"]; responseHeaders: Record<string, string>; anchorRect?: Rect }): void {
        let challenge;
        try {
            challenge = parseChallenge(m.responseHeaders);
        } catch {
            challenge = null;
        }
        if (!challenge) return this.o.sendDetector?.({ type: "payment_declined", paymentId: m.paymentId }); // not something Tab can pay
        const anchor = m.anchorRect ?? this.lastClickedRect();
        const verdict = intentCheck(this.store.active(), challenge.amountUsd, anchor);
        let domain = "";
        try {
            domain = new URL(m.request.url).hostname;
        } catch {}
        this.payment = { paymentId: m.paymentId, request: m.request, domain, payTo: challenge.payTo, amountUsd: fmtUsd(challenge.amountUsd), verdict, anchorRect: anchor };
        this.showPayment(this.payment);
    }

    private showPayment(p: Payment): void {
        const id = `g${++this.ghostSeq}`;
        const ghost: Ghost = p.verdict.ok
            ? { id, kind: "pay", label: `Pay $${p.amountUsd} · ${p.domain} ⇥`, rect: p.anchorRect }
            : { id, kind: "blocked", label: `Blocked · ${p.verdict.reason ?? "payment does not match the page"}`, rect: p.anchorRect };
        if (p.anchorRect) {
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

    /** Only ever on a Tab press on a pay ghost. */
    private async payNow(p: Payment): Promise<void> {
        // Settling takes seconds: the shell shows "Paying …"; input meanwhile must not re-offer the payment.
        this.paying = p.paymentId;
        this.shown = null;
        this.hud.mode = "running";
        this.sendHud();
        const headers = Object.fromEntries(Object.entries(p.request.headers).filter(([k]) => !/^(content-length|host|connection)$/i.test(k)));
        const body = p.request.body ? Buffer.from(p.request.body, "base64") : undefined;
        const r = await (this.o.pay ?? pay)(p.request.url, { method: p.request.method, headers, body });
        this.o.recordPayment?.({ domain: p.domain, payTo: p.payTo, amountUsd: p.amountUsd, url: p.request.url, txHash: r.txHash, ok: r.ok, error: r.error });
        this.o.sendDetector?.({ type: "payment_done", paymentId: p.paymentId, ok: r.ok, status: r.status, headers: r.headers, body: r.body, error: r.error });
        if (this.paying !== p.paymentId) return; // cancelled meanwhile
        this.paying = null;
        this.payment = null;
        const id = `g${++this.ghostSeq}`;
        const ghost: Ghost = r.ok
            ? { id, kind: "done", label: `Paid $${p.amountUsd} ✓`, rect: p.anchorRect, ttlMs: 1500 }
            : { id, kind: "blocked", label: `Blocked · ${r.error ?? "payment failed"}`, rect: p.anchorRect };
        if (r.ok && r.txHash && r.explorerUrl) this.hud.lastTx = { hash: r.txHash, explorerUrl: r.explorerUrl, amountUsd: p.amountUsd };
        this.shown = r.ok ? null : { ghost, paymentId: p.paymentId };
        this.o.sendShell({ type: "ghost", ghost });
        this.hud.mode = r.ok ? "idle" : "shown";
        this.sendHud();
    }

    /** The page went away: nothing to pay or block anymore. */
    private onPaymentCancelled(paymentId: string): void {
        if (this.payment?.paymentId !== paymentId) return;
        this.payment = null;
        if (this.paying === paymentId) {
            this.paying = null;
            this.o.sendShell({ type: "ghost_hide" }); // the shell's "Paying …" pill
            this.hud.mode = "idle";
            this.sendHud();
        } else if (this.shown?.paymentId === paymentId) this.hide();
    }

    // ---------- misc ----------

    /** Where the user (or Tab) last clicked, with the element's current rect. */
    private lastClickedRect(): Rect | undefined {
        for (let k = this.history.entries.length - 1; k >= 0; k--) {
            const e = this.history.entries[k];
            if (e.op !== "click" || !e.target) continue;
            return findEl(this.store.forStep(e.app, e.window), e.target.id, e.target.path)?.rect;
        }
        return undefined;
    }

    private sendHud(): void {
        this.o.sendShell({ type: "hud", hud: this.hud });
    }

    private logPred(source: "pattern" | "model", latencyMs: number, action: Action | null): void {
        this.o.onPredict?.({ source, latencyMs, action });
    }
}

/**
 * Rects of the other elements within 120 pt of the target (any role, text included), for `Ghost.avoid`: the shell
 * knows the pill's real size and places it where it covers none of them.
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
