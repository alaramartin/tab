// The hub's decider: the prediction ladder behind the Brain's Decider interface.
//   fast()    sequences, habits, field facts, similar moments (memory) → combiner. ~1 ms, synchronous: the Brain shows it right away when it's confident.
//   decide()  habits + the local LLM (reranks and fills values) → combiner. ~0.4 s; the Brain calls it after the
//             user has paused, and aborts it when anything changes.
// Habits are warm-started from memory.db and learn every step as it happens (observe).
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import type { HistEntry } from "../history.ts";
import { HabitModel } from "../memory/habits.ts";
import { Embedder } from "../memory/embed.ts";
import { FactIndex, valueFits } from "../memory/facts.ts";
import { SimilarMoments } from "../memory/similar.ts";
import type { Memory } from "../memory/store.ts";
import type { Decider, ModelInput } from "../model.ts";
import { CHAT_PORT, LlamaServer, MODELS } from "../runtime/llama.ts";
import { Ladder } from "./ladder.ts";
import { LocalModelTier } from "./local.ts";
import { SequenceTier } from "./sequence.ts";
import type { Candidate, PastStep, PredictContext } from "./types.ts";

export function toPast(h: HistEntry): PastStep {
    const t = h.target;
    const target: El | undefined = t
        ? { id: t.id, path: t.path, role: t.role, label: t.label, list: t.list, section: t.section, axId: t.axId, grid: t.grid, placeholder: t.placeholder, rect: { x: 0, y: 0, w: 0, h: 0 }, enabled: true }
        : undefined;
    return { ts: h.ts, app: h.app, url: h.url, window: h.window, op: h.op, by: h.by, target, value: h.value, prov: h.prov };
}

/** Drop typing a value into a field it can't belong in: an email into "Number", a URL into "Phone". */
export function fitting(cands: Candidate[], ctx: PredictContext): Candidate[] {
    return cands.filter((c) => {
        const a = c.action;
        if (a.op !== "type" || !a.value) return true;
        const el = ctx.active.elements.find((e) => e.id === a.targetId || (a.targetPath && e.path === a.targetPath));
        return !el || valueFits(el, a.value);
    });
}

export class LocalDecider implements Decider {
    readonly name: string;
    habits = new HabitModel();
    readonly ladder = new Ladder();
    facts: FactIndex;
    similar: SimilarMoments;
    private embedder: Embedder | null;
    readonly sequence = new SequenceTier();
    private preparing: AbortController | null = null;
    readonly server: LlamaServer | null;
    private model: LocalModelTier | null;
    lastStats: { fastMs: number; modelMs?: number; promptTokens?: number; cachedTokens?: number } | null = null;

    constructor(opts: { memory?: Memory | null; model?: "qwen" | null; embed?: boolean } = {}) {
        // TAB_LLM=off runs the fast tiers only (tests, or a Mac without the model).
        const useLlm = opts.model === undefined ? process.env.TAB_LLM !== "off" : opts.model !== null;
        const spec = useLlm ? MODELS.qwen : undefined;
        this.server = spec ? new LlamaServer(spec, CHAT_PORT) : null;
        if (this.server && !this.server.available()) {
            console.warn(`[decider] ${this.server.path} missing: habits only (download it to ~/.tab/models)`);
            this.server = null as any;
        }
        const memory = opts.memory ?? null;
        // Long-range context for the model: what the user finished in this app lately (episode summaries, ≤ 2, last 24 h).
        const earlier = (ctx: PredictContext) =>
            memory?.episodes(20).filter((e) => e.app === ctx.active.app && ctx.now - e.end_ts < 86_400_000).slice(0, 2).map((e) => e.summary) ?? [];
        this.model = this.server ? new LocalModelTier(this.server, { earlier }) : null;
        const embedder = opts.embed === false ? null : new Embedder(opts.memory?.db ?? null);
        this.embedder = embedder?.available ? embedder : null;
        this.facts = new FactIndex(this.embedder);
        this.similar = new SimilarMoments(this.embedder);
        this.name = `local:habits${this.server ? `+${this.server.spec.name}` : ""}${this.ladder.fitted ? " (fitted ladder)" : ""}`;
        this.rebuild(opts.memory ?? null);
    }

    /** Learn everything memory has seen, in order (at start, and after a forget). */
    rebuild(memory: Memory | null): void {
        this.facts = new FactIndex(this.embedder);
        this.habits = new HabitModel(this.facts);
        this.similar = new SimilarMoments(this.embedder);
        const opts = { memory };
        if (opts.memory) {
            const t0 = performance.now();
            const steps = opts.memory.steps();
            for (const r of steps) {
                const s: PastStep = { ts: r.ts, app: r.app, window: r.window ?? undefined, url: r.url ?? undefined, op: r.op as Action["op"], by: r.by, target: r.target ?? undefined, value: r.value ?? undefined, prov: r.prov ?? undefined };
                this.habits.observe(s);
                this.facts.observe(s);
                this.similar.observe(s);
            }
            console.log(`[decider] ${this.facts.size} field facts, ${this.similar.size} moments; habits warm-started from ${steps.length} steps in ${(performance.now() - t0).toFixed(0)} ms`);
        }
    }

    /** Load the models now (and embed the facts), so the first prediction doesn't pay for it. */
    async warm(): Promise<void> {
        await Promise.all([this.server?.start().then(() => this.model?.warm()), this.facts.prepare(null), this.similar.prepare(null)]);
    }

    observe(h: HistEntry): void {
        const s = toPast(h);
        this.habits.observe(s);
        this.facts.observe(s);
        this.similar.observe(s);
    }

    feedback(a: Action, outcome: "accepted" | "dismissed", target?: El): void {
        if (outcome === "dismissed" && a.op === "type" && a.value && target) this.facts.reject(target.label || target.placeholder || "", a.value);
    }

    see(screen: ScreenState): void {
        this.preparing?.abort();
        const ctl = (this.preparing = new AbortController());
        this.facts.prepare(screen, ctl.signal).catch(() => {});
        this.similar.prepare(screen, ctl.signal).catch(() => {});
    }

    private ctx(m: ModelInput): PredictContext {
        return { now: Date.now(), active: m.active, recent: m.others.filter((s) => s !== m.active), history: m.history.slice(-50).map(toPast), ...(m.goal ? { goal: m.goal } : {}) };
    }

    private best(cands: Candidate[], ctx?: PredictContext): Action | null {
        const top = this.ladder.merge(ctx ? fitting(cands, ctx) : cands)[0];
        if (!top) return null;
        const source: Action["source"] = top.tiers.includes("model") ? "model" : "pattern";
        return { ...top.action, confidence: top.score, source };
    }

    /** Sequences, habits, field facts and similar moments elsewhere: all synchronous, all ~1 ms. */
    private fastCands(ctx: PredictContext): Candidate[] {
        return [...this.sequence.predict(ctx), ...this.habits.predict(ctx), ...this.facts.predict(ctx), ...this.similar.predict(ctx)];
    }

    fast(m: ModelInput): Action | null {
        const t0 = performance.now();
        const ctx = this.ctx(m);
        const a = this.best(this.fastCands(ctx), ctx);
        this.lastStats = { fastMs: performance.now() - t0 };
        return a;
    }

    async decide(m: ModelInput, signal?: AbortSignal): Promise<Action | null> {
        const ctx = this.ctx(m);
        const t0 = performance.now();
        const upstream = this.fastCands(ctx).sort((a, b) => b.score - a.score);
        const fastMs = performance.now() - t0;
        if (!this.model) return this.best(upstream, ctx);
        const t1 = performance.now();
        const modelCands = await this.model.predict(ctx, upstream.slice(0, 4), signal);
        const st = this.model.lastStats;
        this.lastStats = { fastMs, modelMs: performance.now() - t1, promptTokens: st?.promptTokens, cachedTokens: st?.cachedTokens };
        // Working toward a rule's goal: the model's pick is the step, scored by the model alone (habits know nothing of the
        // goal). When it says none or isn't sure, an empty field on screen that field facts can fill is still a step: a
        // goal like "copy my details into the Sign up form" isn't done while one is left.
        if (ctx.goal) {
            const top = fitting([...modelCands].sort((a, b) => b.score - a.score), ctx)[0];
            if (top && top.score >= 0.4) return { ...top.action, confidence: top.score, source: "model" };
            const fill = fitting(upstream.filter((c) => c.tier === "fact" && c.action.op === "type"), ctx).sort((a, b) => b.score - a.score)[0];
            if (fill) return { ...fill.action, confidence: Math.max(fill.score, 0.5), source: "pattern" };
            return top ? { ...top.action, confidence: top.score, source: "model" } : null;
        }
        return this.best([...upstream, ...modelCands], ctx);
    }
}
