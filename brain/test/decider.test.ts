import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, HubToShell, HubToWeb, ScreenState } from "../../protocol/types.ts";
import { Brain } from "../src/brain.ts";
import { LocalDecider } from "../src/predict/decider.ts";
import { Ladder } from "../src/predict/ladder.ts";

const MAIL = "com.apple.mail";
const r = { x: 10, y: 10, w: 80, h: 24 };
const el = (label: string, role: El["role"] = "button"): El => ({ id: `desc:${label}`, path: `desc:${label}`, role, label, rect: r, enabled: true });
const mail = (ts: number): ScreenState => ({
    type: "state", source: "ax", app: MAIL, window: "Inbox – 12 messages", focused: true, ts, seq: ts,
    elements: [el("Reply"), el("Archive"), el("Delete"), el("Flag"), el("Search", "textfield")],
});

function decider() {
    const d = new LocalDecider({ memory: null, model: null, embed: false }); // habits only: no LLM, no embedding server
    (d as any).ladder = new Ladder(null); // default weights, not a fitted file from this machine
    return d;
}

test("habits learn 'after Reply, Archive' and the decider's fast path offers it", () => {
    const d = decider();
    let t = 1_000_000;
    for (let i = 0; i < 6; i++) {
        d.observe({ op: "click", app: MAIL, target: { id: "desc:Reply", path: "desc:Reply", role: "button", label: "Reply" }, ts: (t += 5000), by: "user" });
        d.observe({ op: "click", app: MAIL, target: { id: "desc:Archive", path: "desc:Archive", role: "button", label: "Archive" }, ts: (t += 5000), by: "user" });
    }
    d.observe({ op: "click", app: MAIL, target: { id: "desc:Reply", path: "desc:Reply", role: "button", label: "Reply" }, ts: (t += 5000), by: "user" });
    // The habit model reads its own clock from the context; keep "now" close to the last step.
    const realNow = Date.now;
    Date.now = () => t + 1000;
    try {
        const a = d.fast({ active: mail(t), others: [], history: [] });
        assert.ok(a, "an action");
        assert.equal(a!.targetPath, "desc:Archive");
        assert.ok(a!.confidence > 0.6, `confident (${a!.confidence.toFixed(2)})`);
    } finally {
        Date.now = realNow;
    }
});

test("the Brain shows a habit ghost on an AX screen without waiting for idle", async () => {
    const d = decider();
    const shell: HubToShell[] = [];
    const b = new Brain({ immediate: true, decider: d, sendShell: (m) => shell.push(m), sendWeb: (_m: HubToWeb) => {} });
    b.fromShell({ type: "frontmost", app: MAIL, window: "Inbox" });
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
        b.fromShell(mail(now - 60_000 + i * 1000));
        b.fromShell({ type: "user_event", source: "native", app: MAIL, kind: "click", target: el("Reply"), ts: now - 60_000 + i * 8000 });
        b.fromShell({ type: "user_event", source: "native", app: MAIL, kind: "click", target: el("Archive"), ts: now - 56_000 + i * 8000 });
    }
    b.fromShell({ type: "user_event", source: "native", app: MAIL, kind: "click", target: el("Reply"), ts: now });
    b.fromShell(mail(now + 1));
    await b.predictNow();
    const ghosts = shell.filter((m) => m.type === "ghost").map((m) => (m as any).ghost);
    assert.ok(ghosts.some((g) => g.label.startsWith("Click Archive")), ghosts.map((g) => g.label).join(" | ") || "no ghost");
    assert.deepEqual(ghosts.at(-1).rect, r, "the ghost sits on the AX element's rect");
});

test("forget the last hour: steps go from memory, and habits learned from them go too", async () => {
    const { Memory } = await import("../src/memory/store.ts");
    const mem = new Memory(":memory:");
    const now = Date.now();
    for (let i = 0; i < 6; i++) {
        mem.addStep({ ts: now - 30 * 60_000 + i * 8000, app: MAIL, window: "Inbox – 12 messages", op: "click", by: "user", target: el("Reply") });
        mem.addStep({ ts: now - 30 * 60_000 + i * 8000 + 4000, app: MAIL, window: "Inbox – 12 messages", op: "click", by: "user", target: el("Archive") });
    }
    const d = new LocalDecider({ memory: mem, model: null, embed: false });
    (d as any).ladder = new Ladder(null);
    const shell: HubToShell[] = [];
    const b = new Brain({ immediate: true, decider: d, memory: mem, sendShell: (m) => shell.push(m), sendWeb: (_m: HubToWeb) => {} });
    b.fromShell({ type: "frontmost", app: MAIL, window: "Inbox" });
    b.fromShell(mail(now - 2000));
    b.fromShell({ type: "user_event", source: "native", app: MAIL, kind: "click", target: el("Reply"), ts: now - 1000 });
    b.fromShell(mail(now));
    await b.predictNow();
    assert.ok(shell.some((m) => m.type === "ghost"), "the habit is offered before");
    b.fromShell({ type: "forget", sinceMs: 3_600_000 });
    assert.equal(mem.steps().length, 0);
    shell.length = 0;
    b.fromShell({ type: "user_event", source: "native", app: MAIL, kind: "click", target: el("Reply"), ts: Date.now() });
    b.fromShell(mail(Date.now() + 1));
    await b.predictNow();
    assert.ok(!shell.some((m) => m.type === "ghost" && (m as any).ghost.label.startsWith("Click Archive")), "and not after");
});

test("paused: no ghosts", async () => {
    const d = decider();
    const shell: HubToShell[] = [];
    const b = new Brain({ immediate: true, decider: d, sendShell: (m) => shell.push(m), sendWeb: (_m: HubToWeb) => {} });
    b.fromShell({ type: "paused", paused: true });
    b.fromShell({ type: "frontmost", app: MAIL, window: "Inbox" });
    b.fromShell(mail(Date.now()));
    await b.predictNow();
    assert.ok(!shell.some((m) => m.type === "ghost"));
});
