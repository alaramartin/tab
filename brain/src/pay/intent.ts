// Intent check: before any payment, compare what is asked for with the price the screen shows.
import type { El, Rect, ScreenState } from "../../../protocol/types.ts";

const MONEY = /\$\s?(\d+(?:\.\d+)?)/;
const amountIn = (s: string | undefined) => {
    const m = s?.match(MONEY);
    return m ? Number(m[1]) : null;
};
const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const dist = (a: Rect, b: Rect) => Math.hypot(center(a).x - center(b).x, center(a).y - center(b).y);

/** The screen's price: a "Total" with an amount (in it or in the next text), else the amount nearest the clicked element. */
export function screenPrice(state: ScreenState | undefined, anchor?: Rect): number | null {
    if (!state) return null;
    const els = state.elements;
    for (let i = 0; i < els.length; i++) {
        if (!/\btotal\b/i.test(els[i].label)) continue;
        const own = amountIn(els[i].label);
        if (own !== null) return own;
        const next = els.slice(i + 1).find((e) => e.role === "text" && amountIn(e.label) !== null);
        if (next) return amountIn(next.label);
    }
    if (!anchor) return null;
    let best: El | undefined;
    for (const e of els) if (amountIn(e.label) !== null && (!best || dist(e.rect, anchor) < dist(best.rect, anchor))) best = e;
    return best ? amountIn(best.label) : null;
}

export const fmtUsd = (n: number) => (Math.abs(n * 100 - Math.round(n * 100)) < 1e-9 ? n.toFixed(2) : String(Number(n.toFixed(6))));

export function intentCheck(state: ScreenState | undefined, amount: number, anchor?: Rect): { ok: boolean; reason?: string; pagePriceUsd?: string } {
    const price = screenPrice(state, anchor);
    if (price === null) return { ok: true }; // nothing on screen contradicts it
    const pagePriceUsd = fmtUsd(price);
    if (Math.abs(amount - price) > 0.01) return { ok: false, reason: `page says $${pagePriceUsd}, payment asks $${fmtUsd(amount)}`, pagePriceUsd };
    return { ok: true, pagePriceUsd };
}
