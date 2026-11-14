import assert from "node:assert/strict";
import { test } from "node:test";
import type { Action, HubToShell, ScreenState } from "../../protocol/types.ts";
import { Brain } from "../src/brain.ts";
import type { Decider } from "../src/model.ts";
import { isPaymentScreen, spendsMoney, towardCheckout } from "../src/payguard.ts";
import { el } from "./screens.ts";

const APP = "com.google.Chrome";
const screen = (window: string, els: ScreenState["elements"]): ScreenState => ({ type: "state", app: APP, window, elements: els, seq: 1, ts: Date.now() });
const cart = () => screen("Cart", [el("text:Total", "text", "Total $42.00"), el("desc:Checkout", "button", "Proceed to checkout"), el("desc:Remove", "button", "Remove")]);
const cardForm = () =>
    screen("Payment", [
        el("desc:Name on card", "textfield", "Name on card"),
        el("desc:Card number", "textfield", "Card number"),
        el("desc:Expiry", "textfield", "MM / YY"),
        el("desc:Promo", "textfield", "Promo code"),
        el("desc:Place order", "button", "Place order"),
        el("desc:Back to cart", "button", "Back to cart"),
    ]);

test("payment screens: card or bank fields, or a card number typed in", () => {
    assert.ok(isPaymentScreen(cardForm()));
    assert.ok(isPaymentScreen(screen("x", [el("id:cc-csc", "textfield", "", { axId: "cc-csc" })])));
    assert.ok(isPaymentScreen(screen("x", [el("desc:Number", "textfield", "Number", { value: "4242 4242 4242 4242" })])));
    assert.ok(!isPaymentScreen(cart()));
    assert.ok(!isPaymentScreen(screen("Sign in", [el("desc:Code", "textfield", "Security code")])), "a sign-in code isn't a card");
    assert.ok(spendsMoney("Place order") && spendsMoney("Pay $42.00") && spendsMoney("Buy now"));
    assert.ok(!spendsMoney("Payment settings") && !spendsMoney("Subscribe to updates") && !spendsMoney("Save"));
    assert.ok(towardCheckout("Proceed to checkout") && towardCheckout("Checkout") && !towardCheckout("Place order"));
});

/** A brain whose fast tiers suggest `next`, and which counts model calls. */
function setup(next: () => Action | null) {
    const shell: HubToShell[] = [];
    let modelCalls = 0;
    const decider: Decider = {
        name: "test",
        fast: () => next(),
        async decide() {
            modelCalls++;
            return next();
        },
    };
    const b = new Brain({ immediate: true, decider, sendShell: (m) => shell.push(m) });
    const ghost = () => (shell.filter((m) => m.type === "ghost" || m.type === "ghost_hide").at(-1) as any)?.ghost;
    return { b, ghost, models: () => modelCalls };
}

const click = (id: string, label: string): Action => ({ op: "click", app: APP, targetId: id, targetPath: id, label: `Click ${label}`, confidence: 0.9, source: "pattern" });

test("on the cart, the way to checkout is offered", async () => {
    const t = setup(() => click("desc:Checkout", "Proceed to checkout"));
    t.b.fromShell({ type: "frontmost", app: APP, window: "Cart" });
    t.b.fromShell(cart());
    await t.b.predictNow();
    assert.equal(t.ghost()?.label, "Click Proceed to checkout ⇥");
});

test("on a card form, nothing is filled and the model isn't asked", async () => {
    const t = setup(() => ({ op: "type", app: APP, targetId: "desc:Name on card", targetPath: "desc:Name on card", value: "Jane Doe", label: "Type \"Jane Doe\"", confidence: 0.95, source: "pattern" }));
    t.b.fromShell({ type: "frontmost", app: APP, window: "Payment" });
    t.b.fromShell(cardForm());
    await t.b.predictNow();
    assert.equal(t.ghost(), undefined);
    assert.equal(t.models(), 0);
});

test("a click that spends money is never offered, wherever it is", async () => {
    const t = setup(() => click("desc:Place order", "Place order"));
    t.b.fromShell({ type: "frontmost", app: APP, window: "Review" });
    t.b.fromShell(screen("Review", [el("desc:Place order", "button", "Place order"), el("text:Total", "text", "Total $42.00")]));
    await t.b.predictNow();
    assert.equal(t.ghost(), undefined);
});

test("a screen another app's window covers (a Screen Time block) gets no ghost", async () => {
    const t = setup(() => click("desc:7", "7"));
    t.b.fromShell({ type: "frontmost", app: "com.apple.calculator", window: "Calculator" });
    t.b.fromShell({ ...screen("Calculator", [el("desc:7", "button", "7")]), app: "com.apple.calculator", covered: true });
    await t.b.predictNow();
    assert.equal(t.ghost(), undefined);
    assert.equal(t.models(), 0);
});
