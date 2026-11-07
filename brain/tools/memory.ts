// Inspect and manage the action memory.
//   npm run memory -- stats                     counts, size, steps per app
//   npm run memory -- steps [N] [--app <id>]    the last N steps (default 30), oldest first
//   npm run memory -- forget --app <id> | --since <ISO time or "1h"/"2d">
//   npm run memory -- summarize [--limit N]      one-line summaries of finished episodes (local LLM), embedded
//   npm run memory -- episodes [N]              the latest summaries
//   npm run memory -- search <words>            episodes by meaning ("the form I filled", "pharmacy refill")
//   npm run memory -- consolidate [--screen-days 30] [--step-days 90]   what the hub runs every 6 hours
//   npm run memory -- import [session.jsonl ...]  seed from brain/logs/session-*.jsonl (default: all of them)
// Env TAB_MEMORY_FILE overrides ~/.tab/memory.db.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScreenState, UserEvent } from "../../protocol/types.ts";
import { DEFAULT_MEMORY_FILE, Memory } from "../src/memory/store.ts";

const args = process.argv.slice(2);
const cmd = args[0] ?? "stats";
const flag = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};
const mem = new Memory(process.env.TAB_MEMORY_FILE || DEFAULT_MEMORY_FILE);

function since(s: string): number {
    const m = /^(\d+)([mhd])$/.exec(s);
    if (m) return Date.now() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`bad time: ${s}`);
    return t;
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

if (cmd === "stats") {
    const s = mem.stats();
    console.log(`${mem.file}`);
    console.log(`steps ${s.steps} · episodes ${s.episodes} · ghosts ${s.ghosts}`);
    console.log(`screens ${s.snapshots} distinct of ${s.seen} seen (${s.seen ? ((1 - s.snapshots / s.seen) * 100).toFixed(0) : 0}% deduplicated) · ${kb(s.bytes)} compressed`);
    for (const a of s.byApp.slice(0, 15)) console.log(`  ${String(a.n).padStart(6)}  ${a.app}`);
} else if (cmd === "steps") {
    const n = Number(args[1]) || 30;
    const rows = mem.steps({ app: flag("--app") });
    for (const r of rows.slice(-n)) {
        const t = new Date(r.ts).toLocaleTimeString();
        const tgt = r.target ? `${r.target.role} "${r.target.label}"${r.target.section ? ` in ${r.target.section}` : ""}` : "";
        console.log(`${t} ${r.by.padEnd(4)} ${r.app.padEnd(28).slice(0, 28)} ${r.op.padEnd(5)} ${tgt}${r.value ? ` = ${JSON.stringify(r.value.slice(0, 60))}` : ""}`);
    }
} else if (cmd === "forget") {
    const app = flag("--app");
    const s = flag("--since");
    const n = mem.forget({ app, since: s ? since(s) : undefined });
    console.log(`forgot ${n} steps${app ? ` from ${app}` : ""}${s ? ` since ${new Date(since(s)).toLocaleString()}` : ""}`);
} else if (cmd === "summarize") {
    const { summarizeEpisodes } = await import("../src/memory/episodes.ts");
    const { Embedder } = await import("../src/memory/embed.ts");
    const { LlamaServer, MODELS } = await import("../src/runtime/llama.ts");
    const llm = new LlamaServer(MODELS[process.env.TAB_MODEL || "qwen"], 7819);
    const emb = new Embedder(mem.db);
    const n = await summarizeEpisodes(mem, llm, emb, { limit: Number(flag("--limit") ?? 20), now: Date.now() + 3_600_000 });
    console.log(`summarised ${n} episodes`);
    llm.stop();
    emb.server?.stop();
} else if (cmd === "episodes") {
    for (const e of mem.episodes(Number(args[1]) || 20)) console.log(`${new Date(e.start_ts).toLocaleString()}  ${String(e.n_steps).padStart(3)} steps  ${e.app.padEnd(24).slice(0, 24)}  ${e.summary}`);
} else if (cmd === "search") {
    const { searchEpisodes } = await import("../src/memory/episodes.ts");
    const { Embedder } = await import("../src/memory/embed.ts");
    const emb = new Embedder(mem.db);
    for (const e of await searchEpisodes(mem, emb, args.slice(1).join(" "))) console.log(`${e.sim.toFixed(2)}  ${new Date(e.start_ts).toLocaleString()}  ${e.summary}`);
    emb.server?.stop();
} else if (cmd === "consolidate") {
    const before = mem.stats();
    const r = mem.consolidate({ screenDays: Number(flag("--screen-days") ?? 30), stepDays: Number(flag("--step-days") ?? 90) });
    const after = mem.stats();
    console.log(`removed ${r.screens} screens (${r.rekeyed} re-keyed), ${r.steps} steps, ${r.ghosts} ghosts · screens ${before.snapshots} → ${after.snapshots}, ${kb(before.bytes)} → ${kb(after.bytes)}`);
} else if (cmd === "import") {
    const dir = new URL("../logs/", import.meta.url).pathname;
    const files = args.length > 1 ? args.slice(1) : readdirSync(dir).filter((f) => f.startsWith("session-") && f.endsWith(".jsonl")).sort().map((f) => join(dir, f));
    let states = 0, events = 0;
    for (const f of files) {
        for (const line of readFileSync(f, "utf8").split("\n")) {
            if (!line) continue;
            let rec: { ts: number; from: string; msg: any };
            try {
                rec = JSON.parse(line);
            } catch {
                continue;
            }
            const m = rec.msg;
            if (m?.type === "state") {
                mem.putState(m as ScreenState, rec.ts);
                states++;
            } else if (m?.type === "user_event" && m.kind !== "focus") {
                const e = m as UserEvent;
                mem.addStep({ ts: e.ts ?? rec.ts, app: e.app, url: e.url, window: e.window, op: e.kind, by: "user", target: e.target, value: e.value, before: e.before });
                events++;
            }
        }
    }
    console.log(`imported ${files.length} files: ${states} states, ${events} user events`);
    const s = mem.stats();
    console.log(`memory now: ${s.steps} steps, ${s.snapshots} distinct screens of ${s.seen} seen, ${kb(s.bytes)}`);
} else {
    console.log("usage: npm run memory -- stats | steps [N] [--app id] | forget --app id | --since 2h | import [files]");
}
mem.close();
process.exit(0); // model servers this tool started are stopped on exit
