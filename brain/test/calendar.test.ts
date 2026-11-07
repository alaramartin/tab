// The sequence runner on a real native 7-step sequence (the hackathon's Calendar beat, now a test fixture).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToShell, HubToWeb, PaymentRequired, ScreenState } from "../../protocol/types.ts";
const { Brain } = await import("../src/brain.ts");
const { CALENDAR, calendarOffer, eventFrom } = await import("./calendar-fixture.ts");
const r = { x: 0, y: 0, w: 10, h: 10 };
const checkout = (window: string, texts: string[]): ScreenState => ({
    type: "state", source: "web", app: "com.google.Chrome", window, url: "http://tickets.localhost:4001/checkout?qty=2", focused: true, seq: 1, ts: Date.now(),
    elements: texts.map((label, i) => ({ id: `t${i}`, role: "text" as const, label, rect: r, enabled: true })),
});

test("event from the real checkout page text", () => {
    const ev = eventFrom(checkout("Checkout · Night Owls · Hall 9", ["Box office", "Night Owls", "Friday 9 pm, Hall 9, Dock Road", "Total", "$0.30"]));
    assert.deepEqual(ev, { title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" });
    assert.equal(eventFrom(checkout("Refill · CareRx", ["Copay $0.05"])), null, "no day and time → no offer");
});

test("offer: Add Event → quick event text → Return → Tab Demo → Return → Escape (Chrome only on failure)", () => {
    const o = calendarOffer({ title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" });
    assert.equal(o.label, "Add Night Owls · Fri 9pm to Calendar");
    assert.deepEqual(o.steps.map((s) => [s.op, s.app === CALENDAR ? "cal" : s.app, s.targetPath ?? "", s.value ?? ""]), [
        ["click", "cal", "desc:Add Event", ""],
        ["type", "cal", "id:QuickEventCell", "Night Owls at Hall 9 Fri 9pm"],
        ["key", "cal", "", "Return"],
        ["type", "cal", "id:calendar-button", "Tab Demo"],
        ["key", "cal", "id:title-field", "Return"],
        ["key", "cal", "", "Escape"],
        ["switch_app", "com.google.Chrome", "", "com.google.Chrome"],
    ]);
    assert.equal(o.steps.at(-1)?.onFail, true);
    assert.equal(o.steps.at(-2)?.unlessPresent, "id:title-field");
});

test("sequence waits until QuickEventCell holds the typed text before Return", async () => {
    const TEXT = "Night Owls at Hall 9 Fri 9pm";
    const cal = (seq: number, value: string, extra: ScreenState["elements"] = []): ScreenState => ({
        type: "state", source: "native", app: CALENDAR, window: "Calendar", focused: true, seq, ts: Date.now(),
        elements: [
            { id: "desc:Add Event", role: "button", label: "Add Event", rect: r, enabled: true, path: "desc:Add Event" },
            { id: "id:QuickEventCell", role: "textfield", label: "Add Event", value, rect: r, enabled: true, path: "id:QuickEventCell" },
            ...extra,
        ],
    });
    const execs: { op: string; ts: number }[] = [];
    let typedAt = 0;
    let valueAt = 0;
    let brain!: InstanceType<typeof Brain>;
    brain = new Brain({
        immediate: true,
        decider: { name: "fake", decide: async () => null },
        sendShell: (m) => {
            if (m.type !== "exec") return;
            const op = (m as any).action.op as string;
            const value = (m as any).action.value as string | undefined;
            execs.push({ op, ts: Date.now() });
            queueMicrotask(() => brain.fromShell({ type: "exec_result", ghostId: (m as any).ghostId, ok: true }));
            if (op === "click") queueMicrotask(() => brain.fromShell(cal(2, "")));
            if (op === "type" && value === TEXT) {
                typedAt = Date.now();
                // Stale poll right after type (the live bug): field still empty. Return must not fire yet.
                queueMicrotask(() => brain.fromShell(cal(3, "")));
                setTimeout(() => {
                    valueAt = Date.now();
                    brain.fromShell(cal(4, TEXT, [{ id: "id:calendar-button", role: "select", label: "Tab Demo", rect: r, enabled: true, path: "id:calendar-button" }]));
                }, 280);
            }
        },
        sendWeb: (_m: HubToWeb) => {},
    });
    brain.fromShell({ type: "frontmost", app: CALENDAR, window: "Calendar" });
    brain.fromShell(cal(1, ""));
    const offer = calendarOffer({ title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" });
    const shown: HubToShell[] = [];
    const orig = (brain as any).o.sendShell.bind((brain as any).o);
    (brain as any).o.sendShell = (m: HubToShell) => {
        shown.push(m);
        orig(m);
    };
    (brain as any).maybeShow(offer, ++(brain as any).gen, 0);
    const g = shown.find((m) => m.type === "ghost") as any;
    assert.ok(g?.ghost?.id, "offer shown");
    brain.fromShell({ type: "accept", ghostId: g.ghost.id });
    const t0 = Date.now();
    while (!execs.some((e) => e.op === "key") && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 20));
    const ret = execs.find((e) => e.op === "key");
    assert.ok(ret, "Return was sent");
    assert.ok(valueAt > 0 && typedAt > 0, "typed, then value landed");
    assert.ok(ret.ts >= valueAt - 20, `Return at ${ret.ts - typedAt}ms after type, value at ${valueAt - typedAt}ms — must wait for the field`);
});

test("no event popover (Calendar still syncing): skip filing and finalizing, deselect, stay in Calendar", async () => {
    const TEXT = "Night Owls at Hall 9 Fri 9pm";
    const cal = (seq: number, value: string): ScreenState => ({
        type: "state", source: "native", app: CALENDAR, window: "Calendar", focused: true, seq, ts: Date.now(),
        elements: [
            { id: "desc:Add Event", role: "button", label: "Add Event", rect: r, enabled: true, path: "desc:Add Event" },
            { id: "id:QuickEventCell", role: "textfield", label: "Add Event", value, rect: r, enabled: true, path: "id:QuickEventCell" },
        ],
    });
    const ops: string[] = [];
    let brain!: InstanceType<typeof Brain>;
    brain = new Brain({
        immediate: true,
        decider: { name: "fake", decide: async () => null },
        sendShell: (m) => {
            if (m.type !== "exec") return;
            const a = (m as any).action;
            ops.push(`${a.op}:${a.app}`);
            queueMicrotask(() => brain.fromShell({ type: "exec_result", ghostId: (m as any).ghostId, ok: true }));
            if (a.op === "type") queueMicrotask(() => brain.fromShell(cal(3, TEXT)));
        },
        sendWeb: (_m: HubToWeb) => {},
    });
    brain.fromShell({ type: "frontmost", app: CALENDAR, window: "Calendar" });
    brain.fromShell(cal(1, ""));
    const shown: HubToShell[] = [];
    const orig = (brain as any).o.sendShell.bind((brain as any).o);
    (brain as any).o.sendShell = (m: HubToShell) => (shown.push(m), orig(m));
    (brain as any).maybeShow(calendarOffer({ title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" }), ++(brain as any).gen, 0);
    const g = shown.find((m) => m.type === "ghost") as any;
    brain.fromShell({ type: "accept", ghostId: g.ghost.id });
    const t0 = Date.now();
    while (ops.length < 4 && Date.now() - t0 < 8000) await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(ops, ["click:com.apple.iCal", "type:com.apple.iCal", "key:com.apple.iCal", "key:com.apple.iCal"]);
});

test("offer anchors on the Dock icon even when Calendar's last screen is remembered (no stale rect)", async () => {
    const shown: HubToShell[] = [];
    const brain = new Brain({ immediate: true, decider: { name: "fake", decide: async () => null }, sendShell: (m) => shown.push(m), sendWeb: (_m: HubToWeb) => {} });
    // Calendar was on screen earlier (its Add Event button at the top of the screen), then hidden.
    brain.fromShell({ type: "frontmost", app: CALENDAR, window: "Calendar" });
    brain.fromShell({ type: "state", source: "native", app: CALENDAR, window: "Calendar", focused: true, seq: 1, ts: Date.now(),
        elements: [{ id: "desc:Add Event", role: "button", label: "Add Event", rect: { x: 396, y: 39, w: 44, h: 52 }, enabled: true, path: "desc:Add Event" }] });
    brain.fromShell({ type: "frontmost", app: "com.google.Chrome", window: "Chrome" });
    brain.fromWeb(checkout("Checkout · Night Owls · Hall 9", ["Friday 9 pm, Hall 9"]));
    (brain as any).maybeShow(calendarOffer({ title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" }), ++(brain as any).gen, 0);
    const g = (shown.find((m) => m.type === "ghost") as any)?.ghost;
    assert.equal(g?.dockApp, CALENDAR);
    assert.equal(g?.rect, undefined, "no rect from Calendar's stale screen");
});

// A fake Calendar for the full beat: Add Event → quick field → (Return) event popover with title-field → (Return) closed.
function fakeCalendar(opts: { popoverStaysOpen?: boolean; failClick?: boolean } = {}) {
    const TEXT = "Night Owls at Hall 9 Fri 9pm";
    const base = [{ id: "desc:Add Event", role: "button" as const, label: "Add Event", rect: r, enabled: true, path: "desc:Add Event" }];
    const quick = (value: string) => ({ id: "id:QuickEventCell", role: "textfield" as const, label: "Add Event", value, rect: r, enabled: true, path: "id:QuickEventCell" });
    const popover = [
        { id: "id:title-field", role: "textfield" as const, label: "title", value: "Night Owls at Hall 9", rect: r, enabled: true, path: "id:title-field" },
        { id: "id:calendar-button", role: "select" as const, label: "Tab Demo", rect: r, enabled: true, path: "id:calendar-button" },
    ];
    let seq = 1, returns = 0;
    const st = (elements: ScreenState["elements"]): ScreenState => ({ type: "state", source: "native", app: CALENDAR, window: "Calendar", focused: true, seq: ++seq, ts: Date.now(), elements });
    const ops: string[] = [];
    let brain!: InstanceType<typeof Brain>;
    brain = new Brain({
        immediate: true,
        decider: { name: "fake", decide: async () => null },
        sendShell: (m) => {
            if (m.type !== "exec") return;
            const a = (m as any).action;
            ops.push(`${a.op}:${a.value ?? a.targetPath ?? ""}`);
            const fail = opts.failClick && a.op === "click";
            queueMicrotask(() => brain.fromShell({ type: "exec_result", ghostId: (m as any).ghostId, ok: !fail, ...(fail ? { error: "boom" } : {}) }));
            let next: ScreenState["elements"] | null = null;
            if (a.op === "click") next = [...base, quick("")];
            if (a.op === "type" && a.value === TEXT) next = [...base, quick(TEXT)];
            if (a.op === "key" && a.value === "Return") next = ++returns === 1 || opts.popoverStaysOpen ? [...base, ...popover] : base;
            if (next) { const n = next; setTimeout(() => brain.fromShell(st(n)), 30); }
        },
        sendWeb: (_m: HubToWeb) => {},
    });
    brain.fromShell({ type: "frontmost", app: CALENDAR, window: "Calendar" });
    brain.fromShell(st(base));
    const shown: HubToShell[] = [];
    const orig = (brain as any).o.sendShell.bind((brain as any).o);
    (brain as any).o.sendShell = (m: HubToShell) => (shown.push(m), orig(m));
    const go = async (until: (ops: string[]) => boolean) => {
        (brain as any).maybeShow(calendarOffer({ title: "Night Owls", venue: "Hall 9", when: "Fri 9pm" }), ++(brain as any).gen, 0);
        const g = shown.find((m) => m.type === "ghost") as any;
        brain.fromShell({ type: "accept", ghostId: g.ghost.id });
        const t0 = Date.now();
        while (!until(ops) && Date.now() - t0 < 10000) await new Promise((res) => setTimeout(res, 20));
        await new Promise((res) => setTimeout(res, 300));
        return ops;
    };
    return { go };
}

test("full beat: create, file in Tab Demo, Return finalizes, Escape deselects, stays in Calendar", async () => {
    const ops = await fakeCalendar().go((o) => o.includes("key:Escape"));
    assert.deepEqual(ops, ["click:desc:Add Event", "type:Night Owls at Hall 9 Fri 9pm", "key:Return", "type:Tab Demo", "key:Return", "key:Escape"]);
});

test("never Escape while the event popover is still open (it would discard the event)", async () => {
    const ops = await fakeCalendar({ popoverStaysOpen: true }).go((o) => o.filter((x) => x === "key:Return").length >= 2);
    await new Promise((res) => setTimeout(res, 3500)); // the guard waits ~3 s for the popover to go
    assert.ok(!ops.includes("key:Escape"), `ops: ${ops.join(", ")}`);
    assert.ok(!ops.some((x) => x.startsWith("switch_app")), "no failure, so no switch back");
});

test("a failed step switches back to Chrome", async () => {
    const ops = await fakeCalendar({ failClick: true }).go((o) => o.some((x) => x.startsWith("switch_app")));
    assert.deepEqual(ops, ["click:desc:Add Event", "switch_app:com.google.Chrome"]);
});
