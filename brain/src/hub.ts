// The hub: a websocket server on 127.0.0.1 (local only). TabShell connects as "shell", a payment detector as
// "payments", and dev tools (tools/send.ts) as anything else.
//   env TAB_DEBUG=1   message contents (ghost labels, typed values) and timings in the console; off: types only
//   env TAB_MEMORY=off   predict without saving anything to disk
//   env TAB_LLM=off   fast tiers only, no local LLM
import { config } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";
import type { HubToDetector, HubToShell } from "../../protocol/types.ts";
import { Brain } from "./brain.ts";
import { makeDecider } from "./model.ts";
import { DEFAULT_MEMORY_FILE, Memory } from "./memory/store.ts";
import { record } from "./pay/ledger.ts";
import { IconNamer } from "./runtime/icons.ts";
import type { LlamaServer } from "./runtime/llama.ts";

config({ path: new URL("../../.env", import.meta.url).pathname, quiet: true });

const PORT = Number(process.env.HUB_PORT ?? 7800);
const DEBUG = !!process.env.TAB_DEBUG;
type Role = "shell" | "payments" | "tool";
let shell: WebSocket | null = null;
let payments: WebSocket | null = null;
let lastActivity = Date.now();
const tools = new Set<WebSocket>(); // dev tools see all outbound traffic

function out(to: "shell" | "payments", m: HubToShell | HubToDetector): void {
    const s = JSON.stringify(m);
    const ws = to === "shell" ? shell : payments;
    if (ws && ws.readyState === ws.OPEN) ws.send(s);
    for (const t of tools) if (t.readyState === t.OPEN) t.send(JSON.stringify({ to, msg: m }));
    if (m.type === "hud") return;
    if (DEBUG) console.log(`[trace] ${Date.now()} → ${to} ${m.type}`);
    console.log(DEBUG ? `→ ${to} ${s.length > 200 ? s.slice(0, 200) + "…" : s}` : `→ ${to} ${m.type}`);
}

const memoryFile = process.env.TAB_MEMORY_FILE || DEFAULT_MEMORY_FILE;
const memory = process.env.TAB_MEMORY === "off" ? null : new Memory(memoryFile);

// Consolidate memory (old screens out, deltas re-keyed) at start and every 6 hours.
const consolidate = () => {
    if (!memory) return;
    try {
        const r = memory.consolidate();
        if (r.screens + r.steps) console.log(`[memory] consolidated: ${r.screens} old screens, ${r.steps} old steps removed (${r.rekeyed} re-keyed)`);
    } catch (err) {
        console.error("[memory] consolidate:", (err as Error).message);
    }
};
consolidate();
setInterval(consolidate, 6 * 3_600_000).unref();

const decider = await makeDecider({ memory });
// Load the local model in the background so the first prediction doesn't wait for it.
const warmed = (decider as { warm?: () => Promise<void> }).warm?.();
warmed?.then(
    () => console.log(`[decider] ${decider.name} ready`),
    (err: Error) => console.error(`[decider] model failed to start: ${err.message}`),
);

// Episode summaries while idle: every 10 minutes, if nothing happened for 2 minutes, summarise up to 5 finished tasks.
setInterval(async () => {
    const llm = (decider as { server?: LlamaServer | null }).server;
    if (!memory || !llm || Date.now() - lastActivity < 120_000) return;
    try {
        const { summarizeEpisodes } = await import("./memory/episodes.ts");
        const { Embedder } = await import("./memory/embed.ts");
        const n = await summarizeEpisodes(memory, llm, new Embedder(memory.db));
        if (n) console.log(`[memory] summarised ${n} episodes`);
    } catch (err) {
        console.error("[memory] summaries:", (err as Error).message);
    }
}, 10 * 60_000).unref();

const namer = new IconNamer();
// The user's rules (menu bar dropdown), checked by the local model, or by their words without it.
const { RuleBook, LlamaRuleChecker, KeywordRuleChecker, DEFAULT_RULES_FILE } = await import("./rules.ts");
const ruleServer = (decider as { server?: LlamaServer | null }).server;
const rules = { book: new RuleBook(process.env.TAB_RULES_FILE || DEFAULT_RULES_FILE), checker: ruleServer ? new LlamaRuleChecker(ruleServer) : new KeywordRuleChecker() };
// Warm the rule check once the model is up (the first check after start took ~5 s cold).
if (rules.checker instanceof LlamaRuleChecker) {
    const checker = rules.checker;
    warmed?.then(() => checker.warm()).catch(() => {});
}
let searchEmbedder: import("./memory/embed.ts").Embedder | null = null;
const brain = new Brain({
    sendShell: (m) => out("shell", m),
    sendDetector: (m) => out("payments", m),
    decider,
    memory,
    rules,
    searchMemory: memory
        ? async (query) => {
              const { searchEpisodes } = await import("./memory/episodes.ts");
              const { Embedder } = await import("./memory/embed.ts");
              searchEmbedder ??= new Embedder(memory.db);
              return (await searchEpisodes(memory, searchEmbedder, query)).map((e) => ({ ts: e.end_ts, app: e.app, summary: e.summary, steps: e.n_steps }));
          }
        : undefined,
    nameIcons: namer.server ? (items) => namer.name(items) : undefined,
    recordPayment: record,
    onPredict: ({ source, latencyMs, action }) =>
        console.log(`[predict] ${source} ${latencyMs.toFixed(1)} ms → ${action ? `${DEBUG ? action.label : action.op} (${action.confidence.toFixed(2)})` : "none"}`),
});

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("connection", (ws) => {
    let role: Role | null = null;
    ws.on("message", (data) => {
        let m: any;
        try {
            m = JSON.parse(String(data));
        } catch {
            return console.error("bad json:", String(data).slice(0, 100));
        }
        if (m.type === "hello") {
            role = m.role === "shell" ? "shell" : m.role === "payments" ? "payments" : "tool";
            if (role === "shell") shell = ws;
            else if (role === "payments") payments = ws;
            else tools.add(ws);
            console.log(`hello from ${role}`);
        }
        // Dev tools can deliver a message to either side ({"to": …, "msg": …}) or speak as one ({"as": …, …}).
        if (role === "tool" && (m.to === "shell" || m.to === "payments") && m.msg) return out(m.to, m.msg);
        if (m.type === "input" || m.type === "user_event") lastActivity = Date.now();
        if (DEBUG) console.log(`[trace] ${Date.now()} ← ${role} ${m.type}${m.kind ? ` ${m.kind}` : ""}${m.type === "state" ? ` ${m.app} ${m.elements?.length} els` : ""}`);
        const from = role === "tool" ? (m.as ?? "shell") : role;
        if (m.type !== "state" && m.type !== "user_event" && m.type !== "icon_request") console.log(DEBUG ? `← ${from} ${String(data).slice(0, 200)}` : `← ${from} ${m.type}`);
        try {
            if (from === "shell") brain.fromShell(m);
            else if (from === "payments") brain.fromDetector(m);
        } catch (err) {
            console.error(`[hub] error handling ${m.type}:`, err);
        }
    });
    ws.on("close", () => {
        if (ws === shell) shell = null;
        if (ws === payments) payments = null;
        tools.delete(ws);
        console.log(`${role ?? "client"} disconnected`);
    });
});

console.log(`hub listening on ws://127.0.0.1:${PORT} · ${decider.name} · memory: ${memory ? memoryFile : "off"}`);
process.on("unhandledRejection", (err) => console.error("[hub] unhandled:", err));
