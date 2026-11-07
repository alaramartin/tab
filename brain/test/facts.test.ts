import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, ScreenState } from "../../protocol/types.ts";
import { FactIndex, fits, kindOf, opposed } from "../src/memory/facts.ts";
import type { PastStep } from "../src/predict/types.ts";

const r = { x: 0, y: 0, w: 100, h: 20 };
const field = (label: string, extra: Partial<El> = {}): El => ({ id: `desc:${label}`, path: `desc:${label}`, role: "textfield", label, rect: r, enabled: true, ...extra });
const typed = (label: string, value: string, ts: number, app = "com.apple.Safari", window = "Apply"): PastStep => ({ ts, app, window, op: "type", by: "user", target: field(label), value });
const screen = (els: El[], app = "dev.other", window = "Signup"): ScreenState => ({ type: "state", source: "ax", app, window, focused: true, elements: els, seq: 1, ts: 0 });
const NOW = 1_800_000_000_000;

test("opposed labels never share a fact; kinds and shapes", () => {
    assert.equal(opposed("First name", "Last name"), true);
    assert.equal(opposed("Billing address", "Shipping address"), true);
    assert.equal(opposed("Email", "Work email"), false);
    assert.equal(kindOf("Work email"), "email");
    assert.equal(kindOf("Mobile phone"), "phone");
    assert.equal(fits("email", "jane@acme.com"), true);
    assert.equal(fits("email", "Jane"), false);
    assert.equal(fits("phone", "+1 (415) 555-0100"), true);
    assert.equal(fits("phone", "Acme"), false);
});

test("the same field label on another app fills with what was typed before (no embedding model needed)", () => {
    const f = new FactIndex(null);
    f.observe(typed("Employer", "Initech", NOW - 86_400_000));
    const s = screen([field("Employer", { focused: true }), field("Email")]);
    const c = f.predict({ now: NOW, active: s, recent: [], history: [] });
    assert.equal(c[0]?.action.value, "Initech");
    assert.equal(c[0]?.action.targetPath, "desc:Employer");
    assert.ok(c[0].score > 0.5, `score ${c[0].score}`);
});

test("a field with many different past values (a search box) gives no confident fill", () => {
    const f = new FactIndex(null);
    ["ENG-142", "ENG-150", "ENG-151", "ENG-155", "ENG-160"].forEach((v, i) => f.observe(typed("Search tickets", v, NOW - i * 1000)));
    const c = f.predict({ now: NOW, active: screen([field("Search tickets", { focused: true })]), recent: [], history: [] });
    assert.ok(!c.length || c[0].score < 0.3, `score ${c[0]?.score}`);
});

test("a value that doesn't fit the field's kind is never offered", () => {
    const f = new FactIndex(null);
    f.observe(typed("Contact", "Jane Doe", NOW - 1000)); // a name typed into "Contact"
    const c = f.predict({ now: NOW, active: screen([field("Contact", { focused: true, placeholder: "Email" })]), recent: [], history: [] });
    // same label, but this one is filled with a name: fine for a text field…
    assert.equal(c[0]?.action.value, "Jane Doe");
    const g = new FactIndex(null);
    g.observe(typed("Email", "Jane Doe", NOW - 1000)); // garbage once typed into an email field
    const d = g.predict({ now: NOW, active: screen([field("Email", { focused: true })]), recent: [], history: [] });
    assert.equal(d.length, 0, "…but never into an email field");
});

test("secure fields and long text never become facts", () => {
    const f = new FactIndex(null);
    f.observe({ ...typed("Password", "hunter2", NOW), target: field("Password", { secure: true }) });
    f.observe(typed("Notes", "x".repeat(500), NOW));
    assert.equal(f.size, 0);
});

test("autocomplete while typing: what was typed before, from the prefix", () => {
    const f = new FactIndex(null);
    f.observe(typed("Email", "jane@acme.com", NOW - 86_400_000));
    f.observe(typed("Email", "jane.doe@gmail.com", NOW - 10 * 86_400_000));
    f.observe(typed("Search", "javascript closures", NOW - 1000));
    const field = (v: string) => ({ ...(screen([]).elements[0] ?? {}), id: "desc:Email", path: "desc:Email", role: "textfield" as const, label: "Email", value: v, focused: true, rect: r, enabled: true });
    assert.equal(f.complete(field("j"), NOW), null, "one letter is not enough");
    const a = f.complete(field("jane@"), NOW)!;
    assert.equal(a.value, "jane@acme.com");
    assert.ok(a.score > 0.6, `"jane@" is unambiguous (${a.score.toFixed(2)})`);
    const b = f.complete(field("ja"), NOW)!;
    assert.ok(b.score < a.score, "a short, ambiguous prefix scores lower");
    assert.equal(f.complete(field("jane@acme.com"), NOW), null, "nothing left to complete");
});
