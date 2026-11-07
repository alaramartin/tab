// npm run flow4 [-- N] — flow 4's model steps on C's real captured pages (protocol/fixtures), N calls each.
// Offline (no screen); calls the decider (local by default). Reports min/median confidence per step against the 0.6 bar.
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import type { ScreenState } from "../../protocol/types.ts";
import type { HistEntry } from "../src/history.ts";
import { makeDecider } from "../src/model.ts";

config({ path: new URL("../../.env", import.meta.url).pathname, quiet: true });
const fx = (n: string): ScreenState => JSON.parse(readFileSync(new URL(`../../protocol/fixtures/${n}.json`, import.meta.url), "utf8"));
const N = Number(process.argv[2] ?? 5);
const inbox = fx("web_state_inbox");
const base = fx("web_state_pharmacy");
const C = base.app;

function form(rx: string, loc: string, time: string | null, sms: boolean): ScreenState {
    const s: ScreenState = JSON.parse(JSON.stringify(base));
    s.ts = inbox.ts = Date.now();
    for (const e of s.elements) {
        if (e.path === "#rx") e.value = rx;
        if (e.path === "#loc") e.value = loc;
        if (e.role === "button" && e.checked !== undefined) e.checked = e.label === time;
        if (e.path === "#sms") e.checked = sms;
    }
    return s;
}
const h = (op: HistEntry["op"], label: string, value?: string): HistEntry => ({ op, app: C, url: base.url, target: { id: "x", role: "other", label }, value, ts: Date.now() - 1500, by: "tab" });
// Noise from an earlier flow, as on stage (flows run back to back).
const earlier: HistEntry[] = [
    { op: "click", app: C, url: "http://tracker.localhost:4003/", target: { id: "s", role: "button", label: "Save" }, ts: Date.now() - 60_000, by: "tab" },
];

const steps = [
    { name: "1 Rx", s: form("", "Main St", null, false), h: [], want: /Type 4471-209/ },
    { name: "2 Oak St", s: form("4471-209", "Main St", null, false), h: [h("type", "Rx number", "4471-209")], want: /Select Oak St/ },
    { name: "3 5:30 pm", s: form("4471-209", "Oak St", null, false), h: [h("type", "Rx number", "4471-209"), h("type", "Pickup location", "Oak St")], want: /Click 5:30 pm/ },
    { name: "4 Text me", s: form("4471-209", "Oak St", "5:30 pm", false), h: [h("type", "Pickup location", "Oak St"), h("click", "5:30 pm")], want: /Text me when ready/ },
    { name: "5 Request", s: form("4471-209", "Oak St", "5:30 pm", true), h: [h("click", "5:30 pm"), h("click", "Text me when ready")], want: /Request refill/ },
];
const d = (await makeDecider())!;
let worst = 1;
for (const st of steps) {
    const confs: number[] = [];
    let wrong = 0;
    for (let i = 0; i < N; i++) {
        const a = await d.decide({ active: st.s, others: [st.s, inbox], history: [...earlier, ...st.h] });
        if (a && st.want.test(a.label)) confs.push(a.confidence);
        else wrong++, confs.push(0);
    }
    confs.sort((a, b) => a - b);
    worst = Math.min(worst, confs[0]);
    console.log(`${st.name.padEnd(10)} min ${confs[0].toFixed(2)}  median ${confs[Math.floor(N / 2)].toFixed(2)}  wrong ${wrong}/${N}`);
}
console.log(worst >= 0.6 ? "all steps clear 0.6" : `weakest step ${worst.toFixed(2)} (< 0.6)`);
