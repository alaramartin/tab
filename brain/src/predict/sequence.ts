// Sequence extrapolation (EXTENDED_PLAN.md §4 T0): "you're numbering rows; the next is 4, then the rest".
//
// Looks at the user's last type steps into the same kind of field (same element signature: role, label, column) on
// consecutive rows. If the values follow a rule (arithmetic numbers, prefix + number like ENG-141 → ENG-142 keeping
// zero padding, or the same value every time), it predicts the next row, and once the rule has held three times,
// offers the whole rest of the column as one sequence. Works on any app that exposes rows (grid) — and on apps that
// don't (a canvas spreadsheet): there the "next row" is wherever focus went after the navigation key.
import type { Action, El } from "../../../protocol/types.ts";
import { elSig } from "../memory/sig.ts";
import { labelFor } from "./generic.ts";
import type { Candidate, PastStep, PredictContext, Predictor } from "./types.ts";

const MAX_GAP_MS = 2 * 60_000;

/** The value rule behind a run of values, or null. Returns the n-th next value (n = 1 is the next one). */
export function valueRule(vals: string[]): ((n: number) => string) | null {
    if (vals.length < 2) return null;
    if (vals.every((v) => v === vals[0])) return () => vals[0];
    const parts = vals.map((v) => /^(.*?)(-?\d+)(\D*)$/.exec(v));
    if (parts.some((p) => !p)) return null;
    const pre = parts[0]![1], suf = parts[0]![3];
    if (parts.some((p) => p![1] !== pre || p![3] !== suf)) return null;
    const nums = parts.map((p) => Number(p![2]));
    const d = nums[1] - nums[0];
    if (d === 0 || nums.some((x, i) => i > 0 && x - nums[i - 1] !== d)) return null;
    const width = parts[0]![2].replace("-", "").length;
    const padded = parts.every((p) => p![2].replace("-", "").startsWith("0") || p![2].replace("-", "").length === width) && parts[0]![2].startsWith("0");
    return (n) => {
        const x = nums[nums.length - 1] + d * n;
        const s = padded ? String(Math.abs(x)).padStart(width, "0") : String(Math.abs(x));
        return `${pre}${x < 0 ? "-" : ""}${s}${suf}`;
    };
}

export class SequenceTier implements Predictor {
    readonly tier = "pattern" as const;

    predict(ctx: PredictContext): Candidate[] {
        const s = ctx.active;
        // The user's recent type steps in this app, newest first, until the run breaks.
        const types = ctx.history.filter((h) => h.by === "user" || h.by === "tab").filter((h) => h.op === "type" && h.app === s.app && h.target && h.value !== undefined);
        if (types.length < 2) return [];
        const last = types[types.length - 1];
        if (ctx.now - last.ts > MAX_GAP_MS) return [];
        const sig = elSig(s.app, last.target!);
        const run: PastStep[] = [last];
        for (let i = types.length - 2; i >= 0 && run.length < 8; i--) {
            const t = types[i];
            if (elSig(s.app, t.target!) !== sig || run[0].ts - t.ts > MAX_GAP_MS) break;
            run.unshift(t);
        }
        // The longest recent run with one rule for both the values and the rows (1, 2, then 10, 20, 30 → 10, 20, 30).
        let rule: ((n: number) => string) | null = null;
        let rows: (number | undefined)[] = [];
        let gridded = false;
        let dRow = 0;
        for (let k = run.length; k >= 2 && !rule; k--) {
            const sub = run.slice(-k);
            const r = valueRule(sub.map((x) => x.value!));
            if (!r) continue;
            const rs = sub.map((x) => x.target!.grid?.row);
            const g = rs.every((x) => x !== undefined);
            const d = g ? rs[1]! - rs[0]! : 0;
            if (g && (d === 0 || rs.some((x, i) => i > 0 && x! - rs[i - 1]! !== d))) continue;
            run.splice(0, run.length - k);
            (rule = r), (rows = rs), (gridded = g), (dRow = d);
        }
        if (!rule) return [];
        const next = rule;
        const same = s.elements.filter((e) => e.enabled && elSig(s.app, e) === sig);
        const nextEl = (n: number): El | undefined =>
            gridded ? same.find((e) => e.grid?.row === rows[rows.length - 1]! + dRow * n) : n === 1 ? same.find((e) => e.focused) ?? s.elements.find((e) => e.focused) : undefined;
        const el = nextEl(1);
        if (!el || (el.value && el.value === next(1))) return [];

        const conf = run.length >= 4 ? 0.95 : run.length === 3 ? 0.9 : 0.75;
        const act = (e: El, v: string): Action => {
            const a: Action = { op: "type", app: s.app, ...(s.url ? { url: s.url } : {}), targetId: e.id, targetPath: e.path, value: v, label: "", confidence: conf, source: "pattern" };
            a.label = labelFor(a, e);
            return a;
        };
        const out: Candidate[] = [{ action: act(el, next(1)), score: conf, tier: "pattern", why: `continues ${run.map((r) => r.value).join(", ")}` }];

        // After three in a row, the rest of the column in one go.
        if (gridded && run.length >= 3) {
            const steps: Action[] = [];
            for (let n = 1; n <= 200; n++) {
                const e = nextEl(n);
                if (!e) break;
                steps.push(act(e, next(n)));
            }
            if (steps.length >= 2) {
                const label = `Fill the remaining ${steps.length} (${steps[0].value} … ${steps[steps.length - 1].value})`;
                // Confirmed four times (e.g. three by hand and one accepted Tab): the batch leads.
                const score = run.length >= 4 ? Math.min(0.99, conf + 0.02) : conf * 0.98;
                out.push({ action: { op: "sequence", app: s.app, steps, label, confidence: score, source: "pattern" }, score, tier: "pattern", why: label });
            }
        }
        return out;
    }
}
