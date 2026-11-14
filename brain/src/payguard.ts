// Tab stays out of payments. On a screen that asks for card or bank details, it suggests nothing except the button
// that moves you on to checkout. Anywhere, it never offers to press the button that spends the money (Pay, Place
// order, Buy now): that click is always the user's.
import type { Action, El, ScreenState } from "../../protocol/types.ts";
import { redact } from "./memory/redact.ts";

// Fields that only payment forms have. "Security code" alone is left out: sign-in codes use it too.
const PAYMENT_FIELD = /\b(card ?number|credit ?card|debit ?card|cvc|cvv|cvc2|csc|card ?security ?code|name on (the )?card|card ?holder|expiration ?date \(?mm|iban|routing ?number|sort ?code)\b|\bcc-?(number|num|exp|csc|name)\b/i;

// Buttons that spend money.
const SPENDS = /^(pay\b|pay now|place (your |the )?order|buy( it)? now|buy\b|complete (your )?(purchase|order|payment)|confirm (and pay|purchase|order|payment)|submit (order|payment)|purchase\b|checkout and pay|book and pay|donate\b|send money)/i;

// Buttons that take you toward paying without paying: from the cart to checkout.
const TOWARD_CHECKOUT = /\b(check ?out|proceed to (checkout|payment)|continue to (checkout|payment)|go to (cart|checkout|bag|basket)|view (cart|bag|basket))\b/i;

function text(e: Pick<El, "label" | "placeholder" | "help" | "axId">): string {
    return [e.label, e.placeholder, e.help, e.axId].filter(Boolean).join(" ");
}

/** The screen asks for card or bank details: a field named like one, or a card number typed in. */
export function isPaymentScreen(s: ScreenState | undefined): boolean {
    if (!s) return false;
    return s.elements.some(
        (e) => (e.role === "textfield" || e.role === "select" || e.role === "textarea") && (PAYMENT_FIELD.test(text(e)) || (!!e.value && redact(e.value).includes("[card]"))),
    );
}

export function spendsMoney(label: string): boolean {
    return SPENDS.test(label.trim());
}

export function towardCheckout(label: string): boolean {
    return TOWARD_CHECKOUT.test(label) && !spendsMoney(label);
}

/**
 * May Tab offer this? `target` is the element it acts on (for a sequence, each step's).
 * Never a click that spends money; on a payment screen, only a click toward checkout.
 */
export function allowedNearPayment(a: Action, screen: ScreenState | undefined, target: (s: Action) => El | undefined): boolean {
    const steps = a.op === "sequence" ? (a.steps ?? []) : [a];
    const name = (s: Action) => target(s)?.label || s.label.replace(/^(click|press|choose)\s+/i, "");
    if (steps.some((s) => (s.op === "click" || s.op === "sequence") && spendsMoney(name(s)))) return false;
    if (!isPaymentScreen(screen)) return true;
    return a.op === "click" && towardCheckout(name(a));
}
