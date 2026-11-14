import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HubToShell, ScreenState } from "../../protocol/types.ts";
import { Brain } from "../src/brain.ts";
import type { Decider, ModelInput } from "../src/model.ts";
import { KeywordRuleChecker, parseRule, parseRules, RuleBook, type RuleChecker } from "../src/rules.ts";
import { el } from "./screens.ts";

test("rules split into a trigger, a goal and the app the goal names", () => {
    assert.deepEqual(parseRule("booking an event adds it to calendar"), { trigger: "booking an event", goal: "Add it to calendar", app: "Calendar" });
    assert.deepEqual(parseRule("When I get an invoice, save it to Dropbox."), { trigger: "I get an invoice", goal: "Save it to Dropbox", app: "Dropbox" });
    assert.deepEqual(parseRule("after merging a PR → post in Slack"), { trigger: "merging a PR", goal: "Post in Slack", app: "Slack" });
    assert.deepEqual(parseRule("paying a bill copies the amount to Numbers"), { trigger: "paying a bill", goal: "Copy the amount to Numbers", app: "Numbers" });
    assert.deepEqual(parseRule("archive newsletters"), { trigger: "archive newsletters", goal: "Archive newsletters" });
});

test("the hub reads rules from the file, and again when it changes", () => {
    const f = join(mkdtempSync(join(tmpdir(), "tab-rules-")), "rules.json");
    const book = new RuleBook(f);
    assert.deepEqual(book.list(), [], "no file yet: no rules");
    writeFileSync(f, JSON.stringify({ rules: [{ id: "a", text: "booking an event adds it to Calendar", enabled: false, created: 1 }, { id: "b", text: "after merging a PR, post in Slack", enabled: true, created: 2 }] }));
    assert.deepEqual(book.list().map((x) => [x.text, x.enabled]), [["booking an event adds it to Calendar", false], ["after merging a PR, post in Slack", true]]);
    assert.deepEqual(book.enabled().map((x) => x.id), ["b"]);
    writeFileSync(f, JSON.stringify(["paying rent logs it in Numbers"]));
    utimesSync(f, new Date(), new Date(Date.now() + 5000)); // a different mtime, as a later save has
    assert.deepEqual(book.list().map((x) => x.text), ["paying rent logs it in Numbers"], "a plain list of strings works too");
    writeFileSync(f, "{ not json");
    utimesSync(f, new Date(), new Date(Date.now() + 10000));
    assert.equal(book.list().length, 1, "a broken file keeps the last good rules");
    assert.deepEqual(parseRules({ rules: [{ text: "  " }, 3, { text: "ok" }] }).map((r) => r.text), ["ok"]);
});

const T = Date.now();
const confirmed = (): ScreenState => ({
    type: "state", app: "com.google.Chrome", window: "Booking confirmed", seq: 1, ts: T,
    elements: [el("text:Your booking is confirmed", "text", "Your booking is confirmed"), el("text:Night Owls", "text", "Event: Night Owls · Fri 9pm"), el("desc:Done", "button", "Done")],
});

test("without the model, a rule matches when the words of its trigger are on screen", async () => {
    const c = new KeywordRuleChecker();
    const rules = [{ id: "a", text: "booking an event adds it to Calendar", enabled: true, created: 0 }];
    const m = await c.check(rules, { now: T, active: confirmed(), history: [] });
    assert.equal(m?.rule.id, "a");
    assert.equal(await c.check([{ id: "b", text: "paying a bill copies it to Numbers", enabled: true, created: 0 }], { now: T, active: confirmed(), history: [] }), null);
});

test("a matching rule is offered as a ghost; accepting it opens the app and the model's ghosts work toward the goal", async () => {
    const shell: HubToShell[] = [];
    const goals: (string | undefined)[] = [];
    let b!: Brain;
    const checker: RuleChecker = {
        async check(rules) {
            const rule = rules[0];
            return { rule, parsed: parseRule(rule.text), score: 0.9, task: "Add Night Owls · Fri 9pm to Calendar" };
        },
    };
    const decider: Decider = {
        name: "test",
        async decide(m: ModelInput) {
            goals.push(m.goal);
            return m.goal ? { op: "click", app: m.active.app, targetId: "desc:New Event", targetPath: "desc:New Event", label: "Click New Event", confidence: 0.5, source: "model" } : null;
        },
    };
    b = new Brain({
        immediate: true,
        decider,
        rules: { book: new RuleBook([{ id: "r1", text: "booking an event adds it to Calendar", enabled: true, created: 0 }]), checker },
        sendShell: (m) => {
            shell.push(m);
            if (m.type === "exec") queueMicrotask(() => b.fromShell({ type: "exec_result", ghostId: m.ghostId, ok: true }));
        },
    });
    const hud = () => (shell.filter((m) => m.type === "hud").at(-1) as any).hud;

    b.fromShell({ type: "frontmost", app: "com.google.Chrome", window: "Booking confirmed" });
    b.fromShell(confirmed());
    b.fromShell({ type: "user_event", app: "com.google.Chrome", kind: "click", target: el("desc:Book", "button", "Book"), ts: T });
    await b.predictNow();
    const ghost = (shell.filter((m) => m.type === "ghost").at(-1) as any)?.ghost;
    assert.equal(ghost?.label, "Add Night Owls · Fri 9pm to Calendar ⇥");

    b.fromShell({ type: "accept", ghostId: ghost.id });
    await new Promise((r) => setTimeout(r, 10));
    const exec = shell.find((m) => m.type === "exec") as any;
    assert.deepEqual([exec?.action.op, exec?.action.app], ["switch_app", "name:Calendar"]);
    assert.equal(hud().goal, "Add Night Owls · Fri 9pm to Calendar");

    // In Calendar: the model's step toward the goal is offered, even at 0.5.
    b.fromShell({ type: "frontmost", app: "com.apple.iCal", window: "Calendar" });
    b.fromShell({ type: "state", app: "com.apple.iCal", window: "Calendar", seq: 2, ts: T + 100, elements: [el("desc:New Event", "button", "New Event")] });
    await b.predictNow();
    assert.equal(goals.at(-1), "Add Night Owls · Fri 9pm to Calendar");
    const step = (shell.filter((m) => m.type === "ghost").at(-1) as any).ghost;
    assert.equal(step.label, "Click New Event ⇥");

    // Esc on a step stops working toward the goal.
    b.fromShell({ type: "dismiss", ghostId: step.id });
    assert.equal(hud().goal, undefined);
});

test("a goal ranks the controls it names first", async () => {
    const { goalWants } = await import("../src/predict/generic.ts");
    const b = (label: string) => el(`desc:${label}`, "button", label);
    const goal = "Add 12 and 30 in Calculator";
    assert.deepEqual(["1", "2", "3", "0", "+", "=", "7", "AC", "×"].filter((l) => goalWants(goal, b(l))), ["1", "2", "3", "0", "+", "="]);
    assert.ok(goalWants("Add Night Owls to Calendar", b("New Event")) === false);
    assert.ok(goalWants("Save the receipt to Finder", b("Save")));
    assert.ok(!goalWants(undefined, b("Save")));
});

test("what an app showed in response: title, text and controls, not the user's own field edits", async () => {
    const { visibleChanges } = await import("../src/rules.ts");
    const form = (status: string, cell = ""): ScreenState => ({
        type: "state", app: "x", window: "Form", seq: 1, ts: T,
        elements: [el("desc:Number", "textfield", "Number", { value: cell }), el("text:status", "text", status), el("desc:Submit", "button", "Submit")],
    });
    assert.deepEqual(visibleChanges(form("Nothing submitted yet"), form("Nothing submitted yet", "5")), { added: [], removed: [] });
    assert.deepEqual(visibleChanges(form("Nothing submitted yet"), form("Submitted at 00:06")), { added: ['text "Submitted at 00:06"'], removed: ['text "Nothing submitted yet"'] });
});
