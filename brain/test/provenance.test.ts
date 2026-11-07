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
