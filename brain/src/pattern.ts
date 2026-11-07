// Teach once, then repeat: "you did this chore for one row of a list; here it is for the next row".
//
// A unit is what the user did in one app since the previous "finishing" step there: a click on a button that isn't
// itself a list item, or Return. Values they typed are traced to a row of a list or table on a recent screen (any
// app: rows and list items are tagged by the shell). The unit becomes a template: typed values become "this field
// of the row", clicks on list items become "the item whose label contains that value". Then it's offered for the
// next row, and after two accepted repeats for all remaining rows. Learned templates are kept in memory.db and
// offered again for a whole list when the user comes back to that window.
//
// Synchronous and model-free; well under 10 ms.
import type { Action, ScreenState } from "../../protocol/types.ts";
import type { HistEntry } from "./history.ts";
import type { Memory } from "./memory/store.ts";
import { CACHE_MS, stateKey } from "./state.ts";

const MIN_UNIT = 2;
const MAX_UNIT = 12;

/** A sequence step plus a hub-only resolution hint (stripped before sending). */
export interface Step extends Action {
    /** Click the list item on screen whose label contains `contains`, resolved when the step runs. */
    match?: { listKey: string; contains: string };
}

export interface PatternAction extends Action {
    steps: Step[];
    sig: string; // unit shape, used to count repeats
}

interface Prov {
    stateKey: string;
    listKey: string;
    index: number;
    field?: string;
    attr: "label" | "value";
}

/** One step of a template: a literal value, a field of the source row, or a click on the matching list item. */
export interface TemplateStep {
    op: Action["op"];
    app: string;
    window?: string;
    targetId?: string;
    targetPath?: string;
    value?: string;
    prov?: { field?: string; attr: "label" | "value" };
    contains?: { listKey: string; field?: string; attr: "label" | "value" };
}

/** A learned chore. */
export interface Workflow {
    sig: string;
    app: string; // where the steps run
    window: string; // the window they run in, when learned
    srcApp: string; // where the source list was
    srcWindow: string;
    listKey: string;
    fields: string[]; // source fields the template reads
    template: TemplateStep[];
    learnedAt: number;
    accepted: number;
}

export function norm(v: string): string {
    const t = v.trim().toLowerCase();
    const m = t.match(/^\$?\s*(\d*\.?\d+)$/);
    return m ? Number(m[1]).toFixed(2) : t;
}

/** A step that finishes a unit: a click on a button outside any list, or Return. */
function isTrigger(e: HistEntry | undefined): boolean {
    if (!e) return false;
    if (e.op === "key") return e.value === "Return" || e.value === "Enter";
    return e.op === "click" && e.target?.role === "button" && !e.target.list;
}

/** The user's steps in the trigger's app since the previous trigger there, through the trigger. */
export function unitOf(h: HistEntry[]): HistEntry[] | null {
    const trig = h.at(-1);
    if (!isTrigger(trig)) return null;
    const unit: HistEntry[] = [trig!];
    for (let k = h.length - 2; k >= 0; k--) {
        const e = h[k];
        if (e.app !== trig!.app) continue;
        if (isTrigger(e)) break;
        if (e.op === "navigate") continue;
        unit.unshift(e);
    }
    const u = unit.slice(-MAX_UNIT);
    return u.length >= MIN_UNIT && u.some((e) => e.op === "type") ? u : null;
}

function provCandidates(v: string, screens: ScreenState[]): Prov[] {
    const n = norm(v);
    if (n.length < 2) return [];
    const out: Prov[] = [];
    for (const s of screens) {
        const seen = new Set<string>();
        for (const el of s.elements) {
            if (!el.list || el.role === "textfield" || el.role === "textarea") continue; // a source is shown, not typed
            const attr = norm(el.label) === n ? "label" : el.value !== undefined && norm(el.value) === n ? "value" : null;
            if (!attr) continue;
            const k = `${el.list.key}#${el.list.index}`;
            if (seen.has(k)) continue; // first matching field per row wins (a cell vs the text in it)
            seen.add(k);
            out.push({ stateKey: stateKey(s), listKey: el.list.key, index: el.list.index, field: el.list.field, attr });
        }
    }
    return out;
}

function listLength(s: ScreenState, listKey: string): number {
    let max = -1;
    for (const e of s.elements) if (e.list?.key === listKey) max = Math.max(max, e.list.index);
    return max + 1;
}

function itemValue(s: ScreenState, listKey: string, field: string | undefined, attr: "label" | "value", index: number): string | undefined {
    const el = s.elements.find((e) => e.list?.key === listKey && e.list.index === index && e.list.field === field);
    const v = el && (attr === "label" ? el.label : el.value);
    return v?.trim() || undefined;
}

/** Steps for row `index` of the source list. */
export function unitFor(wf: Workflow, src: ScreenState, index: number, listKey = wf.listKey): { steps: Step[]; vals: string[] } | null {
    const steps: Step[] = [];
    const vals: string[] = [];
    for (const t of wf.template) {
        const step: Step = { op: t.op, app: t.app, window: t.window, targetId: t.targetId, targetPath: t.targetPath, value: t.value, label: "", confidence: 1, source: "pattern" };
        if (t.prov) {
            const v = itemValue(src, listKey, t.prov.field, t.prov.attr, index);
            if (!v) return null;
            step.value = v;
            if (!vals.includes(v)) vals.push(v);
        }
        if (t.contains) {
            const v = itemValue(src, listKey, t.contains.field, t.contains.attr, index);
            if (!v) return null;
            step.match = { listKey: t.contains.listKey, contains: v };
            delete step.targetId;
            delete step.targetPath;
        }
        steps.push(step);
    }
    return { steps, vals };
}

/** The window's name for a pill: its title's first part, shortened. */
function shortName(s: ScreenState): string {
    const head = (s.window || s.app).split(/ [·—–-] /)[0].trim();
    return head.length > 24 ? head.slice(0, 23) + "…" : head;
}

function clock(ts: number): string {
    const d = new Date(ts);
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export class PatternEngine {
    private seen = new Map<string, Set<number>>(); // sig → trigger timestamps
    private accepted = new Map<string, number>();
    private saved = new Map<string, Workflow>();

    constructor(private memory: Memory | null = null) {
        for (const w of memory?.workflows<Workflow>() ?? []) this.saved.set(w.sig, w);
    }

    private save(w: Workflow): void {
        const old = this.saved.get(w.sig);
        const merged = old ? { ...w, learnedAt: old.learnedAt, accepted: Math.max(old.accepted, w.accepted) } : w;
        this.saved.set(w.sig, merged);
        try {
            this.memory?.saveWorkflow(merged.sig, merged.learnedAt, merged.accepted, merged);
        } catch (err) {
            console.error("[pattern] save:", (err as Error).message);
        }
    }

    onAccepted(sig: string): void {
        this.accepted.set(sig, (this.accepted.get(sig) ?? 0) + 1);
        const w = this.saved.get(sig);
        if (w) this.save({ ...w, accepted: w.accepted + 1 });
    }

    /** Memory was edited underneath (forget): reload what's left. */
    reload(): void {
        this.saved.clear();
        for (const w of this.memory?.workflows<Workflow>() ?? []) this.saved.set(w.sig, w);
    }

    predict(h: HistEntry[], states: ScreenState[], now: number): PatternAction | null {
        const unit = unitOf(h);
        if (!unit) return null;
        const trig = unit.at(-1)!;
        const screens = states.filter((s) => now - s.ts <= CACHE_MS);

        // Provenance: the (screen, list, row) that explains the most typed values.
        const cands = unit.map((e) => (e.op === "type" && e.value ? provCandidates(e.value, screens) : []));
        const votes = new Map<string, number>();
        for (const cs of cands) for (const c of new Set(cs.map((c) => `${c.stateKey}\n${c.listKey}\n${c.index}`))) votes.set(c, (votes.get(c) ?? 0) + 1);
        if (votes.size === 0) return null;
        const best = [...votes].sort((a, b) => b[1] - a[1])[0][0];
        const provs: (Prov | null)[] = cands.map((cs) => cs.find((c) => `${c.stateKey}\n${c.listKey}\n${c.index}` === best) ?? null);
        const p0 = provs.find((p) => p)!;
        const src = screens.find((s) => stateKey(s) === p0.stateKey)!;

        const template: TemplateStep[] = unit.map((e, k) => {
            const t: TemplateStep = { op: e.op, app: e.app, window: e.window, targetId: e.target?.id, targetPath: e.target?.path, value: e.value };
            const p = provs[k];
            if (p) {
                t.prov = { field: p.field, attr: p.attr };
                delete t.value;
            } else if (e.op === "click" && e.target?.list) {
                // A click on a list item whose label mentions a traced value: "the item for this row".
                const label = e.target.label.toLowerCase();
                const j = unit.findIndex((u, i) => provs[i] && label.includes(u.value!.trim().toLowerCase()));
                if (j >= 0) t.contains = { listKey: e.target.list.key, field: provs[j]!.field, attr: provs[j]!.attr };
            }
            return t;
        });

        const sig = `${trig.app}|` + template.map((t) => [t.op, t.contains ? `list:${t.contains.listKey}` : t.targetPath ?? "", t.prov ? `prov:${t.prov.field}` : t.value ?? ""].join(",")).join(";");
        const wf: Workflow = {
            sig,
            app: trig.app,
            window: trig.window ?? "",
            srcApp: src.app,
            srcWindow: src.window,
            listKey: p0.listKey,
            fields: [...new Set(template.flatMap((t) => [t.prov, t.contains].filter(Boolean).map((x) => x!.field ?? "")))],
            template,
            learnedAt: now,
            accepted: this.accepted.get(sig) ?? 0,
        };

        const seenSet = this.seen.get(sig) ?? new Set();
        seenSet.add(trig.ts);
        this.seen.set(sig, seenSet);
        const confidence = seenSet.size >= 2 ? 0.97 : 0.85;

        const next = p0.index + 1;
        const first = unitFor(wf, src, next);
        if (!first) return null;
        if (unitFor(wf, src, p0.index)) this.save(wf); // the unit reproduces the row it was learned on: worth keeping

        const base = { op: "sequence" as const, app: trig.app, window: trig.window, confidence, source: "pattern" as const, sig };
        if ((this.accepted.get(sig) ?? 0) >= 2) {
            const steps: Step[] = [];
            let n = 0;
            for (let i = next; i < listLength(src, p0.listKey); i++) {
                const u = unitFor(wf, src, i);
                if (!u) break;
                steps.push(...u.steps);
                n++;
            }
            return { ...base, steps, label: `Do the remaining ${n}` };
        }
        return { ...base, steps: first.steps, label: `Repeat for ${first.vals.join(" · ")}` };
    }

    /**
     * Back in a window where a chore was learned, before doing anything there: offer it for every row of a list of the
     * same shape on a recent screen. Rows already done are redone; the steps are idempotent.
     */
    recall(active: ScreenState, states: ScreenState[], now: number, h: HistEntry[], activeSince: number): PatternAction | null {
        const wfs = [...this.saved.values()].filter((w) => w.app === active.app && w.window === active.window);
        if (!wfs.length) return null;
        if (h.some((e) => e.app === active.app && e.ts >= activeSince)) return null; // the user already started here
        const others = states.filter((s) => now - s.ts <= CACHE_MS);
        for (const wf of wfs.sort((a, b) => b.learnedAt - a.learnedAt)) {
            for (const s of others) {
                let key: string | undefined;
                if (s.app === wf.srcApp && s.elements.some((e) => e.list?.key === wf.listKey)) key = wf.listKey;
                else {
                    // Any list whose items have all the fields the chore reads.
                    const byKey = new Map<string, Set<string>>();
                    for (const e of s.elements) if (e.list) byKey.set(e.list.key, (byKey.get(e.list.key) ?? new Set()).add(e.list.field ?? ""));
                    key = [...byKey].find(([, f]) => wf.fields.every((x) => f.has(x)))?.[0];
                }
                if (!key) continue;
                const steps: Step[] = [];
                let n = 0;
                for (let i = 0; i < listLength(s, key); i++) {
                    const u = unitFor(wf, s, i, key);
                    if (!u) break;
                    steps.push(...u.steps);
                    n++;
                }
                if (!n) continue;
                return {
                    op: "sequence",
                    app: wf.app,
                    window: wf.window,
                    steps,
                    label: `Do all ${n} from ${shortName(s)} · learned ${clock(wf.learnedAt)}`,
                    confidence: 0.9,
                    source: "pattern",
                    sig: wf.sig,
                };
            }
        }
        return null;
    }
}
