// Similar moments across apps: "after doing something like this elsewhere, you did that".
//
// A moment is a pair of consecutive user steps in one app: the situation (what was just done: op, role, label) and
// what came next (op, role, label, key). The habit graph already covers the same app; this tier recalls moments from
// other apps. After clicking Send in Outlook, the user who archives after sending in Mail gets Archive offered,
// provided an element that means Archive is on the screen now.
//
// Situations and labels are compared by embedding when both are cached (EmbeddingGemma, embedded in prepare() when a
// screen arrives), else by normalised text. Recall needs the same next step in at least two moments, so one
// coincidence elsewhere never becomes a ghost. Scores stay below the habit graph's: a habit in this app wins.
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import type { Candidate, PastStep, PredictContext, Predictor } from "../predict/types.ts";
import { cosine, type Embedder } from "./embed.ts";
import { norm } from "./sig.ts";

const PROMPT = "task: sentence similarity | query: ";
const MAX_GAP_MS = 5 * 60_000;
const MAX_MOMENTS = 5000;
const SIT_SIM = 0.85; // situations: "click Send" ≈ "click Send message"
const LABEL_SIM = 0.88; // the next step's element on this screen
const MIN_COUNT = 2;
const CLICKABLE = new Set<El["role"]>(["button", "link", "menuitem", "tab", "checkbox", "select", "cell", "row"]);

interface Step {
    app: string;
    op: Action["op"];
    role?: El["role"];
    label: string;
    key?: string;
    ts: number;
}

interface Moment {
    app: string;
    sit: string; // situation text
    next: { op: Action["op"]; role?: El["role"]; label: string; key?: string };
    n: number;
    ts: number;
}

/** A step as text, the same in every app: "click button Send", "press cmd+enter". */
export function stepText(s: Pick<Step, "op" | "role" | "label" | "key">): string {
    return s.op === "key" ? `press ${s.key ?? ""}` : `${s.op} ${s.role ?? ""} ${s.label}`.replace(/\s+/g, " ").trim();
}

function toStep(p: PastStep): Step | null {
    if (p.by !== "user" || (p.op !== "click" && p.op !== "key")) return null;
    const label = (p.target?.label || p.target?.placeholder || "").trim();
    if (p.op === "click" && !label) return null; // an unnamed control means nothing in another app
    return { app: p.app, op: p.op, role: p.target?.role, label, key: p.op === "key" ? p.value : undefined, ts: p.ts };
}

export class SimilarMoments implements Predictor {
    readonly tier = "similar" as const;
    private moments = new Map<string, Moment>(); // app § situation § next → moment
    private last: Step | null = null;

    constructor(private embedder: Embedder | null = null) {}

    get size(): number {
        return this.moments.size;
    }

    observe(p: PastStep): void {
        const s = toStep(p);
        if (!s) {
            if (p.by === "user" && p.op !== "type") this.last = null; // a step this tier can't use breaks the chain
            return;
        }
        const prev = this.last;
        this.last = s;
        if (!prev || prev.app !== s.app || s.ts - prev.ts > MAX_GAP_MS) return;
        const sit = stepText(prev);
        const next = { op: s.op, role: s.role, label: s.label, key: s.key };
        const k = [s.app, norm(sit, false), norm(stepText(next), false)].join("§");
        const m = this.moments.get(k);
        if (m) {
            m.n++;
            m.ts = s.ts;
        } else {
            this.moments.set(k, { app: s.app, sit, next, n: 1, ts: s.ts });
            if (this.moments.size > MAX_MOMENTS) {
                const oldest = [...this.moments.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, MAX_MOMENTS / 10);
                for (const [key] of oldest) this.moments.delete(key);
            }
        }
    }

    /** Embed what predict() will compare on this screen (the current situation, labels on screen, situations seen). */
    async prepare(screen: ScreenState | null, signal?: AbortSignal): Promise<void> {
        if (!this.embedder?.available) return;
        const texts = new Set<string>();
        for (const m of this.moments.values()) {
            texts.add(PROMPT + m.sit);
            if (m.next.label) texts.add(PROMPT + m.next.label);
        }
        if (this.last) texts.add(PROMPT + stepText(this.last));
        for (const e of screen?.elements ?? []) if (CLICKABLE.has(e.role) && e.label) texts.add(PROMPT + e.label.slice(0, 80));
        const missing = [...texts].filter((t) => !this.embedder!.cached(t)).slice(0, 256);
        if (missing.length) await this.embedder.embed(missing, signal);
    }

    private sim(a: string, b: string): number {
        if (norm(a, false) === norm(b, false)) return 1;
        const va = this.embedder?.cached(PROMPT + a.slice(0, 80)), vb = this.embedder?.cached(PROMPT + b.slice(0, 80));
        return va && vb ? cosine(va, vb) : 0;
    }

    predict(ctx: PredictContext): Candidate[] {
        const a = ctx.active;
        const cur = this.last;
        if (!cur || cur.app !== a.app || ctx.now - cur.ts > MAX_GAP_MS) return [];
        const sit = stepText(cur);
        // Moments elsewhere that started like this one, grouped by what came next.
        const votes = new Map<string, { next: Moment["next"]; n: number; sim: number; apps: Set<string> }>();
        for (const m of this.moments.values()) {
            if (m.app === a.app) continue;
            const s = this.sim(sit, m.sit);
            if (s < SIT_SIM) continue;
            const k = norm(stepText(m.next), false);
            const v = votes.get(k) ?? { next: m.next, n: 0, sim: 0, apps: new Set() };
            v.n += m.n;
            v.sim = Math.max(v.sim, s);
            v.apps.add(m.app);
            votes.set(k, v);
        }
        const total = [...votes.values()].reduce((x, v) => x + v.n, 0);
        const out: Candidate[] = [];
        for (const v of votes.values()) {
            if (v.n < MIN_COUNT) continue;
            const c = this.concretize(v.next, a);
            if (!c) continue;
            // Share of what came next, shrunk when evidence is thin, scaled by how alike the moments are; capped so a
            // habit in this app outranks it.
            const p = Math.min(0.6, (v.n / total) * (v.n / (v.n + 2)) * v.sim * c.sim);
            out.push({ action: c.action, score: p, tier: "similar", why: `like after ${sit} in ${[...v.apps][0]} (${v.n}×)` });
        }
        return out.sort((x, y) => y.score - x.score).slice(0, 3);
    }

    private concretize(next: Moment["next"], a: ScreenState): { action: Action; sim: number } | null {
        if (next.op === "key") {
            return { action: { op: "key", app: a.app, url: a.url, value: next.key, label: `Press ${next.key}`, confidence: 0, source: "pattern" }, sim: 1 };
        }
        let best: { el: El; sim: number } | null = null;
        for (const e of a.elements) {
            if (!e.enabled || !e.label || !CLICKABLE.has(e.role)) continue;
            const s = this.sim(next.label, e.label);
            if (s >= LABEL_SIM && (!best || s > best.sim || (s === best.sim && e.role === next.role))) best = { el: e, sim: s };
        }
        if (!best) return null;
        const el = best.el;
        return { action: { op: "click", app: a.app, url: a.url, targetId: el.id, targetPath: el.path, label: `Click ${el.label}`, confidence: 0, source: "pattern" }, sim: best.sim };
    }
}
