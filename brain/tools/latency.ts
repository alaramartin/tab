// npm run latency [-- N]  — time N model calls on a synthetic pharmacy-form screen (M0: "model latency measured").
import { config } from "dotenv";
import type { ScreenState } from "../../protocol/types.ts";
import { makeDecider } from "../src/model.ts";

config({ path: new URL("../../.env", import.meta.url).pathname });

const n = Number(process.argv[2] ?? 5);
const r = { x: 0, y: 0, w: 100, h: 20 };
const now = Date.now();
const inbox: ScreenState = {
    type: "state", source: "web", app: "com.google.Chrome", window: "Inbox", url: "http://inbox.localhost:4004/", focused: false, seq: 1, ts: now,
    elements: [{ id: "m1", role: "text", label: "Rx 4471-209 is ready to refill at Oak St. Pick up after 5 pm.", rect: r, enabled: true }],
};
const pharmacy: ScreenState = {
    type: "state", source: "web", app: "com.google.Chrome", window: "Refill", url: "http://pharmacy.localhost:4005/refill", focused: true, seq: 1, ts: now,
    elements: [
        { id: "rx", role: "textfield", label: "Rx number", value: "", rect: r, enabled: true },
        { id: "loc", role: "select", label: "Pickup location", options: ["Main St", "Oak St", "Elm Ave"], value: "Main St", rect: r, enabled: true },
        { id: "t1", role: "button", label: "4:00 pm", checked: false, rect: r, enabled: true },
        { id: "t2", role: "button", label: "5:30 pm", checked: false, rect: r, enabled: true },
        { id: "t3", role: "button", label: "7:00 pm", checked: false, rect: r, enabled: true },
        { id: "sms", role: "checkbox", label: "Text me when ready", checked: false, rect: r, enabled: true },
        { id: "go", role: "button", label: "Request refill", rect: r, enabled: true },
    ],
};

const d = (await makeDecider());
if (!d) throw new Error("no decider (TAB_DECIDER=none?)");
console.log(`decider: ${d.name}`);
const times: number[] = [];
for (let i = 0; i < n; i++) {
    const t = performance.now();
    try {
        const a = await d.decide({ active: pharmacy, others: [inbox, pharmacy], history: [] });
        times.push(performance.now() - t);
        console.log(`${(performance.now() - t).toFixed(0).padStart(6)} ms  ${a ? `${a.label} → ${a.targetId} ${a.value ?? ""} (${a.confidence})` : "none"}`);
    } catch (err) {
        console.log(`error: ${(err as Error).message}`);
    }
}
if (times.length) {
    times.sort((a, b) => a - b);
    console.log(`median ${times[Math.floor(times.length / 2)].toFixed(0)} ms · max ${times.at(-1)!.toFixed(0)} ms · target ≤ 1500 ms`);
}
