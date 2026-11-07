// The decider behind the hub's predict loop: everything runs on this Mac (src/predict/decider.ts).
import type { Action, El, ScreenState } from "../../protocol/types.ts";
import type { HistEntry } from "./history.ts";
import type { Memory } from "./memory/store.ts";

export interface ModelInput {
    active: ScreenState;
    others: ScreenState[];
    history: HistEntry[];
}

export interface Decider {
    name: string;
    /** The full ladder, local LLM included (~0.4 s); called after the user pauses, aborted on any input. */
    decide(m: ModelInput, signal?: AbortSignal): Promise<Action | null>;
    /** Synchronous, ~1 ms: what the fast tiers alone suggest (shown before the user goes idle). */
    fast?(m: ModelInput): Action | null;
    /** Learn from a step as it happens (the user's or Tab's). */
    observe?(h: HistEntry): void;
    /** What happened to a ghost this decider suggested (dismissals teach it what not to offer). */
    feedback?(a: Action, outcome: "accepted" | "dismissed", target?: El): void;
    /** Memory changed underneath (forget): relearn from what is left. */
    rebuild?(memory: Memory | null): void;
    /** A screen arrived: prepare for it in the background (embed its fields), so predicting on it is fast. */
    see?(s: ScreenState): void;
}

export async function makeDecider(opts: { memory?: Memory | null } = {}): Promise<Decider> {
    const { LocalDecider } = await import("./predict/decider.ts");
    return new LocalDecider({ memory: opts.memory ?? null });
}
