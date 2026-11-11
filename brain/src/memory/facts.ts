// Field facts: forms are retrieval.
//
// Every value the user types into a form field becomes a fact keyed by what the field *means*: its label (or
// placeholder), section and window, embedded as text. A new empty field is matched against those keys by cosine
// similarity, so "Previous employer" finds what was typed into "Company" or "Employer name" elsewhere, in any app.
// A value is offered only when the matching facts agree: a field where many different values were typed (a search
// box) gives a spread-out vote and no confident fill.
//
// Latency: keys of empty fields on a screen are embedded when the screen arrives (prepare), so predict() is a few
// hundred dot products on cached vectors. Without the embedding model, matching falls back to the normalised label.
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import type { Candidate, PastStep, PredictContext, Predictor } from "../predict/types.ts";
import { describeEl, labelFor } from "../predict/generic.ts";
import { cosine, type Embedder, type Vec } from "./embed.ts";
import type { FactSource } from "./provenance.ts";
import { norm, screenKind } from "./sig.ts";

const FIELD = new Set(["textfield", "textarea"]);
// EmbeddingGemma with its sentence-similarity prompt, on field names alone (measured on 20 label pairs: true matches
// 0.72–0.94, false ones up to 0.82). The threshold is the first filter; the discriminator veto and the value-shape
// check below remove the false matches the threshold lets through (first/last name, email/phone).
const PROMPT = "task: sentence similarity | query: ";
const MIN_SIM = 0.7;
const SHARP = 15; // vote weight ∝ e^(15·(sim − 1)): a 0.82 match outvotes a 0.72 one ~4.5×
const MAX_VALUE = 200;

interface Fact {
    key: string; // the field's meaning as text
    label: string;
    where: string;
    labelNorm: string;
    derived?: boolean; // e.g. "Last name" split from a full name: only trusted on a near-exact label match
    value: string;
    ts: number;
    vec?: Vec;
}

/** The text an embedding compares: the field's name (label, else placeholder). Context is scored separately. */
export function fieldKey(e: Pick<El, "label" | "placeholder">): string {
    return PROMPT + (e.label || e.placeholder || "").trim().slice(0, 80);
}

/** Words that make two otherwise similar labels mean different things. */
const OPPOSED: [string, string][] = [
    ["first", "last"], ["first", "family"], ["given", "last"], ["given", "family"], ["first", "sur"], ["billing", "shipping"], ["start", "end"],
    ["from", "to"], ["min", "max"], ["minimum", "maximum"], ["old", "new"], ["current", "new"], ["before", "after"], ["home", "work"],
    ["full", "first"], ["full", "last"], ["full", "given"], ["full", "family"], ["full", "sur"],
    ["city", "state"], ["city", "country"], ["state", "country"], ["day", "month"], ["month", "year"], ["sender", "recipient"], ["middle", "last"],
];
function words(s: string): Set<string> {
    return new Set(s.toLowerCase().split(/[^a-z]+/).filter(Boolean));
}
export function opposed(a: string, b: string): boolean {
    const wa = words(a), wb = words(b);
    return OPPOSED.some(([x, y]) => (wa.has(x) && wb.has(y) && !wa.has(y)) || (wa.has(y) && wb.has(x) && !wa.has(x)));
}

/** What kind of value a field takes, from its name; and whether a value has that shape. */
type Kind = "email" | "phone" | "url" | "zip" | "number" | "text";
export function kindOf(label: string): Kind {
    const l = label.toLowerCase();
    if (/e-?mail/.test(l)) return "email";
    if (/phone|mobile|\bcell\b|\btel\b/.test(l)) return "phone";
    if (/\burl\b|website|linkedin|github|portfolio|link\b/.test(l)) return "url";
    if (/\bzip\b|postal|post ?code/.test(l)) return "zip";
    if (/\b(age|qty|quantity|amount|count|number of|years)\b/.test(l)) return "number";
    return "text";
}
export function fits(kind: Kind, v: string): boolean {
    switch (kind) {
        case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
        case "phone": return /^[+()\d][\d\s().-]{5,}$/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 7;
        case "url": return /^(https?:\/\/|www\.)\S+$|^[\w-]+\.[a-z]{2,}\/\S*$/i.test(v);
        case "zip": return /^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$/.test(v);
        case "number": return /^-?[\d.,]+$/.test(v);
        default: return true; // free text takes anything
    }
}

function whereOf(s: { app: string; url?: string; window?: string }): string {
    return screenKind(s).split("|").slice(1).join(" ") || s.app;
}

export class FactIndex implements Predictor, FactSource {
    readonly tier = "fact" as const;
    private facts: Fact[] = [];
    private rejected = new Set<string>(); // "field name\nvalue" the user dismissed

    /** The user dismissed this fill for this field: never offer it there again. */
    reject(fieldName: string, value: string): void {
        this.rejected.add(`${norm(fieldName, false)}\n${norm(value, false)}`);
    }

    constructor(private embedder: Embedder | null) {}

    get size(): number {
        return this.facts.length;
    }

    *known(): Iterable<{ label: string; value: string }> {
        const seen = new Set<string>();
        for (let i = this.facts.length - 1; i >= 0; i--) {
            const f = this.facts[i];
            const k = `${f.labelNorm}\n${f.value}`;
            if (seen.has(k)) continue;
            seen.add(k);
            yield { label: f.label, value: f.value };
        }
    }

    latest(label: string): string | undefined {
        const ln = norm(label, false);
        for (let i = this.facts.length - 1; i >= 0; i--) if (this.facts[i].labelNorm === ln) return this.facts[i].value;
        return undefined;
    }

    observe(step: PastStep): void {
        const t = step.target;
        if (step.op !== "type" || !t || !FIELD.has(t.role) || t.secure || !step.value || step.value.length > MAX_VALUE) return;
        if (!(t.label || t.placeholder)) return;
        const label = t.label || t.placeholder || "";
        const add = (lab: string, value: string, derived = false) => {
            const k = fieldKey({ label: lab });
            this.facts.push({ key: k, label: lab, where: whereOf(step), labelNorm: norm(lab, false), value, ts: step.ts, vec: this.embedder?.cached(k), ...(derived ? { derived } : {}) });
        };
        add(label, step.value.trim());
        // A full name also answers "First name" and "Last name".
        const parts = step.value.trim().split(/\s+/);
        if (/\b(full|your)?\s*name\b/i.test(label) && !/first|last|given|family|sur|user|company|file|display/i.test(label) && parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[\p{L}'.-]+$/u.test(p))) {
            add("First name", parts[0], true);
            add("Last name", parts[parts.length - 1], true);
        }
        if (this.facts.length > 5000) this.facts.splice(0, this.facts.length - 5000);
    }

    /** Embed fact keys and the screen's empty fields ahead of time. Safe to call on every screen; cheap when cached. */
    async prepare(screen: ScreenState | null, signal?: AbortSignal): Promise<void> {
        if (!this.embedder?.available) return;
        const keys: string[] = this.facts.filter((f) => !f.vec).map((f) => f.key);
        if (screen) for (const e of this.emptyFields(screen)) keys.push(fieldKey(e));
        if (!keys.length) return;
        await this.embedder.embed(keys, signal);
        for (const f of this.facts) if (!f.vec) f.vec = this.embedder.cached(f.key);
    }

    private emptyFields(s: ScreenState): El[] {
        return s.elements.filter((e) => FIELD.has(e.role) && e.enabled && !e.secure && !e.value && (e.label || e.placeholder)).slice(0, 12);
    }

    /** Best fill for one field: the value whose matching facts carry the most similarity-weighted, recent votes. */
    lookup(field: El, screen: ScreenState, now: number): { value: string; score: number; n: number; sim: number } | null {
        const key = fieldKey(field);
        const qv = this.embedder?.cached(key);
        const name = field.label || field.placeholder || "";
        const ln = norm(name, false);
        const kind = kindOf(name);
        const where = whereOf(screen);
        const votes = new Map<string, { w: number; n: number; sim: number }>();
        let total = 0;
        for (const f of this.facts) {
            let sim = f.labelNorm === ln ? 1 : qv && f.vec ? cosine(qv, f.vec) : 0;
            if (f.where === where) sim += 0.03; // the same form or site again
            if (sim < MIN_SIM || opposed(name, f.label) || !fits(kind, f.value) || this.rejected.has(`${ln}\n${norm(f.value, false)}`)) continue;
            const recency = 1 / (1 + (now - f.ts) / (90 * 86_400_000));
            const w = Math.exp(SHARP * (Math.min(sim, 1) - 1)) * recency * (f.derived && sim < 0.95 ? 0.1 : 1);
            const k = norm(f.value, false);
            const v = votes.get(k) ?? { w: 0, n: 0, sim: 0 };
            v.w += w;
            v.n++;
            v.sim = Math.max(v.sim, sim);
            votes.set(k, v);
            total += w;
        }
        if (!total) return null;
        const [bestKey, best] = [...votes].sort((a, b) => b[1].w - a[1].w)[0];
        const value = [...this.facts].reverse().find((f) => norm(f.value, false) === bestKey)!.value;
        // Agreement × evidence: one past fill of a near-identical field is decent; many conflicting fills are not.
        const agree = best.w / total;
        const evidence = best.n / (best.n + 0.5);
        return { value, score: agree * evidence * Math.min(1, (best.sim - 0.66) / 0.18), n: best.n, sim: best.sim };
    }

    /**
     * Autocomplete while typing: values typed before (into any field; 3× when it was a field like this one) that start
     * with what the focused field holds. Confidence grows with the prefix and with how unambiguous it is.
     */
    complete(field: El, now: number): { value: string; score: number } | null {
        const typed = field.value ?? "";
        if (typed.length < 2 || typed.length > 120 || typed.includes("\n")) return null;
        const pre = typed.toLowerCase();
        const name = field.label || field.placeholder || "";
        const kind = kindOf(name);
        const qv = this.embedder?.cached(fieldKey(field));
        const ln = norm(name, false);
        const votes = new Map<string, { value: string; w: number }>();
        for (const f of this.facts) {
            if (f.derived || f.value.length <= typed.length || !f.value.toLowerCase().startsWith(pre) || !fits(kind, f.value)) continue;
            if (this.rejected.has(`${ln}\n${norm(f.value, false)}`)) continue;
            const same = f.labelNorm === ln || (qv && f.vec ? cosine(qv, f.vec) >= MIN_SIM : false);
            const w = (same ? 3 : 1) / (1 + (now - f.ts) / (90 * 86_400_000));
            const k = f.value.toLowerCase();
            const v = votes.get(k) ?? { value: f.value, w: 0 };
            v.w += w;
            v.value = f.value;
            votes.set(k, v);
        }
        if (!votes.size) return null;
        const all = [...votes.values()].sort((a, b) => b.w - a.w);
        const total = all.reduce((x, v) => x + v.w, 0);
        const best = all[0];
        const prefixConf = Math.min(1, typed.length / 4); // "ja" is weak evidence, "jane" strong
        return { value: best.value, score: (best.w / total) * prefixConf * (best.w / (best.w + 0.5)) };
    }

    predict(ctx: PredictContext): Candidate[] {
        const s = ctx.active;
        const fields = this.emptyFields(s);
        // The focused field first; then the first empty fields in reading order.
        fields.sort((a, b) => Number(!!b.focused) - Number(!!a.focused));
        const out: Candidate[] = [];
        for (const e of fields.slice(0, 4)) {
            const hit = this.lookup(e, s, ctx.now);
            if (!hit || hit.score < 0.15) continue;
            const a: Action = { op: "type", app: s.app, ...(s.url ? { url: s.url } : {}), targetId: e.id, targetPath: e.path, value: hit.value, label: "", confidence: hit.score, source: "pattern" };
            a.label = labelFor(a, e);
            out.push({ action: a, score: hit.score * (e.focused ? 1 : 0.8), tier: "fact", why: `typed into a field like ${describeEl(e)} ${hit.n}× (sim ${hit.sim.toFixed(2)})` });
        }
        // The focused field already has text: complete it.
        const f = s.elements.find((e) => e.focused && FIELD.has(e.role) && !e.secure && e.value);
        if (f) {
            const hit = this.complete(f, ctx.now);
            if (hit && hit.score >= 0.2) {
                const a: Action = { op: "type", app: s.app, ...(s.url ? { url: s.url } : {}), targetId: f.id, targetPath: f.path, value: hit.value, label: "", confidence: hit.score, source: "pattern" };
                a.label = labelFor(a, f);
                out.push({ action: a, score: hit.score, tier: "fact", why: `completes "${f.value}"` });
            }
        }
        return out.sort((a, b) => b.score - a.score);
    }
}
