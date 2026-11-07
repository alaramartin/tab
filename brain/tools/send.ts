// Send protocol messages to the hub by hand, and print everything the hub sends out.
//
//   npm run send -- '{"type":"ghost", ...}'   raw JSON (speak as a side with "as":"shell"|"payments")
//   npm run send -- file.json                  a message or a JSON array of messages from a file
//   npm run send -- --listen                   just print hub traffic
//   npm run send -- --ghost                    draw a test ghost
//
// A message with "to":"shell"|"payments" is delivered to that side verbatim.
import { readFileSync, existsSync } from "node:fs";
import WebSocket from "ws";

const args = process.argv.slice(2);
const url = `ws://127.0.0.1:${process.env.HUB_PORT ?? 7800}`;
const ws = new WebSocket(url);

function load(a: string): unknown[] {
    const raw = existsSync(a) ? readFileSync(a, "utf8") : a;
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [v];
}

const listen = args.includes("--listen");
let msgs: unknown[] = [];
if (args[0] === "--ghost") {
    msgs = [{ to: "shell", msg: { type: "ghost", ghost: { id: "test", kind: "action", label: "Click Checkout ⇥", rect: { x: 200, y: 300, w: 120, h: 36 }, cursor: { x: 260, y: 318 } } } }];
} else if (!listen) {
    msgs = args.flatMap(load);
}

ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "tool" }));
    for (const m of msgs) ws.send(JSON.stringify(m));
    if (!listen) setTimeout(() => ws.close(), 300);
});
ws.on("message", (d) => console.log(String(d)));
ws.on("error", (e) => {
    console.error(`can't reach hub at ${url}: ${e.message}`);
    process.exit(1);
});
