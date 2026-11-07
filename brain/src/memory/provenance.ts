// Where a typed value came from, worked out when it's typed, so a recorded step can be replayed in a new context:
//   copied    it was on a recent screen (a label or a field's value), e.g. an order number on a confirmation page
//   sequence  it continues a run typed into the same kind of field (1, 2 → 3; ENG-141 → ENG-142)
//   repeated  the same value was typed into a field like this before
//   literal   none of the above
import type { El, ScreenState } from "../../../protocol/types.ts";
import type { PastStep } from "../predict/types.ts";
import { valueRule } from "../predict/sequence.ts";
import { elSig, norm } from "./sig.ts";

export type Provenance =
    | { kind: "copied"; from: { app: string; window: string; role: El["role"]; label: string; attr: "label" | "value"; list?: { key: string; field?: string } } }
    | { kind: "sequence" }
    | { kind: "repeated" }
    | { kind: "literal" };

const RECENT_MS = 10 * 60_000;

export function deriveProvenance(value: string, target: El | undefined, now: number, screens: ScreenState[], history: PastStep[]): Provenance {
    const v = norm(value, false);
    if (v.length >= 2) {
        // Newest screen first; the field being typed into doesn't count as a source.
        for (const s of [...screens].sort((a, b) => b.ts - a.ts)) {
            if (now - s.ts > RECENT_MS) continue;
            for (const e of s.elements) {
                if (target && (e.path === target.path || e.id === target.id)) continue;
                const attr = norm(e.label, false) === v ? "label" : e.value !== undefined && norm(e.value, false) === v ? "value" : null;
                if (!attr) continue;
                return {
                    kind: "copied",
                    from: { app: s.app, window: s.window, role: e.role, label: attr === "label" ? "" : e.label, attr, ...(e.list ? { list: { key: e.list.key, field: e.list.field } } : {}) },
                };
            }
        }
    }
    if (target) {
        const sig = elSig("", target);
        const same = history.filter((h) => h.op === "type" && h.target && h.value !== undefined && elSig("", h.target) === sig);
        const prev = same.at(-1);
        if (prev && valueRule([prev.value!, value]) && prev.value !== value) return { kind: "sequence" };
        if (same.some((h) => norm(h.value!, false) === v)) return { kind: "repeated" };
    }
    return { kind: "literal" };
}

/** A value of the same origin on these screens now: the value of the field with the same label, newest screen first.
 * (A value copied from a row of a list has no single "same place"; the pattern engine handles lists.) */
export function resolveCopied(p: Extract<Provenance, { kind: "copied" }>, screens: ScreenState[]): string | undefined {
    for (const s of [...screens].sort((a, b) => b.ts - a.ts)) {
        if (s.app !== p.from.app) continue;
        for (const e of s.elements) {
            if (e.role !== p.from.role) continue;
            if (p.from.attr === "value" && p.from.label && norm(e.label, false) === norm(p.from.label, false) && e.value) return e.value;
        }
    }
    return undefined;
}
