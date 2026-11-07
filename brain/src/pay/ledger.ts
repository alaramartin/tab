// Every payment Tab makes, one JSON line each, in ~/.tab/payments.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIR = join(homedir(), ".tab");

export function record(p: { domain: string; payTo: string; amountUsd: string; url: string; txHash?: string; ok: boolean; error?: string }): void {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, "payments.jsonl"), JSON.stringify({ ts: Date.now(), ...p }) + "\n");
}
