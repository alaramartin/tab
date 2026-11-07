// Offline eval of the prediction ladder on recorded steps.
//
// Replays memory.db in time order. At every user step it asks each predictor for the next action, using only what
// happened before (the screen the step was taken on, earlier screens, earlier steps), scores the top candidate
// against what the user actually did, and only then lets the predictors learn the step. So the numbers are honest
// online numbers: a habit only counts once it has been seen.
//
//   npm run eval                        all steps in ~/.tab/memory.db (TAB_MEMORY_FILE to override)
//   npm run eval -- --since 7d --app com.apple.mail --tiers habit,pattern --json out.json
//   default tiers: habit, pattern, sequence (add fact with --tiers habit,pattern,sequence,fact: starts the embedder)
//   npm run eval -- --llm [--model-every N] [--max-steps N]   add the local LLM tier (Qwen3-1.7B on llama-server)
//
// Reports, per tier, the ladder (best candidate across tiers) and per app:
//   top-1 / top-3 accuracy, and at score thresholds 0.3/0.5/0.7: coverage (share of steps with a ghost) and
//   precision (share of those ghosts that were right), plus latency p50/p95.
import { writeFileSync } from "node:fs";
import type { Action, ScreenState } from "../../protocol/types.ts";
import { HistEntry } from "../src/history.ts";
import { HabitModel } from "../src/memory/habits.ts";
import { FactIndex } from "../src/memory/facts.ts";
import { Embedder } from "../src/memory/embed.ts";
import { elSig, expandEls, norm } from "../src/memory/sig.ts";
import { DEFAULT_MEMORY_FILE, Memory, type StepRow } from "../src/memory/store.ts";
import { PatternEngine } from "../src/pattern.ts";
import type { Candidate, PastStep, PredictContext, Predictor } from "../src/predict/types.ts";
import { LocalModelTier } from "../src/predict/local.ts";
import { genericCandidates } from "../src/predict/generic.ts";
import { LlamaServer, MODELS } from "../src/runtime/llama.ts";
import { Ladder } from "../src/predict/ladder.ts";
import { SequenceTier } from "../src/predict/sequence.ts";

const args = process.argv.slice(2);
const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};
function since(s: string): number {
    const m = /^(\d+)([mhd])$/.exec(s);
    return m ? Date.now() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"] : Date.parse(s);
}

/** The pre-v2 pattern engine (repeat-what-you-did on web lists) behind the Predictor interface. */
class PatternTier implements Predictor {
    readonly tier = "pattern" as const;
    private eng = new PatternEngine();
    predict(ctx: PredictContext): Candidate[] {
        const h: HistEntry[] = ctx.history.map((s) => ({
            op: s.op, app: s.app, url: s.url, value: s.value, ts: s.ts, by: s.by,
            target: s.target ? { id: s.target.id, path: s.target.path, role: s.target.role, label: s.target.label, list: s.target.list } : undefined,
        }));
        const a = this.eng.predict(h, [ctx.active, ...ctx.recent], ctx.now) ?? this.eng.recall(ctx.active, [ctx.active, ...ctx.recent], ctx.now, h);
        return a ? [{ action: a, score: a.confidence, tier: "pattern", why: a.label }] : [];
    }
}

const TIERS: Record<string, () => Predictor> = {
    habit: () => new HabitModel(),
    pattern: () => new PatternTier(),
    fact: () => new FactIndex(new Embedder(null)),
    sequence: () => new SequenceTier(),
};

/** Did the candidate predict this step? Same op, same element (by path, else by signature), same value. */
function matches(a: Action, step: StepRow, active: ScreenState): boolean {
    const first = a.op === "sequence" ? (a.steps?.[0] as Action | undefined) : a;
    if (!first) return false;
    // Clicking into a field is how typing starts: a "type into this field" ghost would have covered it.
    if (step.op === "click" && first.op === "type" && (step.target?.role === "textfield" || step.target?.role === "textarea"))
        return !!first.targetPath && first.targetPath === step.target?.path;
    if (first.op !== step.op) return false;
    if (step.op === "navigate") return norm(first.value ?? "") === norm(step.value ?? "");
    if (step.op === "key") return (first.value ?? "") === (step.value ?? "");
    if (step.target) {
        const samePath = !!first.targetPath && first.targetPath === step.target.path;
        const el = active.elements.find((e) => e.path === first.targetPath || e.id === first.targetId);
        const sameSig = !!el && elSig(step.app, el) === step.target_sig;
        if (!samePath && !sameSig) return false;
    }
    if (step.op === "type") return norm(first.value ?? "") === norm(step.value ?? "");
    return true;
}

type Rec = { app: string; tier: string; score: number; correct: boolean; top3: boolean; ms: number; ts?: number };

const mem = new Memory(process.env.TAB_MEMORY_FILE || DEFAULT_MEMORY_FILE);
const tiers = (flag("--tiers") ?? "habit,pattern,sequence").split(",").map((t) => TIERS[t]?.() ?? (() => { throw new Error(`no tier ${t}`); })());
const modelName = args.includes("--llm") ? "qwen" : undefined;
const modelEvery = Number(flag("--model-every") ?? 1);
const maxSteps = Number(flag("--max-steps") ?? Infinity);
const server = modelName ? new LlamaServer(MODELS.qwen, 7813) : null; // its own port: a running hub keeps 7811
const modelTier = server ? new LocalModelTier(server) : null;
if (server) await server.start();
let dumped = 0;
const ladder = new Ladder(flag("--fit") !== undefined || args.includes("--fit") ? null : undefined);
/** Per evaluated step: every merged candidate's features and whether it was the right one. */
const combined: { app: string; ts: number; rows: { x: number[]; y: number }[] }[] = [];
const combinedFast: typeof combined = [];
const modelStats: { prompt: number; cached: number; ms: number; options: number; inOptions: boolean; kind: string }[] = [];
const rows = mem.steps({ since: flag("--since") ? since(flag("--since")!) : undefined, app: flag("--app") });
const recs: Rec[] = [];
const history: PastStep[] = [];
const recentByPlace = new Map<string, ScreenState>();
const snapCache = new Map<string, ScreenState>();
let evaluated = 0, skipped = 0;

function stateOf(hash: string): ScreenState | null {
    const hit = snapCache.get(hash);
    if (hit) return hit;
    const s = mem.snapshot(hash);
    if (!s) return null;
    const st: ScreenState = { type: "state", source: s.source, app: s.app, window: s.window, ...(s.url ? { url: s.url } : {}), focused: true, elements: expandEls(s.els), seq: 0, ts: 0 };
    if (snapCache.size > 2000) snapCache.clear();
    snapCache.set(hash, st);
    return st;
}

// Every screen in the order it was first seen, so "screens seen so far" includes pages that never had a step.
const screens = mem.db.prepare("SELECT hash, app, url, first_ts FROM snapshots ORDER BY first_ts").all() as { hash: string; app: string; url: string | null; first_ts: number }[];
let si = 0;

for (const r of rows) {
    for (; si < screens.length && screens[si].first_ts < r.ts; si++) {
        const sc = screens[si];
        const st = stateOf(sc.hash);
        if (!st) continue;
        st.ts = sc.first_ts;
        const place = st.source === "web" && sc.url ? `web:${sc.url}` : sc.app;
        recentByPlace.delete(place); // re-insert: the map stays in last-seen order
        recentByPlace.set(place, st);
    }
    const step: PastStep = { ts: r.ts, app: r.app, window: r.window ?? undefined, url: r.url ?? undefined, op: r.op as Action["op"], by: r.by,
        target: r.target ? { ...r.target } : undefined, value: r.value ?? undefined };
    const active = r.before_snap ? stateOf(r.before_snap) : null;
    if (active) active.ts = r.ts;
    const evaluable = r.by === "user" && active && ["click", "type", "key", "navigate"].includes(r.op);
    if (evaluable && evaluated < maxSteps) {
        evaluated++;
        const ctx: PredictContext = { now: r.ts - 1, active: active!, recent: [...recentByPlace.values()].filter((s) => s !== active && r.ts - s.ts < 600_000).slice(-8).reverse(), history: history.slice(-50) };
        const all: Candidate[] = [];
        for (const t of tiers) {
            if (t instanceof FactIndex) await t.prepare(active!); // live, this runs when the screen arrives
            const t0 = performance.now();
            const c = (await t.predict(ctx)).sort((a, b) => b.score - a.score);
            const ms = performance.now() - t0;
            all.push(...c);
            recs.push({ app: r.app, tier: t.tier, score: c[0]?.score ?? 0, correct: !!c[0] && matches(c[0].action, r, active!), top3: c.slice(0, 3).some((x) => matches(x.action, r, active!)), ms });
        }
        all.sort((a, b) => b.score - a.score);
        combinedFast.push({ app: r.app, ts: r.ts, rows: ladder.merge(all).map((m) => ({ x: m.x, y: matches(m.action, r, active!) ? 1 : 0 })) });
        if (modelTier && (evaluated - 1) % modelEvery === 0) {
            const t0 = performance.now();
            const c = await modelTier.predict(ctx, all.slice(0, 4));
            const ms = performance.now() - t0;
            const opts = genericCandidates(ctx, all.slice(0, 4), 15);
            const st = modelTier.lastStats;
            if (flag("--dump") && dumped < Number(flag("--dump"))) {
                dumped++;
                const { prompt } = modelTier.buildPrompt(ctx, all.slice(0, 4));
                console.log(`\n===== truth: ${r.op} ${r.target ? `${r.target.role} "${r.target.label}"` : ""} ${r.value ? JSON.stringify(r.value) : ""} · in options: ${opts.some((a) => matches(a, r, active!))}`);
                console.log(prompt.split("<|im_start|>user\n")[1]?.split("<|im_end|>")[0]);
                console.log(`--> model: ${c.slice(0, 3).map((x) => `${x.action.label} ${x.score.toFixed(2)}`).join(" | ")}`);
            }
            if (st) modelStats.push({ prompt: st.promptTokens, cached: st.cachedTokens, ms: st.ms, options: st.options, inOptions: opts.some((a) => matches(a, r, active!)), kind: `${r.op} ${r.target?.role ?? ""}${r.op === "type" ? (opts.some((a) => a.op === "type" && a.targetPath === r.target?.path) ? " (field offered, wrong value)" : " (field not offered)") : ""}` });
            const merged = ladder.merge([...all, ...c]);
            combined.push({ app: r.app, ts: r.ts, rows: merged.map((m) => ({ x: m.x, y: matches(m.action, r, active!) ? 1 : 0 })) });
            recs.push({ app: r.app, tier: "model", score: c[0]?.score ?? 0, correct: !!c[0] && matches(c[0].action, r, active!), top3: c.slice(0, 3).some((x) => matches(x.action, r, active!)), ms });
            // Ladder with the model: a confident fast tier wins; otherwise the model's pick.
            const fast = all[0];
            const pick = fast && fast.score >= 0.7 ? fast : c[0] && (!fast || c[0].score > fast.score) ? c[0] : fast;
            recs.push({ app: r.app, tier: "ladder+model", score: pick?.score ?? 0, correct: !!pick && matches(pick.action, r, active!), top3: false, ms });
        }
        recs.push({ ts: r.ts, app: r.app, tier: "ladder", score: all[0]?.score ?? 0, correct: !!all[0] && matches(all[0].action, r, active!), top3: all.slice(0, 3).some((x) => matches(x.action, r, active!)), ms: 0 });
    } else skipped++;
    for (const t of tiers) t.observe?.(step, null);
    history.push(step);

}

/** The largest share of steps that can get a ghost while ghosts stay at least `prec` right (best threshold). */
function covAt(rs: Rec[], prec: number): number {
    const sorted = [...rs].sort((a, b) => b.score - a.score);
    let right = 0, best = 0;
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].score <= 0) break;
        if (sorted[i].correct) right++;
        if (right / (i + 1) >= prec && (i + 1 === sorted.length || sorted[i + 1].score < sorted[i].score)) best = (i + 1) / rs.length;
    }
    return best;
}

function summarize(rs: Rec[]) {
    const n = rs.length;
    const pct = (x: number) => (n ? `${((x / n) * 100).toFixed(0)}%` : "-");
    const at = (thr: number) => {
        const shown = rs.filter((r) => r.score >= thr);
        const right = shown.filter((r) => r.correct).length;
        return { coverage: n ? shown.length / n : 0, precision: shown.length ? right / shown.length : NaN, shown: shown.length };
    };
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    return {
        n,
        top1: pct(rs.filter((r) => r.correct).length),
        top3: pct(rs.filter((r) => r.top3).length),
        at: Object.fromEntries([0.3, 0.5, 0.7].map((t) => [t, at(t)])),
        cov85: covAt(rs, 0.85),
        cov95: covAt(rs, 0.95),
        p50: ms[Math.floor(ms.length / 2)] ?? 0,
        p95: ms[Math.floor(ms.length * 0.95)] ?? 0,
    };
}

const fmtAt = (a: { coverage: number; precision: number }) =>
    `${(a.coverage * 100).toFixed(0).padStart(3)}% / ${Number.isNaN(a.precision) ? "  -" : (a.precision * 100).toFixed(0).padStart(3) + "%"}`;
const line = (name: string, s: ReturnType<typeof summarize>) =>
    `${name.padEnd(34).slice(0, 34)} ${String(s.n).padStart(6)}  ${s.top1.padStart(4)} ${s.top3.padStart(4)}   ${fmtAt(s.at[0.3])}   ${fmtAt(s.at[0.5])}   ${fmtAt(s.at[0.7])}   ${(s.cov85 * 100).toFixed(0).padStart(3)}%  ${(s.cov95 * 100).toFixed(0).padStart(3)}%   ${s.p50.toFixed(2)}/${s.p95.toFixed(2)} ms`;

console.log(`${mem.file}: ${rows.length} steps, ${evaluated} evaluated (user actions with a recorded screen), ${skipped} skipped\n`);
console.log(`${"".padEnd(34)} ${"steps".padStart(6)}  top1 top3   cov/prec≥.3   cov/prec≥.5   cov/prec≥.7   cov@85% cov@95%   latency p50/p95`);
const tierNames = [...new Set(recs.map((r) => r.tier))];
const report: Record<string, unknown> = {};
for (const t of tierNames) {
    const s = summarize(recs.filter((r) => r.tier === t));
    report[t] = s;
    console.log(line(t, s));
}
console.log("\nladder by app:");
const apps = [...new Set(recs.map((r) => r.app))];
const byApp: Record<string, unknown> = {};
for (const a of apps.sort((x, y) => recs.filter((r) => r.app === y).length - recs.filter((r) => r.app === x).length)) {
    const s = summarize(recs.filter((r) => r.tier === "ladder" && r.app === a));
    byApp[a] = s;
    console.log(line(`  ${a}`, s));
}
{
    // The fast-only combiner (what the hub uses before the model has run), on every evaluated step.
    const half = Math.floor(combinedFast.length / 2);
    const test = combinedFast.slice(half);
    const run = (w: number[], name: string) => {
        const sig = (x: number[]) => 1 / (1 + Math.exp(-x.reduce((s, xi, i) => s + xi * w[i], 0)));
        const rs: Rec[] = test.map((st) => {
            const best = st.rows.map((r) => ({ p: sig(r.x), y: r.y })).sort((a, b) => b.p - a.p)[0];
            return { app: st.app, tier: name, score: best?.p ?? 0, correct: !!best?.y, top3: false, ms: 0 };
        });
        console.log(line(`${name} (test half)`, summarize(rs)));
    };
    console.log("");
    run(ladder.wFast, "fast combiner, default");
    const fit = new Ladder(null);
    fit.fit(combinedFast.slice(0, half).flatMap((s) => s.rows), { which: "fast" });
    run(fit.wFast, "fast combiner, fitted");
}
if (combined.length) {
    // Chronological split: fit on the first half, report on the second (what a fit on past data does for the future).
    const half = Math.floor(combined.length / 2);
    const test = combined.slice(half);
    const evalW = (w: number[], name: string) => {
        const sig = (x: number[]) => 1 / (1 + Math.exp(-x.reduce((s, xi, i) => s + xi * w[i], 0)));
        const rs: Rec[] = test.map((st) => {
            const best = st.rows.map((r) => ({ p: sig(r.x), y: r.y })).sort((a, b) => b.p - a.p)[0];
            return { app: st.app, tier: name, score: best?.p ?? 0, correct: !!best?.y, top3: false, ms: 0 };
        });
        console.log(line(`${name} (test half)`, summarize(rs)));
    };
    console.log("");
    const testTs = new Set(test.map((t) => t.ts));
    console.log(line("fast ladder (test half)", summarize(recs.filter((r) => r.tier === "ladder" && testTs.has(r.ts!)))));
    evalW(ladder.w, "combined, default weights");
    const fit = new Ladder(null);
    fit.fit(combined.slice(0, half).flatMap((s) => s.rows));
    evalW(fit.w, "combined, fitted on 1st half");
}
if (args.includes("--fit")) {
    const all = new Ladder();
    all.fit(combinedFast.flatMap((s) => s.rows), { which: "fast" });
    if (combined.length) all.fit(combined.flatMap((s) => s.rows), { which: "full" });
    all.save();
    console.log(`saved ladder weights (fast: ${combinedFast.length} steps${combined.length ? `, full: ${combined.length}` : ""}) → ${process.env.TAB_LADDER_FILE || "~/.tab/ladder.json"}`);
}
if (modelStats.length) {
    const q = (xs: number[], f: number) => xs.sort((a, b) => a - b)[Math.floor(xs.length * f)] ?? 0;
    console.log(`\nmodel ${modelName}: ${modelStats.length} calls · prompt tokens p50 ${q(modelStats.map((m) => m.prompt), 0.5)} (cached p50 ${q(modelStats.map((m) => m.cached), 0.5)})` +
        ` · latency p50 ${q(modelStats.map((m) => m.ms), 0.5).toFixed(0)} ms p95 ${q(modelStats.map((m) => m.ms), 0.95).toFixed(0)} ms` +
        ` · options p50 ${q(modelStats.map((m) => m.options), 0.5)} · right answer among the options: ${((modelStats.filter((m) => m.inOptions).length / modelStats.length) * 100).toFixed(0)}%`);
}
if (modelStats.length) {
    const miss = new Map<string, number>();
    for (const m of modelStats) if (!m.inOptions) miss.set(m.kind, (miss.get(m.kind) ?? 0) + 1);
    console.log("missing from the options: " + [...miss].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(", "));
}
server?.stop();
if (flag("--json")) writeFileSync(flag("--json")!, JSON.stringify({ tiers: report, byApp }, null, 2));
mem.close();
