import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, ScreenState } from "../../protocol/types.ts";
import { SequenceTier, valueRule } from "../src/predict/sequence.ts";
import type { PastStep } from "../src/predict/types.ts";

const r = { x: 0, y: 0, w: 50, h: 20 };
const cell = (row: number, value = ""): El => ({ id: `desc:Number#${row}`, path: `desc:Number#${row}`, role: "textfield", label: "Number", grid: { row, col: 1 }, rect: r, enabled: true, ...(value ? { value } : {}) });
const sheet = (filled: Record<number, string>): ScreenState => ({
    type: "state", source: "ax", app: "app", window: "Sheet", focused: true, seq: 1, ts: 0,
    elements: Array.from({ length: 8 }, (_, i) => cell(i, filled[i])),
});
const T = 1_000_000;
const typed = (row: number, value: string, k: number): PastStep => ({ ts: T + k * 2000, app: "app", window: "Sheet", op: "type", by: "user", target: cell(row), value });

test("value rules: numbers, prefixed ids with padding, constants; none for noise", () => {
    assert.equal(valueRule(["1", "2", "3"])!(1), "4");
    assert.equal(valueRule(["10", "20"])!(3), "50");
    assert.equal(valueRule(["ENG-141", "ENG-142"])!(1), "ENG-143");
    assert.equal(valueRule(["item 007", "item 008"])!(2), "item 010");
    assert.equal(valueRule(["Done", "Done"])!(1), "Done");
    assert.equal(valueRule(["1", "5", "2"]), null);
    assert.equal(valueRule(["abc", "def"]), null);
});

test("two numbered rows → the next row's number; three → also 'fill the remaining'", () => {
    const t = new SequenceTier();
    const h2 = [typed(0, "1", 0), typed(1, "2", 1)];
    let c = t.predict({ now: T + 5000, active: sheet({ 0: "1", 1: "2" }), recent: [], history: h2 });
    assert.equal(c[0].action.value, "3");
    assert.equal(c[0].action.targetPath, "desc:Number#2");
    assert.equal(c.length, 1, "no batch offer after two");
    const h3 = [...h2, typed(2, "3", 2)];
    c = t.predict({ now: T + 7000, active: sheet({ 0: "1", 1: "2", 2: "3" }), recent: [], history: h3 });
    assert.equal(c[0].action.value, "4");
    const batch = c.find((x) => x.action.op === "sequence")!;
    assert.equal(batch.action.steps!.length, 5);
    assert.equal(batch.action.label, "Fill the remaining 5 (4 … 8)");
    assert.equal(batch.action.steps!.at(-1)!.targetPath, "desc:Number#7");
});

test("no grid (a canvas sheet): the next value goes where focus moved", () => {
    const t = new SequenceTier();
    const flat = (k: number): PastStep => ({ ts: T + k * 2000, app: "app", op: "type", by: "user", target: { id: "canvas", path: "canvas", role: "other", label: "Sheet", rect: r, enabled: true }, value: String(k + 1) });
    const s: ScreenState = { type: "state", source: "ax", app: "app", window: "Sheet", focused: true, seq: 1, ts: 0, elements: [{ id: "canvas", path: "canvas", role: "other", label: "Sheet", rect: r, enabled: true, focused: true }] };
    const c = t.predict({ now: T + 9000, active: s, recent: [], history: [flat(0), flat(1), flat(2)] });
    assert.equal(c[0].action.value, "4");
    assert.equal(c[0].action.targetPath, "canvas");
});

test("an older run with another rule doesn't block a new one in the same column", () => {
    const t = new SequenceTier();
    const h = [typed(0, "1", 0), typed(1, "2", 1), typed(2, "10", 2), typed(3, "20", 3), typed(4, "30", 4)];
    const c = t.predict({ now: T + 11_000, active: sheet({ 0: "1", 1: "2", 2: "10", 3: "20", 4: "30" }), recent: [], history: h });
    assert.equal(c[0].action.value, "40");
    assert.equal(c[0].action.targetPath, "desc:Number#5");
});

test("generic candidates: a URL printed in a terminal becomes 'Open …', newest first", async () => {
    const { genericCandidates, urlsOnScreen } = await import("../src/predict/generic.ts");
    const term: ScreenState = {
        type: "state", source: "ax", app: "com.apple.Terminal", window: "zsh", focused: true, seq: 1, ts: 0,
        elements: [{ id: "id:term", path: "id:term", role: "textarea", label: "shell", focused: true, rect: r, enabled: true,
            value: "$ git push\nremote: Create a pull request for 'fix' on GitHub by visiting:\nremote:   https://github.com/a/b/pull/new/fix\n$ " }],
    };
    assert.deepEqual(urlsOnScreen(term), ["https://github.com/a/b/pull/new/fix"]);
    const c = genericCandidates({ now: 0, active: term, recent: [], history: [] });
    assert.ok(c.some((a) => a.op === "navigate" && a.value === "https://github.com/a/b/pull/new/fix" && a.label === "Open github.com/a/b/pull/new/fix"));
});

test("cloud tier: only long-text fields qualify, and it's off without TAB_CLOUD=1", async () => {
    const { isLongTextField, CloudWriter } = await import("../src/runtime/cloud.ts");
    const f = (role: El["role"], label: string): El => ({ id: label, role, label, rect: r, enabled: true });
    assert.equal(isLongTextField(f("textarea", "Leave a comment")), true);
    assert.equal(isLongTextField(f("textfield", "Description")), true);
    assert.equal(isLongTextField(f("textfield", "Email")), false);
    const prev = process.env.TAB_CLOUD;
    delete process.env.TAB_CLOUD;
    assert.equal(new CloudWriter().enabled, false);
    if (prev !== undefined) process.env.TAB_CLOUD = prev;
});
