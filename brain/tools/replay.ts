// npm run replay <brain/logs/session-*.jsonl> [--no-model]
// Feeds a recorded session through a fresh Brain and prints each prediction with its latency.
// Exec results are taken from the recording, so sequences don't actually run anywhere.
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { Brain } from "../src/brain.ts";
import { log } from "../src/log.ts";
import { makeDecider } from "../src/model.ts";

config({ path: new URL("../../.env", import.meta.url).pathname });
log.enabled = false;

const file = process.argv[2];
if (!file) {
    console.error("usage: npm run replay <session.jsonl> [--no-model]");
    process.exit(1);
}
const noModel = process.argv.includes("--no-model");
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { ts: number; from: string; msg: any });
const t0 = lines[0]?.ts ?? 0;
let at = 0;

const brain = new Brain({
    immediate: true,
    decider: noModel ? null : await makeDecider(),
    sendShell: (m) => {
        if (m.type === "ghost") console.log(`  ghost  ${m.ghost.kind.padEnd(7)} ${m.ghost.label}`);
    },
    sendWeb: (m) => {
        if (m.type !== "exec") console.log(`  → web  ${JSON.stringify(m)}`);
    },
    onPredict: ({ source, latencyMs, action }) =>
        console.log(`  ${source.padEnd(7)} ${latencyMs.toFixed(1).padStart(7)} ms  ${action ? `${action.label} (${action.confidence})` : "—"}`),
});

for (const { ts, from, msg } of lines) {
    at = ts - t0;
    const desc = msg.type === "user_event" ? `${msg.kind} ${msg.target?.label ?? ""} ${msg.value ?? ""}` : msg.type === "state" ? msg.url ?? msg.app : msg.type;
    console.log(`${(at / 1000).toFixed(1).padStart(6)}s ${from.padEnd(5)} ${desc}`);
    if (from === "shell") brain.fromShell(msg);
    else brain.fromWeb(msg);
    if (msg.type === "state" || msg.type === "user_event" || msg.type === "frontmost") await brain.predictNow();
}
