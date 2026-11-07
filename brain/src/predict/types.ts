// The prediction ladder's common shapes. Every tier takes the same context and returns scored
// candidates; the live brain and the offline eval (tools/eval.ts) drive tiers through exactly this interface.
import type { Action, El, ScreenState } from "../../../protocol/types.ts";

/** A past action, as the ladder sees it (live: from History + memory; eval: from memory.db steps). */
export interface PastStep {
    ts: number;
    app: string;
    window?: string;
    url?: string;
    op: Action["op"];
    by: "user" | "tab";
    target?: El;
    value?: string;
}

export interface PredictContext {
    now: number;
    active: ScreenState; // the screen the next action happens on
    recent: ScreenState[]; // other screens seen lately (other apps, other tabs), newest first
    history: PastStep[]; // oldest first
}

export type Tier = "pattern" | "sequence" | "habit" | "fact" | "model";

export interface Candidate {
    action: Action; // concrete: targets an element of ctx.active (or a sequence / navigation)
    score: number; // calibrated probability that this is the user's next action
    tier: Tier;
    why?: string; // short provenance for the HUD and debugging, e.g. "after Click Send (12×)"
    pNone?: number; // model: probability it gave "None of these" on this screen (the combiner uses it)
}

export interface Predictor {
    readonly tier: Tier;
    /** `upstream`: candidates from faster tiers, which a slower tier may rerank (the model does). */
    predict(ctx: PredictContext, upstream?: Candidate[]): Candidate[] | Promise<Candidate[]>;
    /** Learn from what actually happened (online: called after every step, user's or Tab's). */
    observe?(step: PastStep, ctx: PredictContext | null): void;
}
