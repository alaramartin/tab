import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToShell } from "../../protocol/types.ts";
import { Brain } from "../src/brain.ts";
import type { HistEntry } from "../src/history.ts";
import { Memory } from "../src/memory/store.ts";
import { norm, PatternEngine } from "../src/pattern.ts";
import { APP, el, releaseWindow, trackerWindow } from "./screens.ts";

const T0 = 1_000_000;

/** Ticket `t` closed by hand in the tracker, as history. */
function byHand(t: string, pr: string, at: number): HistEntry[] {
    const w = "Tracker";
    const step = (op: HistEntry["op"], target: ReturnType<typeof el>, value: string | undefined, k: number): HistEntry => ({
        op, app: APP, window: w, target: { id: target.id, path: target.path, role: target.role, label: target.label, list: target.list }, value, ts: at + k * 1000, by: "user",
    });
    return [
        step("type", el("desc:Search", "textfield", "Search"), t, 0),
        step("click", el("desc:Result#0", "button", `${t} In review`, { list: { key: "desc:Results", index: 0, field: "button@-" } }), undefined, 1),
        step("type", el("desc:Status", "select", "Status"), "Done", 2),
        step("type", el("desc:Linked PR", "textfield", "Linked PR"), pr, 3),
        step("click", el("desc:Save", "button", "Save"), undefined, 4),
    ];
}

test("norm treats currency forms as equal", () => {
    assert.equal(norm("$0.30"), norm("0.30"));
    assert.equal(norm(" ENG-142 "), "eng-142");
});

test("one ticket by hand → Repeat for the next row, with the row's values and the matching list item", () => {
    const eng = new PatternEngine();
    const a = eng.predict(byHand("ENG-142", "#12", T0), [releaseWindow(T0 - 30_000), trackerWindow(T0 + 6000)], T0 + 6000)!;
    assert.ok(a, "an offer");
    assert.equal(a.label, "Repeat for ENG-150 · #13");
    assert.deepEqual(
        a.steps.map((s) => [s.op, s.targetPath ?? `match:${s.match?.contains}`, s.value, s.window]),
        [
            ["type", "desc:Search", "ENG-150", "Tracker"],
            ["click", "match:ENG-150", undefined, "Tracker"],
            ["type", "desc:Status", "Done", "Tracker"],
            ["type", "desc:Linked PR", "#13", "Tracker"],
            ["click", "desc:Save", undefined, "Tracker"],
        ],
    );
    assert.equal(a.confidence, 0.85);
});

test("no source list, no offer; a unit with nothing typed, no offer", () => {
    const eng = new PatternEngine();
    assert.equal(eng.predict(byHand("ENG-142", "#12", T0), [trackerWindow(T0 + 6000)], T0 + 6000), null);
    const clicks: HistEntry[] = [
        { op: "click", app: APP, target: { id: "a", role: "checkbox", label: "A" }, ts: T0, by: "user" },
        { op: "click", app: APP, target: { id: "desc:Save", role: "button", label: "Save" }, ts: T0 + 1, by: "user" },
    ];
    assert.equal(eng.predict(clicks, [releaseWindow(T0), trackerWindow(T0)], T0), null);
});

test("after two accepted repeats: Do the remaining N", () => {
    const eng = new PatternEngine();
    const a = eng.predict(byHand("ENG-142", "#12", T0), [releaseWindow(T0), trackerWindow(T0)], T0)!;
    eng.onAccepted(a.sig);
    eng.onAccepted(a.sig);
    const b = eng.predict(byHand("ENG-142", "#12", T0 + 60_000), [releaseWindow(T0 + 60_000), trackerWindow(T0 + 60_000)], T0 + 60_000)!;
    assert.equal(b.label, "Do the remaining 5");
    assert.equal(b.steps.length, 25);
    assert.equal(b.confidence, 0.97, "seen twice (two separate times)");
});

test("learned chores are kept in memory and offered for the whole list on a fresh visit", () => {
    const mem = new Memory(":memory:");
    new PatternEngine(mem).predict(byHand("ENG-142", "#12", T0), [releaseWindow(T0), trackerWindow(T0)], T0);
    const later = new PatternEngine(mem); // a restart
    const now = T0 + 3_600_000;
    const tracker = trackerWindow(now);
    const a = later.recall(tracker, [releaseWindow(now - 1000), tracker], now, [], now - 500)!;
    assert.ok(a, "recalled");
    assert.match(a.label, /^Do all 6 from Release v1\.4\.0 · learned /);
    assert.equal(a.steps.filter((s) => s.op === "type" && s.targetPath === "desc:Linked PR").map((s) => s.value).join(","), "#12,#13,#14,#15,#16,#17");
    const started = [{ op: "click" as const, app: APP, ts: now, by: "user" as const }];
    assert.equal(later.recall(tracker, [releaseWindow(now), tracker], now, started, now - 500), null, "not once the user has started there");
    mem.forgetWorkflows();
    later.reload();
    assert.equal(later.recall(tracker, [releaseWindow(now), tracker], now, [], now - 500), null, "forgotten");
});

test("the hub offers the repeat as a ghost, and Tab runs it step by step in the tracker window", async () => {
    const shell: HubToShell[] = [];
    const b = new Brain({ immediate: true, decider: null, sendShell: (m) => {
        shell.push(m);
        // The shell: every step succeeds.
        if (m.type === "exec") setTimeout(() => b.fromShell({ type: "exec_result", ghostId: m.ghostId, ok: true }), 1);
    } });
    const now = Date.now();
    b.fromShell({ type: "frontmost", app: APP, window: "Tracker" });
    b.fromShell(releaseWindow(now - 20_000));
    b.fromShell(trackerWindow(now - 10_000));
    for (const h of byHand("ENG-142", "#12", now - 8000)) {
        b.fromShell({ type: "user_event", app: h.app, window: h.window, kind: h.op as "click" | "type", target: { ...el(h.target!.id, h.target!.role, h.target!.label), list: h.target!.list }, value: h.value, ts: h.ts });
    }
    b.fromShell(trackerWindow(now));
    await b.predictNow();
    const ghost = shell.filter((m) => m.type === "ghost").map((m) => (m as any).ghost).at(-1);
    assert.equal(ghost?.label, "Repeat for ENG-150 · #13 ⇥");
    b.fromShell({ type: "accept", ghostId: ghost.id });
    await new Promise((r) => setTimeout(r, 6500)); // steps wait for their screens (1 s each at most)
    const execs = shell.filter((m) => m.type === "exec").map((m) => (m as any).action);
    assert.deepEqual(execs.map((a) => [a.op, a.targetPath, a.value ?? ""]), [
        ["type", "desc:Search", "ENG-150"],
        ["click", "desc:Result#1", ""],
        ["type", "desc:Status", "Done"],
        ["type", "desc:Linked PR", "#13"],
        ["click", "desc:Save", ""],
    ]);
    assert.ok(execs.every((a) => a.window === "Tracker"), "each step names its window");
    assert.equal(b.hud.tabDid.clicks, 3, "two clicks and a select choice");
});
