import assert from "node:assert/strict";
import { test } from "node:test";
import type { El, ScreenState } from "../../protocol/types.ts";
import { SimilarMoments } from "../src/memory/similar.ts";
import { Ladder } from "../src/predict/ladder.ts";
import type { PastStep } from "../src/predict/types.ts";

const r = { x: 0, y: 0, w: 80, h: 20 };
const btn = (label: string): El => ({ id: `b:${label}`, path: `b:${label}`, role: "button", label, rect: r, enabled: true });
const T = 1_800_000_000_000;
const click = (app: string, label: string, ts: number): PastStep => ({ ts, app, op: "click", by: "user", target: btn(label) });
const outlook = (ts: number): ScreenState => ({ type: "state", app: "com.microsoft.Outlook", window: "Inbox", elements: [btn("Reply"), btn("Archive"), btn("Delete")], seq: 1, ts });

function sendThenArchiveInMail(s: SimilarMoments, times: number): number {
    let t = T;
    for (let i = 0; i < times; i++) {
        s.observe(click("com.apple.mail", "Send", (t += 60_000)));
        s.observe(click("com.apple.mail", "Archive", (t += 3000)));
    }
    return t;
}

test("after Send in a new app, offers what followed Send in another app", () => {
    const s = new SimilarMoments();
    let t = sendThenArchiveInMail(s, 3);
    s.observe(click("com.microsoft.Outlook", "Send", (t += 60_000)));
    const c = s.predict({ now: t + 500, active: outlook(t), recent: [], history: [] });
    assert.equal(c[0]?.action.op, "click");
    assert.equal(c[0]?.action.targetId, "b:Archive");
    assert.equal(c[0]?.tier, "similar");
    assert.ok(c[0]!.score > 0 && c[0]!.score <= 0.6);
    const merged = new Ladder(null).merge(c)[0];
    assert.ok(merged.score > 0.2, `combiner keeps it: ${merged.score}`);
});

test("one moment elsewhere, the same app, or a missing element: no offer", () => {
    const once = new SimilarMoments();
    let t = sendThenArchiveInMail(once, 1);
    once.observe(click("com.microsoft.Outlook", "Send", (t += 60_000)));
    assert.deepEqual(once.predict({ now: t + 500, active: outlook(t), recent: [], history: [] }), [], "one coincidence");

    const same = new SimilarMoments();
    t = sendThenArchiveInMail(same, 3);
    same.observe(click("com.apple.mail", "Send", (t += 60_000)));
    const mail: ScreenState = { ...outlook(t), app: "com.apple.mail" };
    assert.deepEqual(same.predict({ now: t + 500, active: mail, recent: [], history: [] }), [], "the habit graph covers the same app");

    const gone = new SimilarMoments();
    t = sendThenArchiveInMail(gone, 3);
    gone.observe(click("com.microsoft.Outlook", "Send", (t += 60_000)));
    const noArchive: ScreenState = { ...outlook(t), elements: [btn("Reply")] };
    assert.deepEqual(gone.predict({ now: t + 500, active: noArchive, recent: [], history: [] }), []);
});
