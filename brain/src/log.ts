import { appendFileSync, mkdirSync } from "node:fs";

const DIR = new URL("../logs/", import.meta.url);
mkdirSync(DIR, { recursive: true });

const predictions = new URL("predictions.jsonl", DIR);
const session = new URL(`session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`, DIR);

export interface PredLog {
    ts: number;
    gen: number;
    source: "pattern" | "model";
    latencyMs: number;
    action: unknown;
    shown: boolean;
    accepted?: boolean;
}

export const log = {
    enabled: true,
    prediction(p: PredLog): void {
        if (this.enabled) appendFileSync(predictions, JSON.stringify(p) + "\n");
    },
    /**
     * Every incoming message, for `npm run replay`. AX states and native user events (any app, typed text) are left
     * out unless TAB_SESSION_LOG=full: memory.db keeps them, redacted and deduplicated.
     */
    incoming(from: string, msg: unknown): void {
        if (!this.enabled) return;
        const m = msg as { type?: string; source?: string };
        if (process.env.TAB_SESSION_LOG !== "full" && (m?.source === "ax" || (m?.type === "user_event" && m?.source === "native"))) return;
        appendFileSync(session, JSON.stringify({ ts: Date.now(), from, msg }) + "\n");
    },
};
