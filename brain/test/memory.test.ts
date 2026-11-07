import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, ScreenState } from "../../protocol/types.ts";
import { redact } from "../src/memory/redact.ts";
import { elSig, norm, screenKind } from "../src/memory/sig.ts";
import { Memory } from "../src/memory/store.ts";

const T0 = 1_700_000_000_000;
const el = (p: Partial<El> & { id: string }): El => ({ role: "textfield", label: "", rect: { x: 0, y: 0, w: 10, h: 10 }, enabled: true, path: p.id, ...p });
const state = (app: string, els: El[], ts: number, window = "Form"): ScreenState => ({
    type: "state", app, window, elements: els, seq: 1, ts,
});

test("redact: Luhn cards, SSNs and API keys; leaves ordinary numbers", () => {
    assert.equal(redact("card 4242 4242 4242 4242 ok"), "card [card] ok");
    assert.equal(redact("order 1234567890123"), "order 1234567890123"); // fails Luhn
    assert.equal(redact("ssn 123-45-6789"), "ssn [ssn]");
    assert.equal(redact("key sk-ant-abcdefghijklmnopqrstuv"), "key [secret]");
    assert.equal(redact("ENG-142 at 5:30 pm"), "ENG-142 at 5:30 pm");
});

test("signatures fold digits and ignore geometry", () => {
    assert.equal(norm("Row 12"), norm("Row 13"));
    const a = elSig("com.apple.Numbers", { role: "cell", label: "", grid: { row: 3, col: 1 } });
    const b = elSig("com.apple.Numbers", { role: "cell", label: "", grid: { row: 9, col: 1 } });
    assert.equal(a, b, "same column, different rows: same kind of target");
    assert.equal(screenKind({ app: "c", url: "https://github.com/a/b/pull/123/files" }), "c|github.com/a/b/pull/#/files");
});

test("snapshots are stored once however often the screen repeats; moves don't make new ones", () => {
    const m = new Memory(":memory:");
    const els = [el({ id: "desc:Employer", label: "Employer" })];
    const h1 = m.putState(state("app", els, T0));
    const h2 = m.putState(state("app", [{ ...els[0], rect: { x: 50, y: 50, w: 10, h: 10 } }], T0 + 10));
    const h3 = m.putState(state("app", els, T0 + 20));
    assert.equal(h1, h2);
    assert.equal(h1, h3);
    const st = m.stats();
    assert.equal(st.snapshots, 1);
    assert.equal(st.seen, 3);
    assert.deepEqual(m.snapshot(h1)!.els, [{ r: "textfield", l: "Employer", p: "desc:Employer" }]);
});

test("steps get before/after screens, redacted values, value-free targets; secure fields keep nothing", () => {
    const m = new Memory(":memory:");
    const empty = el({ id: "desc:Card", label: "Card number" });
    const before = m.putState(state("shop", [empty], T0));
    m.addStep({ ts: T0 + 100, app: "shop", window: "Checkout", op: "type", by: "user", target: { ...empty, value: "4242424242424242" }, value: "4242424242424242" });
    const after = m.putState(state("shop", [{ ...empty, value: "4242424242424242" }], T0 + 300));
    const pw = el({ id: "desc:Password", label: "Password", secure: true });
    m.addStep({ ts: T0 + 400, app: "shop", op: "type", by: "user", target: pw, value: "hunter2", before: "x" });

    const [s1, s2] = m.steps();
    assert.equal(s1.before_snap, before);
    assert.equal(s1.after_snap, after);
    assert.notEqual(before, after);
    assert.equal(s1.value, "[card]");
    assert.equal(s1.target!.value, undefined, "the value lives in its own (redacted) column only");
    assert.equal(s1.target_sig, "shop|textfield|card number|||");
    assert.equal(s2.value, null);
    assert.equal(s2.before_value, null);
    // The stored snapshot is redacted too.
    assert.equal(m.snapshot(after)!.els[0].v, "[card]");
});

test("episodes split on app switches and long gaps", () => {
    const m = new Memory(":memory:");
    const t = (ts: number, app: string) => m.addStep({ ts, app, op: "click", by: "user" });
    t(T0, "a");
    t(T0 + 1000, "a");
    t(T0 + 2000, "b");
    t(T0 + 2000 + 200_000, "b");
    const eps = m.steps().map((s) => s.episode);
    assert.equal(eps[0], eps[1]);
    assert.notEqual(eps[1], eps[2]);
    assert.notEqual(eps[2], eps[3]);
    assert.equal(m.stats().episodes, 3);
});

test("ghost outcomes: the first outcome sticks", () => {
    const m = new Memory(":memory:");
    m.ghostShown({ id: "g1", ts: T0, latencyMs: 3, action: { op: "click", app: "a", label: "Click Save", confidence: 0.9, source: "pattern" } });
    m.ghostOutcome("g1", "accepted", T0 + 500);
    m.ghostOutcome("g1", "ignored", T0 + 900);
    const r = m.db.prepare("SELECT outcome FROM ghosts WHERE id = 'g1'").get() as { outcome: string };
    assert.equal(r.outcome, "accepted");
});

test("forget removes an app's steps", () => {
    const m = new Memory(":memory:");
    m.addStep({ ts: T0, app: "secret.app", op: "click", by: "user" });
    m.addStep({ ts: T0, app: "other", op: "click", by: "user" });
    assert.equal(m.forget({ app: "secret.app" }), 1);
    assert.deepEqual(m.steps().map((s) => s.app), ["other"]);
});

test("a changed field is stored as a delta and decodes back exactly", () => {
    const m = new Memory(":memory:");
    const els = Array.from({ length: 30 }, (_, i) => el({ id: `desc:F${i}`, label: `Field ${i}` }));
    const h1 = m.putState(state("app", els, T0));
    const changed = els.map((e, i) => (i === 7 ? { ...e, value: "Acme" } : e));
    const h2 = m.putState(state("app", changed, T0 + 10));
    const shorter = changed.slice(0, 25);
    const h3 = m.putState(state("app", shorter, T0 + 20));
    const row = (h: string) => ({ ...(m.db.prepare("SELECT base, depth FROM snapshots WHERE hash = ?").get(h) as { base: string | null; depth: number }) });
    assert.deepEqual(row(h1), { base: null, depth: 0 });
    assert.deepEqual(row(h2), { base: h1, depth: 1 });
    assert.equal(row(h3).depth, 2);
    assert.equal(m.snapshot(h2)!.els[7].v, "Acme");
    assert.equal(m.snapshot(h2)!.els.length, 30);
    assert.equal(m.snapshot(h3)!.els.length, 25);
    assert.deepEqual(m.snapshot(h3)!.els, m.snapshot(h2)!.els.slice(0, 25));
});

test("a type step's before screen is the one from before the typing", () => {
    const m = new Memory(":memory:");
    const f = el({ id: "desc:Employer", label: "Employer" });
    const h0 = m.putState(state("app", [f], T0));
    m.putState(state("app", [{ ...f, value: "Ac" }], T0 + 100));
    m.putState(state("app", [{ ...f, value: "Acme" }], T0 + 200)); // the commit arrives after this
    m.addStep({ ts: T0 + 300, app: "app", op: "type", by: "user", target: f, value: "Acme" });
    const [s1] = m.steps();
    assert.equal(s1.before_snap, h0, "half-typed screens are skipped: before is the empty field");
});

test("consolidate: old screens go, kept deltas are re-keyed and still decode, form fills outlive other old steps", () => {
    const m = new Memory(":memory:");
    const DAY = 86_400_000;
    const now = T0 + 100 * DAY;
    const els = Array.from({ length: 30 }, (_, i) => el({ id: `desc:F${i}`, label: `Field ${i}` }));
    m.putState(state("app", els, T0)); // keyframe, 100 days old
    const emp = el({ id: "desc:Employer", label: "Employer" });
    m.addStep({ ts: T0 + 1, app: "app", op: "type", by: "user", target: emp, value: "Initech" }); // old form fill
    m.addStep({ ts: T0 + 2, app: "app", op: "click", by: "user", target: el({ id: "desc:Save", label: "Save", role: "button" }) }); // old click
    const h2 = m.putState(state("app", els.map((e, i) => (i === 3 ? { ...e, value: "x" } : e)), now - 1 * DAY)); // delta on it, recent
    m.addStep({ ts: now - DAY, app: "app", op: "click", by: "user" }); // recent
    const r = m.consolidate({ now });
    assert.equal(r.screens, 1);
    assert.equal(r.rekeyed, 1);
    assert.equal(r.steps, 1, "only the old click goes");
    const kept = m.snapshot(h2)!;
    assert.equal(kept.els.length, 30);
    assert.equal(kept.els[3].v, "x", "the re-keyed screen decodes without its deleted base");
    const steps = m.steps();
    assert.deepEqual(steps.map((s) => s.op), ["type", "click"]);
    assert.equal(steps[0].value, "Initech");
    assert.equal(steps[0].before_snap, null, "its screen is gone, the fact stays");
});
