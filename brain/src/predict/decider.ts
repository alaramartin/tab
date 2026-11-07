// The hub's decider (EXTENDED_PLAN.md §4): the prediction ladder behind the Brain's Decider interface.
//   fast()    habits (memory) → combiner. ~1 ms, synchronous: the Brain shows it right away when it's confident.
//   decide()  habits + the local LLM (reranks and fills values) → combiner. ~0.4 s; the Brain calls it after the
//             user has paused, and aborts it when anything changes.
// Habits are warm-started from memory.db and learn every step as it happens (observe).
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import type { HistEntry } from "../history.ts";
import { HabitModel } from "../memory/habits.ts";
import { Embedder } from "../memory/embed.ts";
import { FactIndex } from "../memory/facts.ts";
import { SituationIndex } from "../memory/situations.ts";
import type { Memory } from "../memory/store.ts";
import type { Decider, ModelInput } from "../model.ts";
import { CHAT_PORT, LlamaServer, MODELS } from "../runtime/llama.ts";
import { Ladder } from "./ladder.ts";
import { LocalModelTier } from "./local.ts";
import { SequenceTier } from "./sequence.ts";
import { CloudWriter } from "../runtime/cloud.ts";
import type { Candidate, PastStep, PredictContext } from "./types.ts";

export function toPast(h: HistEntry): PastStep {
    const t = h.target;
    const target: El | undefined = t
        ? { id: t.id, path: t.path, role: t.role, label: t.label, list: t.list, section: t.section, axId: t.axId, grid: t.grid, placeholder: t.placeholder, rect: { x: 0, y: 0, w: 0, h: 0 }, enabled: true }
        : undefined;
    return { ts: h.ts, app: h.app, url: h.url, window: h.window, op: h.op, by: h.by, target, value: h.value };
}

export class LocalDecider implements Decider {
    readonly name: string;
    habits = new HabitModel();
    situations = new SituationIndex();
    readonly ladder = new Ladder();
    facts: FactIndex;
    private embedder: Embedder | null;
    readonly sequence = new SequenceTier();
    private preparing: AbortController | null = null;
    readonly server: LlamaServer | null;
    private model: LocalModelTier | null;
    lastStats: { fastMs: number; modelMs?: number; promptTokens?: number; cachedTokens?: number } | null = null;

    constructor(opts: { memory?: Memory | null; model?: string | null; embed?: boolean } = {}) {
        const spec = MODELS[opts.model === undefined ? (process.env.TAB_MODEL ?? "qwen") : (opts.model ?? "")];
        this.server = spec ? new LlamaServer(spec, CHAT_PORT) : null;
        if (this.server && !this.server.available()) {
            console.warn(`[decider] ${this.server.path} missing: habits only (download it to ~/.tab/models)`);
            this.server = null as any;
        }
        const cloud = new CloudWriter();
        if (cloud.enabled) console.log(`[decider] long text is written by ${cloud.model} (TAB_CLOUD=1)`);
        this.model = this.server ? new LocalModelTier(this.server, { cloud }) : null;
        const embedder = opts.embed === false ? null : new Embedder(opts.memory?.db ?? null);
        this.embedder = embedder?.available ? embedder : null;
        this.facts = new FactIndex(this.embedder);
        this.name = `local:habits${this.server ? `+${this.server.spec.name}` : ""}${this.ladder.fitted ? " (fitted ladder)" : ""}`;
        this.rebuild(opts.memory ?? null);
    }

    /** Learn everything memory has seen, in order (at start, and after a forget). */
    rebuild(memory: Memory | null): void {
        this.habits = new HabitModel();
        this.situations = new SituationIndex();
        this.facts = new FactIndex(this.embedder);
        const opts = { memory };
        if (opts.memory) {
            const t0 = performance.now();
            const steps = opts.memory.steps();
            for (const r of steps) {
                const s: PastStep = { ts: r.ts, app: r.app, window: r.window ?? undefined, url: r.url ?? undefined, op: r.op as Action["op"], by: r.by, target: r.target ?? undefined, value: r.value ?? undefined };
                this.habits.observe(s);
                this.situations.observe(s);
                this.facts.observe(s);
            }
            console.log(`[decider] ${this.facts.size} field facts; habits warm-started from ${steps.length} steps in ${(performance.now() - t0).toFixed(0)} ms`);
        }
    }

    /** Load the models now (and embed the facts), so the first prediction doesn't pay for it. */
    async warm(): Promise<void> {
        await Promise.all([this.server?.start().then(() => this.model?.warm()), this.facts.prepare(null)]);
    }

    observe(h: HistEntry): void {
        const s = toPast(h);
        this.habits.observe(s);
        this.situations.observe(s);
        this.facts.observe(s);
    }

    feedback(a: Action, outcome: "accepted" | "dismissed", target?: El): void {
        if (outcome === "dismissed" && a.op === "type" && a.value && target) this.facts.reject(target.label || target.placeholder || "", a.value);
    }

    see(screen: ScreenState): void {
        this.preparing?.abort();
        const ctl = (this.preparing = new AbortController());
        this.facts.prepare(screen, ctl.signal).catch(() => {});
    }

    private ctx(m: ModelInput): PredictContext {
        return { now: Date.now(), active: m.active, recent: m.others.filter((s) => s !== m.active), history: m.history.slice(-50).map(toPast) };
    }

    private best(cands: Candidate[]): Action | null {
        const top = this.ladder.merge(cands)[0];
        if (!top) return null;
        const source: Action["source"] = top.tiers.includes("model") ? "model" : "pattern";
        return { ...top.action, confidence: top.score, source };
    }

    /** Sequences, habits and field facts: all synchronous, all ~1 ms. */
    private fastCands(ctx: PredictContext): Candidate[] {
        return [...this.sequence.predict(ctx), ...this.habits.predict(ctx), ...this.facts.predict(ctx)];
    }

    fast(m: ModelInput): Action | null {
        const t0 = performance.now();
        const ctx = this.ctx(m);
        const a = this.best(this.fastCands(ctx));
        this.lastStats = { fastMs: performance.now() - t0 };
        return a;
    }

    async decide(m: ModelInput, signal?: AbortSignal): Promise<Action | null> {
        const ctx = this.ctx(m);
        const t0 = performance.now();
        const upstream = this.fastCands(ctx).sort((a, b) => b.score - a.score);
        const fastMs = performance.now() - t0;
        if (!this.model) return this.best(upstream);
        const t1 = performance.now();
        const modelCands = await this.model.predict(ctx, upstream.slice(0, 4), signal);
        const st = this.model.lastStats;
        this.lastStats = { fastMs, modelMs: performance.now() - t1, promptTokens: st?.promptTokens, cachedTokens: st?.cachedTokens };
        return this.best([...upstream, ...modelCands]);
    }
}
