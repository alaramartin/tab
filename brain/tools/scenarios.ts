// npm run scenarios — every model-driven demo step on synthetic screens, live against the model.
// Prints expected vs. picked, confidence, and latency. Swap in C's real fixtures when they land.
import { config } from "dotenv";
import type { El, ScreenState } from "../../protocol/types.ts";
import type { HistEntry } from "../src/history.ts";
import { makeDecider } from "../src/model.ts";

config({ path: new URL("../../.env", import.meta.url).pathname, quiet: true });

const C = "com.google.Chrome";
const r = { x: 0, y: 0, w: 100, h: 20 };
let n = 0;
const el = (role: El["role"], label: string, extra: Partial<El> = {}): El => ({ id: `e${++n}`, role, label, rect: r, enabled: true, path: `#e${n}`, ...extra });
const web = (url: string, window: string, elements: El[]): ScreenState => ({ type: "state", source: "web", app: C, window, url, focused: true, elements, seq: 1, ts: Date.now() });
const h = (op: HistEntry["op"], label: string, value?: string): HistEntry => ({ op, app: C, target: { id: "x", role: "other", label }, value, ts: Date.now() - 2000, by: "user" });

const inbox = web("http://inbox.localhost:4004/", "Inbox", [
    el("link", "Inbox"), el("link", "Sent"), el("text", "Oak St Pharmacy"), el("text", "Your prescription is ready"),
    el("text", "Rx 4471-209 is ready to refill at Oak St. Pick up after 5 pm."),
    el("text", "Want a heads-up? Ask us to text you when it's ready."),
]);
const pharm = (rx: string, loc: string, time: string | null, sms: boolean) =>
    web("http://pharmacy.localhost:4005/refill", "Refill a prescription", [
        el("text", "Refill a prescription"),
        el("textfield", "Rx number", { value: rx }),
        el("select", "Pickup location", { value: loc, options: ["Main St", "Oak St", "Elm Ave"] }),
        ...["4:00 pm", "5:30 pm", "7:00 pm"].map((t, i) => el("button", t, { checked: t === time, list: { key: "chips", index: i } })),
        el("checkbox", "Text me when ready", { checked: sms }),
        el("button", "Request refill"),
    ]);
const tickets = web("http://tickets.localhost:4001/e/night-owls", "Night Owls · Hall 9", [
    el("link", "Events"), el("link", "Sign in"), el("text", "Night Owls · live at Hall 9 · Fri 9pm"), el("text", "General admission $0.15"),
    el("select", "Qty", { value: "2", options: ["1", "2", "3", "4"] }), el("button", "Checkout"),
]);
const checkout = web("http://tickets.localhost:4001/checkout?qty=2", "Checkout", [
    el("link", "Events"), el("text", "2 × General admission"), el("text", "Total $0.30"), el("link", "Back to event"), el("button", "Buy tickets"),
]);
const term: ScreenState = {
    type: "state", source: "native", app: "com.apple.Terminal", window: "zsh", focused: true, seq: 1, ts: Date.now(),
    elements: [{ id: "term", role: "textarea", label: "Terminal", rect: r, enabled: true, value: [
        "$ git push -u origin fix/checkout-rounding", "Enumerating objects: 9, done.", "Writing objects: 100% (6/6), 812 bytes | 812.00 KiB/s, done.",
        "remote:", "remote: Create a pull request for 'fix/checkout-rounding' on GitHub by visiting:",
        "remote:      https://github.com/acme/shop/pull/new/fix/checkout-rounding", "remote:",
        "To https://github.com/acme/shop.git", " * [new branch]      fix/checkout-rounding -> fix/checkout-rounding",
        "branch 'fix/checkout-rounding' set up to track 'origin/fix/checkout-rounding'.", "$ ",
    ].join("\n") }],
};
const gh = (body: string) => web("https://github.com/acme/shop/compare/main...fix/checkout-rounding?expand=1", "Comparing main...fix/checkout-rounding · acme/shop", [
    el("link", "Code"), el("link", "Issues"), el("link", "Pull requests"), el("link", "Actions"),
    el("text", "Open a pull request"),
    el("textfield", "Add a title", { value: "Fix/checkout rounding" }),
    el("textarea", "Add a description", { value: body, path: "#pull_request_body" }),
    el("button", "Create pull request"), el("button", "Create draft pull request"),
    el("link", "Round checkout totals to cents", { path: "div.commits > ol > li:nth-child(1) a.commit-message", list: { key: "div.commits > ol", index: 0, field: "a" } }),
    el("link", "Add rounding test", { path: "div.commits > ol > li:nth-child(2) a.commit-message", list: { key: "div.commits > ol", index: 1, field: "a" } }),
    el("button", "Reviewers"), el("button", "Assignees"), el("button", "Labels"),
]);

const cases: { name: string; active: ScreenState; others: ScreenState[]; history: HistEntry[]; expect: RegExp }[] = [
    { name: "tickets: Qty set → Checkout", active: tickets, others: [], history: [h("type", "Qty", "2")], expect: /Click Checkout/ },
    { name: "checkout → Buy tickets", active: checkout, others: [tickets], history: [h("type", "Qty", "2"), h("click", "Checkout")], expect: /Click Buy tickets/ },
    { name: "terminal push → Open PR", active: term, others: [], history: [], expect: /Open pull request/ },
    { name: "github → write description", active: gh(""), others: [term], history: [h("navigate", "", "https://github.com/acme/shop/pull/new/fix/checkout-rounding")], expect: /Write description/ },
    { name: "github → Create pull request", active: gh("Round checkout totals…"), others: [term], history: [h("type", "Add a description", "Round checkout totals…")], expect: /Click Create pull request$/ },
    { name: "pharmacy 1: Rx", active: pharm("", "Main St", null, false), others: [inbox], history: [], expect: /Type 4471-209/ },
    { name: "pharmacy 2: location", active: pharm("4471-209", "Main St", null, false), others: [inbox], history: [h("type", "Rx number", "4471-209")], expect: /Select Oak St/ },
    { name: "pharmacy 3: time", active: pharm("4471-209", "Oak St", null, false), others: [inbox], history: [h("type", "Rx number", "4471-209"), h("type", "Pickup location", "Oak St")], expect: /Click 5:30 pm/ },
    { name: "pharmacy 4: text me", active: pharm("4471-209", "Oak St", "5:30 pm", false), others: [inbox], history: [h("type", "Pickup location", "Oak St"), h("click", "5:30 pm")], expect: /Check "Text me when ready"/ },
    { name: "pharmacy 5: submit", active: pharm("4471-209", "Oak St", "5:30 pm", true), others: [inbox], history: [h("click", "5:30 pm"), h("click", "Text me when ready")], expect: /Click Request refill/ },
];

const d = (await makeDecider());
if (!d) throw new Error("no decider (TAB_DECIDER=none?)");
let pass = 0;
for (const c of cases) {
    const t = performance.now();
    const a = await d.decide({ active: c.active, others: [c.active, ...c.others], history: c.history }).catch((e) => (console.log(e.message), null));
    const ms = performance.now() - t;
    const ok = !!a && c.expect.test(a.label) && a.confidence >= 0.6;
    if (ok) pass++;
    console.log(`${ok ? "✔" : "✘"} ${c.name.padEnd(30)} ${(a ? `${a.label} (${a.confidence.toFixed(2)})` : "none").padEnd(46)} ${ms.toFixed(0).padStart(4)} ms`);
}
console.log(`${pass}/${cases.length} correct and shown (≥ 0.6)`);
