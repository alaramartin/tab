// Where a typed value came from, worked out when it's typed, so a recorded step can be replayed in a new context:
//   copied    it was on a recent screen (a label or a field's value), e.g. an order number on a confirmation page
//   sequence  it continues a run typed into the same kind of field (1, 2 → 3; ENG-141 → ENG-142)
//   repeated  the same value was typed into a field like this before
//   fact      it was typed before into a different kind of field: a known fact, e.g. the email typed into "Email"
//             now going into "Contact"
//   literal   none of the above
// A copied value or a fact may have been rewritten on the way (case, digits only, a date in another format): the
// transform is recorded with it (memory/transform.ts).
import type { El, ScreenState } from "../../../protocol/types.ts";
import type { PastStep } from "../predict/types.ts";
import { valueRule } from "../predict/sequence.ts";
import { elSig, norm } from "./sig.ts";
import { applyTransform, findTransform, type Transform } from "./transform.ts";

export type Provenance =
    | { kind: "copied"; from: { app: string; window: string; role: El["role"]; label: string; attr: "label" | "value"; list?: { key: string; field?: string } }; transform?: Transform }
    | { kind: "sequence" }
    | { kind: "repeated" }
    | { kind: "fact"; label: string; transform?: Transform }
    | { kind: "literal" };

/** What the user has typed into named fields: the field facts (memory/facts.ts). */
export interface FactSource {
    /** Values typed before, with the name of the field each went into, newest first. */
    known(): Iterable<{ label: string; value: string }>;
    /** The newest value typed into a field with this name. */
    latest(label: string): string | undefined;
}

const RECENT_MS = 10 * 60_000;

/** Exact match up to whitespace. Case counts: a value in another case is a transform, so a replay keeps it. */
const exact = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

type Copied = Extract<Provenance, { kind: "copied" }>;

export function deriveProvenance(value: string, target: El | undefined, now: number, screens: ScreenState[], history: PastStep[], facts?: FactSource): Provenance {
    const v = exact(value);
    const recent = [...screens].sort((a, b) => b.ts - a.ts).filter((s) => now - s.ts <= RECENT_MS);
    const copiedFrom = (s: ScreenState, e: El, attr: "label" | "value", transform?: Transform): Copied => ({
        kind: "copied",
        from: { app: s.app, window: s.window, role: e.role, label: attr === "label" ? "" : e.label, attr, ...(e.list ? { list: { key: e.list.key, field: e.list.field } } : {}) },
        ...(transform ? { transform } : {}),
    });
    // The field being typed into doesn't count as a source.
    const sources = function* () {
        for (const s of recent)
            for (const e of s.elements) {
                if (target && (e.path === target.path || e.id === target.id)) continue;
                yield { s, e };
            }
    };
    if (v.length >= 2) {
        for (const { s, e } of sources()) {
            const attr = exact(e.label) === v ? "label" : e.value !== undefined && exact(e.value) === v ? "value" : null;
            if (attr) return copiedFrom(s, e, attr);
        }
    }
    if (target) {
        const sig = elSig("", target);
        const same = history.filter((h) => h.op === "type" && h.target && h.value !== undefined && elSig("", h.target) === sig);
        const prev = same.at(-1);
        if (prev && valueRule([prev.value!, value]) && prev.value !== value) return { kind: "sequence" };
        if (same.some((h) => norm(h.value!, false) === norm(value, false))) return { kind: "repeated" };
    }
    if (v.length < 2) return { kind: "literal" };
    // A known fact, as typed or rewritten.
    const here = norm(target?.label || target?.placeholder, false);
    const known = facts ? [...facts.known()].filter((f) => norm(f.label, false) !== here) : [];
    const fact = known.find((f) => exact(f.value) === v);
    if (fact) return { kind: "fact", label: fact.label };
    // A value on screen, rewritten (case, digits, date format).
    for (const { s, e } of sources()) {
        if (e.value) {
            const t = findTransform(e.value, value);
            if (t) return copiedFrom(s, e, "value", t);
        }
        if (e.label.length <= 80) {
            const t = findTransform(e.label, value);
            if (t) return copiedFrom(s, e, "label", t);
        }
    }
    for (const f of known) {
        const t = findTransform(f.value, value);
        if (t) return { kind: "fact", label: f.label, transform: t };
    }
    return { kind: "literal" };
}

function rewrite(v: string | undefined, t: Transform | undefined): string | undefined {
    return v === undefined || !t ? v : applyTransform(t, v);
}

/** A value of the same origin on these screens now: the value of the field with the same label, newest screen first.
 * (A value copied from a row of a list has no single "same place"; the pattern engine handles lists.) */
export function resolveCopied(p: Copied, screens: ScreenState[]): string | undefined {
    for (const s of [...screens].sort((a, b) => b.ts - a.ts)) {
        if (s.app !== p.from.app) continue;
        for (const e of s.elements) {
            if (e.role !== p.from.role) continue;
            if (p.from.attr === "value" && p.from.label && norm(e.label, false) === norm(p.from.label, false) && e.value) return rewrite(e.value, p.transform);
        }
    }
    return undefined;
}

/** The value a fact-sourced step would type now: the newest value of that fact, rewritten the same way. */
export function resolveFact(p: Extract<Provenance, { kind: "fact" }>, facts: FactSource | undefined): string | undefined {
    return rewrite(facts?.latest(p.label), p.transform);
}
