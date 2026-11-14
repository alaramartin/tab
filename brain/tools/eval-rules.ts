// The rule trigger check on realistic screens from real tasks, before and after the step that finished them: a booking,
// a merged pull request, a submitted expense report, and near misses (a booking still at review, an approved but
// unmerged PR, a search, a saved file, an item added to a cart). Runs the local model on its own port.
//   npm run eval:rules
// Prints each case's pick, whether it's right, and how long it took (the first check is the cold one, unless warmed).
import type { El, ScreenState } from "../../protocol/types.ts";
import type { PastStep } from "../src/predict/types.ts";
import { LlamaRuleChecker, type Rule } from "../src/rules.ts";
import { LlamaServer, MODELS } from "../src/runtime/llama.ts";

const T = Date.now();
let n = 0;
const el = (role: El["role"], label: string, extra: Partial<El> = {}): El => ({ id: `e${++n}`, path: `e${n}`, role, label, rect: { x: 0, y: n * 20, w: 100, h: 20 }, enabled: true, ...extra });
const screen = (app: string, window: string, els: El[], url?: string): ScreenState => ({ type: "state", app, window, url, elements: els, seq: 1, ts: T });
const click = (app: string, label: string): PastStep => ({ ts: T - 800, app, op: "click", by: "user", target: el("button", label) });
const key = (app: string, k: string): PastStep => ({ ts: T - 800, app, op: "key", by: "user", value: k });
const typed = (app: string, field: string, v: string): PastStep => ({ ts: T - 3000, app, op: "type", by: "user", target: el("textfield", field), value: v });

const CHROME = "com.google.Chrome", MAIL = "com.apple.mail", NOTES = "com.apple.TextEdit";
const rules: Rule[] = [
    { id: "book", text: "booking an event adds it to Calendar", enabled: true, created: 0 },
    { id: "pr", text: "after merging a PR, post the link in Slack", enabled: true, created: 0 },
    { id: "expense", text: "submitting an expense report files the receipt in Finder", enabled: true, created: 0 },
];

interface Case { name: string; before: ScreenState; after: ScreenState; history: PastStep[]; want: string | null }
const cases: Case[] = [
    {
        name: "booking confirmed",
        before: screen(CHROME, "Checkout · Night Owls", [el("text", "Night Owls · Fri 9pm · 2 tickets"), el("text", "Total $42.00"), el("button", "Book now")], "https://tickets.example.com/checkout/881"),
        after: screen(CHROME, "Booking confirmed · Night Owls", [el("text", "You're going! Your booking is confirmed."), el("text", "Night Owls · Fri 9pm · 2 tickets"), el("text", "Confirmation #A-77812"), el("link", "Add to calendar"), el("button", "View tickets")], "https://tickets.example.com/orders/A-77812"),
        history: [click(CHROME, "Book now")],
        want: "book",
    },
    {
        name: "booking still at review (near miss)",
        before: screen(CHROME, "Night Owls · Tickets", [el("text", "Night Owls · Fri 9pm"), el("button", "Get tickets")], "https://tickets.example.com/events/night-owls"),
        after: screen(CHROME, "Review your order", [el("text", "Review your order"), el("text", "Night Owls · Fri 9pm · 2 tickets"), el("text", "Total $42.00"), el("button", "Continue to payment")], "https://tickets.example.com/checkout/881"),
        history: [click(CHROME, "Get tickets")],
        want: null,
    },
    {
        name: "pull request merged",
        before: screen(CHROME, "Fix checkout rounding by jane · Pull Request #13 · acme/shop", [el("text", "jane wants to merge 2 commits into main from fix-rounding"), el("text", "All checks have passed"), el("button", "Merge pull request"), el("button", "Confirm merge")], "https://github.com/acme/shop/pull/13"),
        after: screen(CHROME, "Fix checkout rounding by jane · Pull Request #13 · acme/shop", [el("text", "Merged"), el("text", "jane merged 2 commits into main from fix-rounding now"), el("text", "Pull request successfully merged and closed"), el("button", "Delete branch")], "https://github.com/acme/shop/pull/13"),
        history: [click(CHROME, "Merge pull request"), click(CHROME, "Confirm merge")],
        want: "pr",
    },
    {
        name: "pull request approved, not merged (near miss)",
        before: screen(CHROME, "Fix checkout rounding by jane · Pull Request #13 · acme/shop", [el("text", "Review changes"), el("checkbox", "Approve"), el("button", "Submit review")], "https://github.com/acme/shop/pull/13/files"),
        after: screen(CHROME, "Fix checkout rounding by jane · Pull Request #13 · acme/shop", [el("text", "you approved these changes"), el("text", "This branch has no conflicts with the base branch"), el("button", "Merge pull request")], "https://github.com/acme/shop/pull/13"),
        history: [click(CHROME, "Approve"), click(CHROME, "Submit review")],
        want: null,
    },
    {
        name: "expense report submitted",
        before: screen(CHROME, "New expense report · Expensify", [el("textfield", "Merchant", { value: "Blue Bottle" }), el("textfield", "Amount", { value: "18.50" }), el("button", "Submit report")], "https://www.expensify.com/report/new"),
        after: screen(CHROME, "Report #4471 · Expensify", [el("text", "Report submitted for approval"), el("text", "Blue Bottle · $18.50"), el("button", "Back to reports")], "https://www.expensify.com/report/4471"),
        history: [typed(CHROME, "Merchant", "Blue Bottle"), typed(CHROME, "Amount", "18.50"), click(CHROME, "Submit report")],
        want: "expense",
    },
    {
        name: "a search (near miss)",
        before: screen(CHROME, "Google", [el("textfield", "Search", { value: "night owls tickets" })], "https://www.google.com/"),
        after: screen(CHROME, "night owls tickets - Google Search", [el("text", "About 1,240,000 results"), el("link", "Night Owls · Tickets · tickets.example.com"), el("link", "Night Owls tour dates")], "https://www.google.com/search?q=night+owls+tickets"),
        history: [typed(CHROME, "Search", "night owls tickets"), key(CHROME, "Return")],
        want: null,
    },
    {
        name: "a file saved (near miss)",
        before: screen(NOTES, "Untitled", [el("textarea", "", { value: "Trip notes" })]),
        after: screen(NOTES, "trip-notes.txt", [el("textarea", "", { value: "Trip notes" })]),
        history: [key(NOTES, "cmd+s"), click(NOTES, "Save")],
        want: null,
    },
    {
        name: "an email sent (near miss)",
        before: screen(MAIL, "Re: Friday plans", [el("textfield", "To", { value: "sam@example.com" }), el("textarea", "Message", { value: "See you at 9!" }), el("button", "Send")]),
        after: screen(MAIL, "Inbox – iCloud", [el("text", "Re: Friday plans"), el("text", "Sam Lee · Yesterday")]),
        history: [click(MAIL, "Send")],
        want: null,
    },
    {
        name: "added to cart (near miss)",
        before: screen(CHROME, "Ceramic mug · Shop", [el("text", "Ceramic mug · $24"), el("button", "Add to cart")], "https://shop.example.com/p/mug"),
        after: screen(CHROME, "Ceramic mug · Shop", [el("text", "Added to cart"), el("text", "Ceramic mug · $24"), el("button", "View cart (1)")], "https://shop.example.com/p/mug"),
        history: [click(CHROME, "Add to cart")],
        want: null,
    },
];

// The testbed's form, with one rule (as in the live test): a submit, and a table edit that isn't one.
const TB = "exe:TabShell";
const form = (status: string) => screen(TB, "Tab Testbed", [el("textfield", "Full name", { value: "Jane Doe" }), el("textfield", "Email", { value: "jane@acme.com" }), el("textfield", "Employer", { value: "Initech" }), el("button", "Submit"), el("text", status)]);
const oneRule: Rule[] = [{ id: "copy", text: "submitting the form copies my details into the Sign up form", enabled: true, created: 0 }];
const single: Case[] = [
    { name: "testbed form submitted (one rule)", before: form("Nothing submitted yet"), after: form("Submitted at 00:24:34.536"), history: [typed(TB, "Employer", "Initech"), click(TB, "Submit")], want: "copy" },
    {
        name: "testbed: a different window opened (one rule)",
        before: form("Nothing submitted yet"),
        after: screen(TB, "Settings", [el("text", "Settings"), el("checkbox", "Dark mode"), el("button", "Done")]),
        history: [click(TB, "Gear")],
        want: null,
    },
];

const server = new LlamaServer(MODELS.qwen, 7814); // its own port: a running hub keeps 7811
if (!server.available()) {
    console.error(`model missing: ${server.path}`);
    process.exit(1);
}
await server.start();
const checker = new LlamaRuleChecker(server);
const warm = process.argv.includes("--warm");
if (warm) {
    const t0 = performance.now();
    await checker.warm();
    console.log(`warmed in ${(performance.now() - t0).toFixed(0)} ms`);
}
let right = 0;
const ms: number[] = [];
for (const c of [...cases, ...single]) {
    const t0 = performance.now();
    const m = await checker.check(single.includes(c) ? oneRule : rules, { now: T, active: c.after, before: c.before, history: c.history });
    const t = performance.now() - t0;
    ms.push(t);
    const got = m?.rule.id ?? null;
    const ok = got === c.want;
    if (ok) right++;
    console.log(`${ok ? "✓" : "✗"} ${c.name.padEnd(44)} ${String(got ?? "none").padEnd(8)} want ${String(c.want ?? "none").padEnd(8)} ${t.toFixed(0).padStart(5)} ms${m ? `  "${m.task}" (${m.score.toFixed(2)})` : ""}`);
}
const sorted = [...ms].sort((a, b) => a - b);
console.log(`\n${right}/${cases.length + single.length} right · first check ${ms[0].toFixed(0)} ms · median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms${warm ? " (warmed)" : " (cold start)"}`);
server.stop();
