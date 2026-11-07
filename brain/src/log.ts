// Optional debug logs in brain/logs/. Both are OFF by default: memory.db is the record (redacted, consolidated).
//   TAB_PREDICTION_LOG=1   predictions.jsonl: timing, source, action type and confidence; never values or labels
//   TAB_SESSION_LOG=1      session-*.jsonl: incoming web/Terminal messages, for `npm run replay`
//   TAB_SESSION_LOG=full   …and AX states and native user events too (everything, typed text included)
import { appendFileSync, mkdirSync } from "node:fs";

const DIR = new URL("../logs/", import.meta.url);

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

function write(file: URL, line: string): void {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(file, line + "\n");
}

export const log = {
    enabled: true,
    prediction(p: PredLog): void {
        if (!this.enabled || !process.env.TAB_PREDICTION_LOG) return;
        const a = p.action as { op?: string; confidence?: number; source?: string } | null;
        write(predictions, JSON.stringify({ ...p, action: a ? { op: a.op, confidence: a.confidence, source: a.source } : null }));
    },
    /**
     * Incoming messages, for `npm run replay` (only with TAB_SESSION_LOG; see the top of this file).
     */
    incoming(from: string, msg: unknown): void {
        if (!this.enabled || !process.env.TAB_SESSION_LOG) return;
        const m = msg as { type?: string; source?: string };
        if (process.env.TAB_SESSION_LOG !== "full" && (m?.source === "ax" || (m?.type === "user_event" && m?.source === "native"))) return;
        write(session, JSON.stringify({ ts: Date.now(), from, msg }));
    },
};
