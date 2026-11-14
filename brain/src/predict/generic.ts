// Candidate next actions for any screen.
// Sources, in order: suggestions from faster tiers; the focused field; controls near the last thing the user touched
// (reading order, same section); values the user typed before into fields with the same label; Return to submit.
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import { norm } from "../memory/sig.ts";
import type { Candidate, PastStep, PredictContext } from "./types.ts";

const CLICKABLE = new Set(["button", "link", "checkbox", "tab", "menuitem", "select"]);
const FIELD = new Set(["textfield", "textarea"]);

export function actionKey(a: Pick<Action, "op" | "targetPath" | "targetId" | "value">): string {
    return `${a.op}|${a.targetPath ?? a.targetId ?? ""}|${a.op === "click" ? "" : norm(a.value ?? "", false)}`;
}

export function describeEl(e: El): string {
    const name = e.label || e.placeholder || "";
    return `${e.role}${name ? ` "${name.slice(0, 50)}"` : ""}`;
}

export function labelFor(a: Action, e?: El): string {
    const what = e ? describeEl(e) : "";
    switch (a.op) {
        case "click":
            return `Click ${what}`.trim();
        case "type":
            if (a.value === undefined) return e?.role === "select" ? `Choose an option in ${what}` : `Type something into ${what}`;
            return `Type ${JSON.stringify((a.value ?? "").slice(0, 40))}${what ? ` into ${what}` : ""}`;
        case "key":
            return `Press ${a.value}`;
        default:
            return a.label;
    }
}

/** An action whose value the model fills in afterwards (choose, then fill). */
export type OpenAction = Action & { needsValue?: "text" | "option" };

function act(s: ScreenState, op: Action["op"], e: El | undefined, value?: string): OpenAction {
    const a: Action = { op, app: s.app, ...(s.url ? { url: s.url } : {}), ...(e ? { targetId: e.id, targetPath: e.path } : {}), ...(value !== undefined ? { value } : {}), label: "", confidence: 0, source: "model" };
    a.label = labelFor(a, e);
    return a;
}

/** Index of the element the user last acted on, in this screen's reading order (-1 if not here). */
function lastIndex(s: ScreenState, h: PastStep[]): number {
    for (let k = h.length - 1; k >= 0 && k >= h.length - 4; k--) {
        const t = h[k].target;
        if (h[k].app !== s.app || !t) continue;
        const i = s.elements.findIndex((e) => (t.path && e.path === t.path) || e.id === t.id);
        if (i >= 0) return i;
    }
    return -1;
}

export function genericCandidates(ctx: PredictContext, upstream: Candidate[] = [], max = 14): OpenAction[] {
    const s = ctx.active;
    const out: OpenAction[] = [];
    const seen = new Set<string>();
    let open = 0; // fields offered without a value: at most 3, the ones nearest what the user is doing
    const add = (a: OpenAction) => {
        const k = actionKey(a);
        if (seen.has(k) || out.length >= max) return;
        seen.add(k);
        out.push(a);
    };
    for (const c of upstream) add(c.action);

    const els = s.elements.filter((e) => e.enabled && !e.secure);
    const focused = els.find((e) => e.focused);
    const anchor = lastIndex(s, ctx.history);
    const anchorEl = anchor >= 0 ? s.elements[anchor] : focused;

    // Values typed before into a field with the same label (anywhere): the obvious fill for an empty field.
    const typedByLabel = new Map<string, string[]>();
    for (const h of ctx.history) {
        if (h.op !== "type" || !h.value || !h.target) continue;
        const k = norm(h.target.label || h.target.placeholder);
        if (!k) continue;
        const l = typedByLabel.get(k) ?? [];
        if (!l.includes(h.value)) l.push(h.value);
        typedByLabel.set(k, l.slice(-3));
    }
    const fills = (e: El) => (e.value ? [] : [...(typedByLabel.get(norm(e.label || e.placeholder)) ?? []), ...valuesFromScreens(e, ctx.recent, s)].filter((v, i, a) => a.indexOf(v) === i).slice(0, 3));

    const openField = (e: El) => {
        if (open >= 3 || (e.role !== "select" && e.value)) return;
        const a = act(s, "type", e);
        a.needsValue = e.role === "select" ? "option" : "text";
        if (a.needsValue === "option" && !e.options?.length) return;
        open++;
        add(a);
    };
    if (focused && FIELD.has(focused.role)) {
        for (const v of fills(focused)) add(act(s, "type", focused, v));
        openField(focused);
        if (focused.value) add(act(s, "key", undefined, "Return"));
    }

    // URLs printed on screen (a terminal's push output, a chat message): opening one is a likely next step.
    for (const url of urlsOnScreen(s).slice(0, 2)) {
        const a = act(s, "navigate", undefined, url);
        a.label = `Open ${url.replace(/^https?:\/\//, "").slice(0, 60)}`;
        add(a);
    }

    // Controls ranked by closeness in reading order to what the user last touched, same section first.
    const ranked = els
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => CLICKABLE.has(e.role) || FIELD.has(e.role) || ((e.role === "cell" || e.role === "row") && e.focused))
        .map(({ e, i }) => {
            let d = anchor >= 0 ? Math.abs(i - anchor) + (i < anchor ? 3 : 0) : i; // forward in reading order is likelier
            if (anchorEl?.section && e.section === anchorEl.section) d -= 5;
            if (goalWants(ctx.goal, e)) d -= 1000; // working toward a goal: the controls it names come first
            return { e, d };
        })
        .sort((a, b) => a.d - b.d);
    for (const { e } of ranked) {
        if (out.length >= max) break;
        if (FIELD.has(e.role)) {
            for (const v of fills(e)) add(act(s, "type", e, v));
            openField(e);
            continue;
        }
        if (e.role === "select" && e.options?.length) {
            openField(e);
            continue;
        }
        if (e.role === "checkbox" && e.checked) continue;
        add(act(s, "click", e));
    }
    return out;
}

// Words in a goal that name a control by what it does ("add 12 and 30" wants +).
const GOAL_SYMBOLS: [RegExp, string[]][] = [
    [/\b(add|plus|sum|total)\b/i, ["+", "add", "plus", "="]],
    [/\b(subtract|minus)\b/i, ["-", "−", "subtract", "minus", "="]],
    [/\b(multiply|times)\b/i, ["×", "*", "multiply", "="]],
    [/\b(divide)\b/i, ["÷", "/", "divide", "="]],
];

/** Does the goal name this control? Its label appears in the goal, or it's the symbol for a word there. */
export function goalWants(goal: string | undefined, e: El): boolean {
    if (!goal) return false;
    const label = (e.label || e.placeholder || "").trim().toLowerCase();
    if (!label || label.length > 40) return false;
    const g = goal.toLowerCase();
    if (/^[\p{L}\p{N}]/u.test(label) ? new RegExp(`(^|[^\\p{L}])${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").test(g) : g.includes(label)) return true;
    return GOAL_SYMBOLS.some(([w, labels]) => w.test(goal) && labels.includes(label));
}

/** URLs in the screen's text (not links, which are clickable already), most recently printed first. */
export function urlsOnScreen(s: ScreenState): string[] {
    const out: string[] = [];
    for (const e of s.elements) {
        if (e.role === "link" || e.role === "button") continue;
        const text = `${e.role === "text" ? e.label : ""} ${e.value ?? ""}`;
        for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
            const u = m[0].replace(/[.,;:]+$/, "");
            const i = out.indexOf(u);
            if (i >= 0) out.splice(i, 1);
            out.push(u);
        }
    }
    return out.reverse();
}

const STOP = new Set(["the", "a", "an", "your", "my", "of", "for", "to", "and", "or", "number", "name", "no", "id", "code", "enter", "select", "choose", "field", "search"]);

/** Words of a field's label worth looking for elsewhere ("Rx number" → ["rx"]; "Linked PR" → ["linked", "pr"]). */
function labelWords(e: El): string[] {
    return (e.label || e.placeholder || "").toLowerCase().split(/[^a-z0-9#]+/).filter((w) => w.length >= 2 && !STOP.has(w));
}

/**
 * Values for a field found on other recent screens: the token right after one of the field's label words, when that
 * token looks like a value (has a digit, or is a short code like ENG-142). "Your Rx 4471-209 is ready" fills "Rx number".
 */
export function valuesFromScreens(field: El, recent: ScreenState[], active: ScreenState): string[] {
    const words = labelWords(field);
    if (!words.length) return [];
    const out: string[] = [];
    const onScreen = new Set(active.elements.map((e) => e.value).filter(Boolean));
    for (const st of recent.slice(0, 6)) {
        if (st === active) continue;
        for (const e of st.elements) {
            const text = `${e.label} ${e.value ?? ""}`;
            if (text.length > 400) continue;
            const toks = text.split(/\s+/);
            for (let i = 0; i < toks.length - 1; i++) {
                const w = toks[i].toLowerCase().replace(/[^a-z0-9#]/g, "");
                if (!words.includes(w)) continue;
                const v = toks[i + 1].replace(/^[:#(\[]+|[.,;:)\]]+$/g, "");
                if (/\d/.test(v) && v.length <= 24 && !onScreen.has(v) && !out.includes(v)) out.push(v);
            }
        }
        if (out.length >= 2) break;
    }
    return out;
}

/** Text from the most recent other screen, for the model's context (values often come from there). */
export function otherScreenLines(recent: ScreenState[], active: ScreenState, max = 8): string[] {
    const o = recent.find((s) => s !== active && (s.url ?? s.app) !== (active.url ?? active.app));
    if (!o) return [];
    const lines = o.elements.filter((e) => e.role === "text" || e.role === "link").map((e) => e.label.trim()).filter((l) => l.length > 3);
    return [`${appName(o.app)} · "${o.window.slice(0, 50)}"`, ...lines.slice(0, max).map((l) => l.slice(0, 90))];
}

/** The screen as the model sees it: top to bottom, controls and a little text, one line each. */
export function screenLines(s: ScreenState, max = 32): string[] {
    const lines: string[] = [];
    let text = 0;
    for (const e of s.elements) {
        if (lines.length >= max) break;
        if (e.role === "text") {
            if (text++ >= 8 || !e.label.trim()) continue;
            lines.push(`text "${e.label.slice(0, 60)}"`);
            continue;
        }
        if (!e.enabled) continue;
        let l = describeEl(e);
        if (e.section) l += ` in "${e.section.slice(0, 30)}"`;
        if (e.focused) l += " (focused)";
        if (e.checked !== undefined) l += e.checked ? " [on]" : " [off]";
        if (FIELD.has(e.role)) l += e.value ? ` = "${e.value.slice(0, 40)}"` : " (empty)";
        lines.push(l);
    }
    return lines;
}

export function appName(bundleId: string): string {
    const last = bundleId.split(".").pop() ?? bundleId;
    return last.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function historyLines(h: PastStep[], now: number, n = 6): string[] {
    // Change events can repeat a commit: show each action once.
    const uniq = h.filter((s, i) => !(i > 0 && s.op === h[i - 1].op && s.value === h[i - 1].value && s.target?.path === h[i - 1].target?.path));
    return uniq.slice(-n).map((s) => {
        const ago = Math.max(0, Math.round((now - s.ts) / 1000));
        return `${ago}s ago in ${appName(s.app)}${s.by === "tab" ? " (via Tab)" : ""}: ${stepDesc(s)}`;
    });
}

/** "clicked button \"Save\"", "typed \"Acme\" into textfield \"Employer\"", "pressed cmd+s". */
export function stepDesc(s: PastStep): string {
    if (s.op === "key") return `pressed ${s.value}`;
    if (s.op === "type") return `typed ${JSON.stringify((s.value ?? "").slice(0, 40))}${s.target ? ` into ${describeEl(s.target)}` : ""}`;
    return `${s.op === "click" ? "clicked" : s.op} ${s.target ? describeEl(s.target) : (s.value ?? "").slice(0, 60)}`;
}
