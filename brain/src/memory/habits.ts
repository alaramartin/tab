// Habit graph (EXTENDED_PLAN.md §3.2.3): "after you do X here, you usually do Y".
//
// Every step is abstracted into a template with its variable parts lifted out:
//   screen kind (app + host/path or window title, digits folded) · op · element signature (role, label, section,
//   AX id, grid column; digits folded) · for keys, the key itself
// so "Click Archive in Mail" is one template however many messages it was done to. Transitions between
// consecutive templates are counted with exponential recency decay, at order 2 (last two templates), order 1 (last
// one) and order 0 (this screen kind), and prediction backs off from the most specific context that has evidence.
// A predicted template is made concrete by finding the element with that signature on the current screen.
import type { Action, El } from "../../../protocol/types.ts";
import type { Candidate, PastStep, PredictContext, Predictor } from "../predict/types.ts";
import { elSig, norm, screenKind } from "./sig.ts";

const HALF_LIFE_MS = 14 * 86_400_000;
const MAX_GAP_MS = 10 * 60_000; // steps further apart than this aren't a transition
const ORDERS = [2, 1, 0] as const;

interface Next {
    w: number; // decayed count
    t: number; // last update
    tpl: Tpl;
    values: Map<string, number>; // type/key: values seen, with counts
}

interface Tpl {
    key: string;
    op: Action["op"];
    sig?: string;
    kind: string;
    label?: string;
    key2?: string; // key name for op "key"
}

export function templateOf(s: PastStep): Tpl {
    const kind = screenKind({ app: s.app, url: s.url, window: s.window });
    const sig = s.target ? elSig(s.app, s.target) : undefined;
    const key2 = s.op === "key" ? (s.value ?? "") : undefined;
    return {
        key: [kind, s.op, sig ?? "", key2 ?? ""].join("§"),
        op: s.op,
        sig,
        kind,
        label: s.target?.label,
        key2,
    };
}

/** A template recorded without a window title (or URL) matches any screen of the same app. */
function sameKind(screen: string, tpl: string): boolean {
    return screen === tpl || (tpl.endsWith("|") && screen.startsWith(tpl));
}

function decay(w: number, from: number, to: number): number {
    return to <= from ? w : w * Math.pow(0.5, (to - from) / HALF_LIFE_MS);
}

export class HabitModel implements Predictor {
    readonly tier = "habit" as const;
    private table = new Map<string, Map<string, Next>>(); // context key → next template key → stats
    private last: { tpl: Tpl; ts: number }[] = [];

    private ctxKeys(prev: Tpl[], kind: string): string[] {
        const k: string[] = [];
        if (prev.length >= 2) k.push(`2|${prev[prev.length - 2].key}|${prev[prev.length - 1].key}`);
        if (prev.length >= 1) k.push(`1|${prev[prev.length - 1].key}`);
        k.push(`0|${kind}`);
        return k;
    }

    observe(step: PastStep): void {
        if (step.op === "sequence" || step.op === "switch_app") return;
        const tpl = templateOf(step);
        const prev = this.last.filter((p) => step.ts - p.ts <= MAX_GAP_MS).map((p) => p.tpl);
        for (const ck of this.ctxKeys(prev.slice(-2), tpl.kind)) {
            let m = this.table.get(ck);
            if (!m) this.table.set(ck, (m = new Map()));
            let n = m.get(tpl.key);
            if (!n) m.set(tpl.key, (n = { w: 0, t: step.ts, tpl, values: new Map() }));
            n.w = decay(n.w, n.t, step.ts) + 1;
            n.t = step.ts;
            if (step.value !== undefined && (step.op === "type" || step.op === "key")) n.values.set(step.value, (n.values.get(step.value) ?? 0) + 1);
        }
        this.last.push({ tpl, ts: step.ts });
        if (this.last.length > 3) this.last.shift();
    }

    predict(ctx: PredictContext): Candidate[] {
        const kind = screenKind(ctx.active);
        const prev = this.last.filter((p) => ctx.now - p.ts <= MAX_GAP_MS).map((p) => p.tpl);
        const out = new Map<string, Candidate>();
        for (const ck of this.ctxKeys(prev.slice(-2), kind)) {
            const m = this.table.get(ck);
            if (!m) continue;
            let total = 0;
            for (const n of m.values()) total += decay(n.w, n.t, ctx.now);
            if (total < 1) continue;
            const order = Number(ck[0]);
            for (const n of m.values()) {
                if (out.has(n.tpl.key)) continue; // a more specific context already scored it
                const w = decay(n.w, n.t, ctx.now);
                // Probability under this context, shrunk toward 0 when evidence is thin, and discounted at lower orders.
                const p = (w / total) * (w / (w + 1.5)) * (order === 2 ? 1 : order === 1 ? 0.9 : 0.6);
                const c = this.concretize(n, ctx);
                if (c) out.set(n.tpl.key, { ...c, score: p, tier: "habit", why: `${ck[0] === "0" ? "on this screen" : "after your last step"} (${w.toFixed(1)}×)` });
            }
        }
        return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 5);
    }

    /** Turn a template into an action on the current screen, or null if its element isn't here. */
    private concretize(n: Next, ctx: PredictContext): Omit<Candidate, "score" | "tier"> | null {
        const a = ctx.active;
        if (!sameKind(screenKind(a), n.tpl.kind)) return null;
        let el: El | undefined;
        if (n.tpl.sig) {
            el = a.elements.find((e) => e.enabled && elSig(a.app, e) === n.tpl.sig);
            if (!el) return null;
        }
        let value: string | undefined;
        if (n.tpl.op === "type") {
            // Only a value the user always typed here; varying values are for field facts and provenance.
            const [top, cnt] = [...n.values.entries()].sort((x, y) => y[1] - x[1])[0] ?? [];
            const all = [...n.values.values()].reduce((x, y) => x + y, 0);
            if (top === undefined || cnt! / all < 0.8 || (el?.value && norm(el.value) === norm(top))) return null;
            value = top;
        } else if (n.tpl.op === "key") value = n.tpl.key2;
        const label =
            n.tpl.op === "click" ? `Click ${el?.label || "it"}` :
            n.tpl.op === "type" ? `Type ${JSON.stringify(value!.slice(0, 30))}` :
            n.tpl.op === "key" ? `Press ${value}` : `${n.tpl.op} ${el?.label ?? ""}`;
        return {
            action: { op: n.tpl.op, app: a.app, url: a.url, targetId: el?.id, targetPath: el?.path, value, label, confidence: 0, source: "pattern" },
        };
    }
}
