// Situation index (EXTENDED_PLAN.md §3.2.5), first version: past moments that look like now, and what the user did
// next. "Looks like now" = the same kind of screen, ranked by the same previous action and the same element touched
// last, then recency. The model gets the top few as examples of this user's own behaviour, which a small model can
// follow far better than it can guess. (Embedding similarity across screen kinds comes on top of this.)
import type { PastStep, PredictContext } from "../predict/types.ts";
import { stepDesc } from "../predict/generic.ts";
import { templateOf } from "./habits.ts";
import { screenKind } from "./sig.ts";

interface Entry {
    kind: string;
    prevKey: string;
    prevDesc: string;
    nextKey: string;
    nextDesc: string;
    ts: number;
}

const MAX_GAP_MS = 10 * 60_000;

export class SituationIndex {
    private byKind = new Map<string, Entry[]>();
    private prev: PastStep | null = null;

    observe(step: PastStep): void {
        const p = this.prev;
        this.prev = step;
        if (!p || step.by !== "user" || step.ts - p.ts > MAX_GAP_MS || step.op === "sequence") return;
        const kind = screenKind(step);
        const list = this.byKind.get(kind) ?? [];
        list.push({ kind, prevKey: templateOf(p).key, prevDesc: stepDesc(p), nextKey: templateOf(step).key, nextDesc: stepDesc(step), ts: step.ts });
        if (list.length > 400) list.shift();
        this.byKind.set(kind, list);
    }

    /** Up to k past "after X, they Y" moments for this screen, most similar first, one per distinct next action. */
    examples(ctx: PredictContext, k = 3): string[] {
        const list = this.byKind.get(screenKind(ctx.active));
        if (!list?.length) return [];
        const last = ctx.history.at(-1);
        const lastKey = last ? templateOf(last).key : "";
        const scored = list
            .filter((e) => e.ts < ctx.now)
            .map((e) => ({ e, s: (e.prevKey === lastKey ? 3 : 0) + 1 / (1 + (ctx.now - e.ts) / 86_400_000) }))
            .sort((a, b) => b.s - a.s);
        const out: string[] = [];
        const seen = new Set<string>();
        for (const { e } of scored) {
            if (seen.has(e.nextKey)) continue;
            seen.add(e.nextKey);
            out.push(`after they ${e.prevDesc}, they ${e.nextDesc}`);
            if (out.length >= k) break;
        }
        return out;
    }
}
