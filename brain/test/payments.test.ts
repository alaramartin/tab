import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { HubToDetector, HubToShell, ScreenState } from "../../protocol/types.ts";
import { Brain } from "../src/brain.ts";
import { intentCheck } from "../src/pay/intent.ts";

const APP = "com.example.browser";
const buy = { x: 100, y: 400, w: 140, h: 40 };
const checkout = (): ScreenState => ({
    type: "state", app: APP, window: "Checkout", seq: 1, ts: Date.now(),
    elements: [
        { id: "text:Total", path: "text:Total", role: "text", label: "Total", rect: { x: 100, y: 300, w: 60, h: 20 }, enabled: true },
        { id: "text:$0.30", path: "text:$0.30", role: "text", label: "$0.30", rect: { x: 200, y: 300, w: 60, h: 20 }, enabled: true },
        { id: "desc:Buy", path: "desc:Buy", role: "button", label: "Buy tickets", rect: buy, enabled: true },
    ],
});
const challenge = (amount: string) => ({
    "payment-required": encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: "https://tickets.example/api/buy", description: "", mimeType: "application/json" },
        accepts: [{ scheme: "exact", network: "eip155:84532", asset: "0xusdc", amount, payTo: "0xpayee", maxTimeoutSeconds: 60, extra: {} }],
    } as any),
});

function setup() {
    const shell: HubToShell[] = [];
    const detector: HubToDetector[] = [];
    const paid: { url: string; method?: string }[] = [];
    const ledger: unknown[] = [];
    const b = new Brain({
        immediate: true,
        decider: null,
        sendShell: (m) => shell.push(m),
        sendDetector: (m) => detector.push(m),
        pay: async (url, init) => (paid.push({ url, method: init.method }), { ok: true, status: 200, headers: {}, body: "", txHash: "0xabc", explorerUrl: "https://sepolia.basescan.org/tx/0xabc" }),
        recordPayment: (p) => ledger.push(p),
    });
    b.fromShell({ type: "frontmost", app: APP, window: "Checkout" });
    b.fromShell(checkout());
    const ghosts = () => shell.filter((m) => m.type === "ghost").map((m) => (m as any).ghost);
    return { b, shell, detector, paid, ledger, ghosts };
}

const req = (id: string, amount: string, headers: Record<string, string> = challenge(amount)) => ({
    type: "payment_required",
    paymentId: id,
    request: { url: "https://tickets.example/api/buy", method: "POST", headers: { "content-type": "application/json" } },
    responseHeaders: headers,
    anchorRect: buy,
});

test("intent check: the amount asked against the price on screen", () => {
    assert.deepEqual(intentCheck(checkout(), 0.3), { ok: true, pagePriceUsd: "0.30" });
    assert.equal(intentCheck(checkout(), 0.51).reason, "page says $0.30, payment asks $0.51");
});

test("a 402 that matches the screen: Pay ghost; Tab pays, records it, and hands the paid response back", async () => {
    const { b, detector, paid, ledger, ghosts } = setup();
    b.fromDetector(req("p1", "300000"));
    const g = ghosts().at(-1);
    assert.equal(g.kind, "pay");
    assert.equal(g.label, "Pay $0.30 · tickets.example ⇥");
    assert.deepEqual(g.rect, buy);
    b.fromShell({ type: "accept", ghostId: g.id });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(paid, [{ url: "https://tickets.example/api/buy", method: "POST" }]);
    assert.equal(ledger.length, 1);
    assert.deepEqual(detector.at(-1), { type: "payment_done", paymentId: "p1", ok: true, status: 200, headers: {}, body: "", error: undefined });
    assert.equal(ghosts().at(-1).label, "Paid $0.30 ✓");
    assert.equal(b.hud.lastTx?.hash, "0xabc");
});

test("a 402 asking more than the screen shows: Blocked, never paid; Esc lets it through", async () => {
    const { b, detector, paid, ghosts } = setup();
    b.fromDetector(req("p2", "510000"));
    const g = ghosts().at(-1);
    assert.equal(g.kind, "blocked");
    assert.equal(g.label, "Blocked · page says $0.30, payment asks $0.51");
    b.fromShell({ type: "accept", ghostId: g.id }); // Tab on a blocked ghost does nothing
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(paid.length, 0);
    b.fromShell({ type: "dismiss", ghostId: g.id });
    assert.deepEqual(detector.at(-1), { type: "payment_declined", paymentId: "p2" });
});

test("a 402 without an x402 challenge is declined right away", () => {
    const { b, detector, ghosts } = setup();
    b.fromDetector(req("p3", "0", { "www-authenticate": "Basic" }));
    assert.deepEqual(detector.at(-1), { type: "payment_declined", paymentId: "p3" });
    assert.equal(ghosts().length, 0);
});
