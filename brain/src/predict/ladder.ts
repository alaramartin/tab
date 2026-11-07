// The ladder's last step (EXTENDED_PLAN.md §4 "Ranking"): merge every tier's candidates for the same action and
// turn their evidence into one calibrated probability with a logistic model. Raw tier scores aren't comparable (the
// LLM is overconfident; the habit model is conservative when evidence is thin), and agreement between tiers is
// strong evidence on its own. Weights are fitted on recorded steps (`npm run eval -- --fit`) and saved to
// ~/.tab/ladder.json; until then, hand-set defaults apply.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Action } from "../../../protocol/types.ts";
import { actionKey } from "./generic.ts";
import type { Candidate, Tier } from "./types.ts";

export const LADDER_FILE = process.env.TAB_LADDER_FILE || join(homedir(), ".tab", "ladder.json");

export const FEATURES = [
    "bias", "habit", "pattern", "model", "model_top", "max_fast", "n_tiers", "op_type", "op_click", "op_key", "op_seq", "logit_model", "logit_habit", "model_none", "model_ran", "fact", "logit_fact",
] as const;

const logit = (p: number) => Math.log(Math.max(1e-4, Math.min(1 - 1e-4, p)) / (1 - Math.max(1e-4, Math.min(1 - 1e-4, p))));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export interface Merged {
    action: Action;
    by: Partial<Record<Tier, number>>;
    modelRank?: number;
    x: number[];
    score: number;
    tiers: Tier[];
}

/** Fast tiers only (no model ran): the habit model's own scores are already conservative; keep them, near enough. */
const DEFAULT_FAST: Partial<Record<(typeof FEATURES)[number], number>> = { bias: 0.3, logit_habit: 1, logit_fact: 1, pattern: 3, n_tiers: 0.3 };

/** Defaults before any fit, with the model: trust patterns, habits with evidence, the model only with agreement. */
const DEFAULT_W: Record<(typeof FEATURES)[number], number> = {
    bias: -3, habit: 2.5, pattern: 4.5, model: 1.2, model_top: 0.4, max_fast: 0.5, n_tiers: 0.8,
    op_type: 0, op_click: 0, op_key: -0.3, op_seq: 0.5, logit_model: 0.3, logit_habit: 0.3, model_none: -2, model_ran: 0, fact: 2, logit_fact: 0.5,
};

export class Ladder {
    /** Weights when the model ran (full ladder) and when only the fast tiers did. */
    w: number[];
    wFast: number[];
    fitted: { n: number; at: number } | null = null;

    constructor(private file: string | null = LADDER_FILE) {
        this.w = FEATURES.map((f) => DEFAULT_W[f]);
        this.wFast = FEATURES.map((f) => DEFAULT_FAST[f] ?? 0);
        if (file && existsSync(file)) {
            try {
                const j = JSON.parse(readFileSync(file, "utf8")) as { features: string[]; w: number[]; wFast?: number[]; n: number; at: number };
                if (j.features.join() === FEATURES.join()) {
                    this.w = j.w;
                    if (j.wFast) this.wFast = j.wFast;
                    this.fitted = { n: j.n, at: j.at };
                }
            } catch {}
        }
    }

    features(by: Partial<Record<Tier, number>>, a: Action, modelRank?: number, pNone?: number): number[] {
        const habit = by.habit ?? 0, pattern = by.pattern ?? 0, model = by.model ?? 0, fact = by.fact ?? 0;
        const tiers = Object.values(by).filter((v) => (v ?? 0) > 0).length;
        return [
            1, habit, pattern, model, modelRank === 0 ? 1 : 0, Math.max(habit, pattern, fact), tiers,
            a.op === "type" ? 1 : 0, a.op === "click" ? 1 : 0, a.op === "key" ? 1 : 0, a.op === "sequence" ? 1 : 0,
            model > 0 ? logit(model) : 0, habit > 0 ? logit(habit) : 0, pNone ?? 0, pNone !== undefined ? 1 : 0,
            fact, fact > 0 ? logit(fact) : 0,
        ];
    }

    /** One entry per distinct action, scored; best first. */
    merge(cands: Candidate[]): Merged[] {
        const m = new Map<string, { action: Action; by: Partial<Record<Tier, number>>; modelRank?: number }>();
        const modelOrder = cands.filter((c) => c.tier === "model").sort((a, b) => b.score - a.score);
        const pNone = cands.find((c) => c.pNone !== undefined)?.pNone;
        for (const c of cands) {
            const k = actionKey(c.action.op === "sequence" ? { op: "sequence", targetPath: c.action.label } : c.action);
            const e = m.get(k) ?? { action: c.action, by: {} };
            e.by[c.tier] = Math.max(e.by[c.tier] ?? 0, c.score);
            if (c.tier === "model") e.modelRank = modelOrder.indexOf(c);
            if (c.action.op === "sequence" || (c.tier !== "model" && e.action.source === "model")) e.action = c.action; // keep the richest action
            m.set(k, e);
        }
        const w = cands.some((c) => c.tier === "model") ? this.w : this.wFast;
        return [...m.values()]
            .map((e) => {
                const x = this.features(e.by, e.action, e.modelRank, pNone);
                const score = sigmoid(x.reduce((s, xi, i) => s + xi * w[i], 0));
                return { ...e, x, score, tiers: Object.keys(e.by) as Tier[] };
            })
            .sort((a, b) => b.score - a.score);
    }

    /** Logistic regression with L2, by gradient descent. Rows: features and whether that candidate was right. */
    /** Fit the weights used when the model ran (`which: "full"`) or when only fast tiers did. */
    fit(rows: { x: number[]; y: number }[], o: { epochs?: number; lr?: number; l2?: number; which?: "full" | "fast" } = {}): void {
        const w = FEATURES.map(() => 0);
        w[0] = -2;
        const epochs = o.epochs ?? 400, lr = o.lr ?? 0.1, l2 = o.l2 ?? 1e-3;
        // Balance: right answers are rare among candidates; weight them up so the bias isn't all the model learns.
        const pos = rows.filter((r) => r.y).length || 1;
        const wPos = Math.min(10, (rows.length - pos) / pos);
        for (let ep = 0; ep < epochs; ep++) {
            const g = w.map(() => 0);
            let tot = 0;
            for (const r of rows) {
                const p = sigmoid(r.x.reduce((s, xi, i) => s + xi * w[i], 0));
                const k = r.y ? wPos : 1;
                tot += k;
                for (let i = 0; i < w.length; i++) g[i] += k * (p - r.y) * r.x[i];
            }
            for (let i = 0; i < w.length; i++) w[i] -= lr * (g[i] / tot + l2 * w[i] * (i === 0 ? 0 : 1));
        }
        // Undo the class weighting in the bias so scores are probabilities again (prior correction).
        w[0] -= Math.log(wPos);
        if (o.which === "fast") this.wFast = w;
        else this.w = w;
        this.fitted = { n: rows.length, at: Date.now() };
    }

    save(): void {
        if (!this.file) return;
        mkdirSync(dirname(this.file), { recursive: true });
        const tmp = this.file + ".tmp";
        writeFileSync(tmp, JSON.stringify({ features: FEATURES, w: this.w, wFast: this.wFast, n: this.fitted?.n ?? 0, at: this.fitted?.at ?? Date.now() }, null, 2));
        renameSync(tmp, this.file);
    }
}
