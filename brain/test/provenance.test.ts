import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, ScreenState } from "../../protocol/types.ts";
import { HabitModel } from "../src/memory/habits.ts";
import { deriveProvenance } from "../src/memory/provenance.ts";
import type { PastStep } from "../src/predict/types.ts";

const r = { x: 0, y: 0, w: 100, h: 20 };
const el = (id: string, role: El["role"], label: string, extra: Partial<El> = {}): El => ({ id, path: id, role, label, rect: r, enabled: true, ...extra });
const T = 1_800_000_000_000;
const screen = (app: string, window: string, els: El[], ts = T): ScreenState => ({ type: "state", app, window, elements: els, seq: 1, ts });

test("copied: the value was in a field on a recent screen (not the field being typed into)", () => {
    const order = screen("com.shop", "Order confirmed", [el("desc:Order number", "textfield", "Order number", { value: "A-77812" })]);
    const target = el("desc:Reference", "textfield", "Reference");
    const p = deriveProvenance("A-77812", target, T + 1000, [order], []);
    assert.equal(p.kind, "copied");
    assert.deepEqual(p.kind === "copied" && p.from, { app: "com.shop", window: "Order confirmed", role: "textfield", label: "Order number", attr: "value" });
});

test("sequence, repeated, literal", () => {
    const cell = el("desc:Number", "textfield", "Number", { grid: { row: 3, col: 1 } });
    const prev: PastStep = { ts: T - 1000, app: "a", op: "type", by: "user", target: el("desc:Number#2", "textfield", "Number", { grid: { row: 2, col: 1 } }), value: "30" };
    assert.equal(deriveProvenance("40", cell, T, [], [prev]).kind, "sequence");
    const email = el("desc:Email", "textfield", "Email");
    const before: PastStep = { ts: T - 1000, app: "a", op: "type", by: "user", target: email, value: "jane@acme.com" };
    assert.equal(deriveProvenance("jane@acme.com", email, T, [], [before]).kind, "repeated");
    assert.equal(deriveProvenance("something new", email, T, [], [before]).kind, "literal");
});

test("a habit whose value is always copied from the same field fills that field's current value", () => {
    const h = new HabitModel();
    const W = "Ticket";
    let t = T;
    for (const n of ["1001", "1002", "1003", "1004"]) {
        const src = screen("com.helpdesk", W, [el("desc:Order ID", "textfield", "Order ID", { value: n }), el("desc:Refund ref", "textfield", "Refund ref")]);
        const prov = deriveProvenance(n, el("desc:Refund ref", "textfield", "Refund ref"), t, [src], []);
        h.observe({ ts: (t += 5000), app: "com.helpdesk", window: W, op: "click", by: "user", target: el("desc:Refund", "button", "Refund") });
        h.observe({ ts: (t += 5000), app: "com.helpdesk", window: W, op: "type", by: "user", target: el("desc:Refund ref", "textfield", "Refund ref"), value: n, prov });
    }
    h.observe({ ts: (t += 5000), app: "com.helpdesk", window: W, op: "click", by: "user", target: el("desc:Refund", "button", "Refund") });
    const now = screen("com.helpdesk", W, [el("desc:Order ID", "textfield", "Order ID", { value: "2077" }), el("desc:Refund ref", "textfield", "Refund ref")], t);
    const c = h.predict({ now: t + 500, active: now, recent: [], history: [] });
    const fill = c.find((x) => x.action.op === "type");
    assert.equal(fill?.action.value, "2077", "the order ID on screen now, not one typed before");
});

test("transforms: case, digits, dates", async () => {
    const { findTransform, applyTransform } = await import("../src/memory/transform.ts");
    assert.equal(findTransform("acme corp", "ACME CORP"), "upper");
    assert.equal(findTransform("JANE DOE", "Jane Doe"), "title");
    assert.equal(findTransform("(555) 123-4567", "5551234567"), "digits");
    assert.equal(findTransform("2026-11-11", "11/11/2026"), "date:m/d/yyyy");
    assert.equal(findTransform("Nov 3, 2026", "2026-11-03"), "date:yyyy-mm-dd");
    assert.equal(findTransform("2026-03-04", "4/3/2026"), "date:d/m/yyyy");
    assert.equal(findTransform("hello", "world"), undefined);
    assert.equal(findTransform("12", "12"), undefined);
    assert.equal(applyTransform("date:month d, yyyy", "2027-01-09"), "January 9, 2027");
    assert.equal(applyTransform("digits", "+1 (415) 555-0100"), "14155550100");
    assert.equal(applyTransform("date:yyyy-mm-dd", "not a date"), undefined);
});

test("copied with a transform: a date on screen typed in another format", () => {
    const inv = screen("com.books", "Invoice", [el("desc:Due", "textfield", "Due date", { value: "2026-12-01" })]);
    const p = deriveProvenance("12/1/2026", el("desc:Pay by", "textfield", "Pay by"), T + 1000, [inv], []);
    assert.equal(p.kind, "copied");
    assert.equal(p.kind === "copied" && p.transform, "date:m/d/yyyy");
});

const facts = (list: { label: string; value: string }[]) => ({
    known: () => list,
    latest: (label: string) => list.find((f) => f.label.toLowerCase() === label.toLowerCase())?.value,
});

test("fact: a value typed before into a different kind of field, as typed or rewritten", () => {
    const f = facts([{ label: "Email", value: "jane@acme.com" }, { label: "Company", value: "Acme Corp" }]);
    const contact = el("desc:Contact", "textfield", "Contact");
    assert.deepEqual(deriveProvenance("jane@acme.com", contact, T, [], [], f), { kind: "fact", label: "Email" });
    assert.deepEqual(deriveProvenance("ACME CORP", el("desc:Org", "textfield", "Organisation"), T, [], [], f), { kind: "fact", label: "Company", transform: "upper" });
    // The same field again is "repeated", not a fact.
    assert.equal(deriveProvenance("nobody@x.io", contact, T, [], [], f).kind, "literal");
});

test("a habit whose value is always a known fact, rewritten, fills that fact's newest value", () => {
    const list: { label: string; value: string }[] = [];
    const h = new HabitModel(facts(list));
    const W = "Expense";
    let t = T;
    for (const co of ["Initech", "Hooli", "Umbrella"]) {
        list.unshift({ label: "Company", value: co }); // typed into a Company field elsewhere
        const prov = deriveProvenance(co.toUpperCase(), el("desc:Vendor", "textfield", "Vendor"), t, [], [], facts(list));
        assert.equal(prov.kind, "fact");
        h.observe({ ts: (t += 5000), app: "com.exp", window: W, op: "click", by: "user", target: el("desc:New", "button", "New") });
        h.observe({ ts: (t += 5000), app: "com.exp", window: W, op: "type", by: "user", target: el("desc:Vendor", "textfield", "Vendor"), value: co.toUpperCase(), prov });
    }
    list.unshift({ label: "Company", value: "Globex" }); // the fact changed since
    h.observe({ ts: (t += 5000), app: "com.exp", window: W, op: "click", by: "user", target: el("desc:New", "button", "New") });
    const now = screen("com.exp", W, [el("desc:Vendor", "textfield", "Vendor")], t);
    const fill = h.predict({ now: t + 500, active: now, recent: [], history: [] }).find((x) => x.action.op === "type");
    assert.equal(fill?.action.value, "GLOBEX");
});
