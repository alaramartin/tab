// The decider behind the hub's predict loop: the local ladder by default, Claude as an opt-in.
import Anthropic from "@anthropic-ai/sdk";
import type { Action, El, ScreenState } from "../../protocol/types.ts";
import type { HistEntry } from "./history.ts";
import { EXAMPLES, OUTPUT_SCHEMA, SYSTEM } from "./prompt.ts";
import { stateKey } from "./state.ts";

const HARD_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 5000);

export interface ModelInput {
    active: ScreenState;
    others: ScreenState[];
    history: HistEntry[];
}

function compactEl(e: El) {
    return {
        id: e.id,
        role: e.role,
        label: e.label,
        ...(e.value ? { value: e.value } : {}),
        ...(e.options ? { options: e.options } : {}),
        ...(e.checked !== undefined ? { checked: e.checked } : {}),
        ...(e.enabled ? {} : { enabled: false }),
    };
}

function compactState(s: ScreenState, max: number) {
    return { app: s.app, window: s.window, ...(s.url ? { url: s.url } : {}), elements: s.elements.slice(0, max).map(compactEl) };
}

export function buildInput(m: ModelInput): string {
    const now = Date.now();
    return JSON.stringify({
        ACTIVE: compactState(m.active, 120),
        OTHER: m.others.filter((s) => stateKey(s) !== stateKey(m.active)).map((s) => compactState(s, 60)),
        HISTORY: m.history.slice(-15).map((h) => ({
            ago_s: Math.round((now - h.ts) / 1000),
            by: h.by,
            op: h.op,
            ...(h.url ? { url: h.url } : {}),
            ...(h.target ? { target: h.target.label } : {}),
            ...(h.value ? { value: h.value } : {}),
        })),
    });
}

export interface Decider {
    name: string;
    decide(m: ModelInput, signal?: AbortSignal): Promise<Action | null>;
    /** Synchronous, ~1 ms: what the fast tiers alone suggest (shown before the user goes idle). */
    fast?(m: ModelInput): Action | null;
    /** Learn from a step as it happens (the user's or Tab's). */
    observe?(h: HistEntry): void;
    /** What happened to a ghost this decider suggested (dismissals teach it what not to offer). */
    feedback?(a: Action, outcome: "accepted" | "dismissed", target?: El): void;
    /** A screen arrived: prepare for it in the background (embed its fields), so predicting on it is fast. */
    see?(s: ScreenState): void;
}

class ClaudeDecider implements Decider {
    name: string;
    private client = new Anthropic({ timeout: HARD_TIMEOUT_MS, maxRetries: 0 });
    constructor(private model: string) {
        this.name = `claude:${model}`;
    }

    async decide(m: ModelInput, signal?: AbortSignal): Promise<Action | null> {
        const res = await this.client.messages.create(
            {
                model: this.model,
                max_tokens: 2000,
                system: [{ type: "text", text: `${SYSTEM}\n\n${EXAMPLES}`, cache_control: { type: "ephemeral" } }],
                output_config: { effort: "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
                messages: [{ role: "user", content: buildInput(m) }],
            },
            { signal },
        );
        if (res.stop_reason !== "end_turn") return null;
        const text = res.content.find((b) => b.type === "text");
        if (!text || text.type !== "text") return null;
        const o = JSON.parse(text.text) as { op: string; app: string; targetId: string; value: string; label: string; confidence: number };
        return validate(o, m.active);
    }
}

/** Reject outputs that don't point at something real. */
export function validate(
    o: { op: string; app: string; targetId: string; value: string; label: string; confidence: number },
    active: ScreenState,
): Action | null {
    if (o.op === "none") return null;
    const a: Action = { op: o.op as Action["op"], app: o.app || active.app, label: o.label, confidence: o.confidence, source: "model" };
    if (o.op === "navigate") {
        if (!/^https?:\/\//.test(o.value)) return null;
        return { ...a, app: "com.google.Chrome", value: o.value };
    }
    const el = active.elements.find((e) => e.id === o.targetId);
    if (!el || !el.enabled) return null;
    if (o.op === "type" && el.role === "select" && el.options && !el.options.includes(o.value)) return null;
    return { ...a, app: active.app, url: active.url, targetId: el.id, targetPath: el.path, ...(o.value ? { value: o.value } : {}) };
}

/**
 * The hub's decider: the local ladder (habits + local LLM + calibrated combiner, src/predict/decider.ts) unless
 * TAB_DECIDER=claude (opt-in cloud: Anthropic credentials required) or TAB_DECIDER=none.
 */
export async function makeDecider(opts: { memory?: import("./memory/store.ts").Memory | null } = {}): Promise<Decider | null> {
    const which = process.env.TAB_DECIDER ?? "local";
    if (which === "none") return null;
    if (which === "claude") {
        if (!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) throw new Error("TAB_DECIDER=claude needs Anthropic credentials");
        return new ClaudeDecider(process.env.LLM_MODEL || "claude-opus-5-5");
    }
    const { LocalDecider } = await import("./predict/decider.ts");
    return new LocalDecider({ memory: opts.memory ?? null });
}
