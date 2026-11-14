// Rules: short instructions the user writes in the menu bar dropdown, such as "booking an event adds it to Calendar".
// Each rule is split into a trigger ("booking an event") and a goal ("add it to Calendar"), with the app the goal
// names, if any. After the user finishes something and pauses, the local model checks each rule's trigger against
// what they just did. A match is offered as a ghost (`Add Night Owls · Fri 9pm to Calendar ⇥`). Accepting it
// opens the app and makes the goal the model's aim, so the next ghosts walk toward it one Tab at a time.
//
// Rules live in ~/.tab/rules.json (TAB_RULES_FILE overrides it). The menu bar dropdown writes it, the hub reads it, and
// it can be edited by hand.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ScreenState } from "../../protocol/types.ts";
import { appName, historyLines, screenLines } from "./predict/generic.ts";
import type { PastStep } from "./predict/types.ts";
import { chatPrompt, type LlamaServer } from "./runtime/llama.ts";

export interface Rule {
    id: string;
    text: string;
    enabled: boolean;
    created: number;
}

export interface ParsedRule {
    trigger: string;
    goal: string;
    app?: string; // an app the goal names ("Calendar"), resolved by name in the shell
}

export const DEFAULT_RULES_FILE = join(homedir(), ".tab", "rules.json");
const MAX_RULES = 20;
const MAX_TEXT = 160;

// Verbs that start the "what Tab does" half of "<doing X> <verb>s <Y>".
const VERBS = "adds?|sends?|saves?|puts?|copies|copy|moves?|opens?|creates?|files?|logs?|shares?|emails?|posts?|forwards?|archives?|books?|schedules?|reminds?|texts?|messages?|notes?|records?|tags?|labels?|starts?|makes?|writes?|updates?|exports?|uploads?|downloads?|prints?|pins?|stars?|tracks?";

/** "copies" → "copy", "adds" → "add". */
function base(verb: string): string {
    const v = verb.toLowerCase();
    if (v.endsWith("ies")) return v.slice(0, -3) + "y";
    if (/(ss|sh|ch|x)es$/.test(v)) return v.slice(0, -2);
    if (v.endsWith("s") && !v.endsWith("ss")) return v.slice(0, -1);
    return v;
}

/** Split a rule into trigger and goal. Lenient: when no shape fits, the whole text is both. */
export function parseRule(text: string): ParsedRule {
    const t = text.trim().replace(/[.!]+$/, "");
    let trigger = t, goal = t;
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(?:when(?:ever)?|after|if|once)\s+(.+?)\s*(?:,|\bthen\b|→|->)\s*(?:then\s+)?(.+)$/i))) [trigger, goal] = [m[1], m[2]];
    else if ((m = t.match(/^(.+?)\s*(?:→|->|=>|:)\s*(.+)$/))) [trigger, goal] = [m[1], m[2]];
    else if ((m = t.match(/^(.+?)\s*,?\s+then\s+(.+)$/i))) [trigger, goal] = [m[1], m[2]];
    else if ((m = t.match(new RegExp(`^(.+?)\\s+(?:should\\s+)?(${VERBS})\\s+(.+)$`, "i"))) && m[1].split(/\s+/).length >= 2) {
        trigger = m[1];
        goal = `${base(m[2])} ${m[3]}`;
    }
    goal = goal.replace(/^(?:tab\s+)?(?:should\s+)?/i, "");
    goal = goal[0] ? goal[0].toUpperCase() + goal.slice(1) : goal;
    const app = goal.match(/\b(?:to|in|into|on|with|via|using|from)\s+(?:my\s+|the\s+)?([A-Za-z][\w.]*(?:\s[A-Z][\w.]*)?)$/)?.[1];
    return { trigger: trigger.trim(), goal: goal.trim(), ...(app ? { app: app[0].toUpperCase() + app.slice(1) } : {}) };
}

/** Rules from the file's JSON: {"rules": [{id, text, enabled}]}, or a plain list of strings. Junk is skipped. */
export function parseRules(raw: unknown): Rule[] {
    const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { rules?: unknown })?.rules) ? (raw as { rules: unknown[] }).rules : [];
    const out: Rule[] = [];
    list.forEach((r, i) => {
        const x = r as Partial<Rule> | string;
        const text = typeof x === "string" ? x : x?.text;
        if (typeof text !== "string" || !text.trim()) return;
        out.push({
            id: typeof x === "object" && x.id ? String(x.id) : `r${i}`,
            text: text.trim().slice(0, MAX_TEXT),
            enabled: typeof x === "object" ? x.enabled !== false : true,
            created: typeof x === "object" && typeof x.created === "number" ? x.created : 0,
        });
    });
    return out.slice(0, MAX_RULES);
}

/**
 * The user's rules, read from the rules file. The menu bar dropdown writes the file (rules are settings, editable
 * whether or not the hub runs); the hub only reads it, again whenever it changes.
 */
export class RuleBook {
    private rules: Rule[] = [];
    private mtime = -1;

    /** A file to read, or a fixed list (tests). */
    constructor(private source: string | Rule[] = DEFAULT_RULES_FILE) {
        if (Array.isArray(source)) this.rules = source;
    }

    private refresh(): void {
        if (typeof this.source !== "string") return;
        let m = 0;
        try {
            m = existsSync(this.source) ? statSync(this.source).mtimeMs : 0;
        } catch {}
        if (m === this.mtime) return;
        this.mtime = m;
        if (!m) return void (this.rules = []);
        try {
            this.rules = parseRules(JSON.parse(readFileSync(this.source, "utf8")));
        } catch (err) {
            console.error(`[rules] ${this.source}: ${(err as Error).message}`); // keep the last good rules
        }
    }

    list(): Rule[] {
        this.refresh();
        return this.rules.map((r) => ({ ...r }));
    }

    enabled(): Rule[] {
        return this.list().filter((r) => r.enabled);
    }
}

/** What a rule check sees: the screen now, the screen when the user finished their last step, and the steps. */
export interface RuleContext {
    now: number;
    active: ScreenState;
    before?: ScreenState; // the screen at the finishing step (a click on a button, Return)
    history: PastStep[];
}

/**
 * What an app showed in response, between two screens: the window title, text, and which controls exist. Field
 * values and focus are left out: those are the user's own edits, not a sign that something finished.
 */
export function visibleChanges(before: ScreenState, after: ScreenState): { added: string[]; removed: string[] } {
    const lines = (s: ScreenState) => {
        const out = new Set<string>([`window "${s.window.slice(0, 60)}"`]);
        for (const e of s.elements) {
            const label = e.label.trim().slice(0, 60);
            if (!label || e.role === "textfield" || e.role === "textarea" || e.role === "cell" || e.role === "row") continue;
            out.add(e.role === "text" ? `text "${label}"` : `${e.role} "${label}"`);
        }
        return out;
    };
    const a = lines(before), b = lines(after);
    return { added: [...b].filter((l) => !a.has(l)).slice(0, 8), removed: [...a].filter((l) => !b.has(l)).slice(0, 8) };
}

export interface RuleMatch {
    rule: Rule;
    parsed: ParsedRule;
    score: number; // probability the trigger just happened
    task: string; // the goal made concrete: "Add Night Owls · Fri 9pm to Calendar"
}

export interface RuleChecker {
    /** The best-matching rule for what just happened, or null. */
    check(rules: Rule[], ctx: RuleContext, signal?: AbortSignal): Promise<RuleMatch | null>;
}

function contextText(ctx: RuleContext): string {
    const s = ctx.active;
    const screen = screenLines(s, 20).map((l) => `- ${l}`).join("\n");
    const hist = historyLines(ctx.history, ctx.now, 8).map((l) => `- ${l}`).join("\n") || "- none";
    return `App: ${appName(s.app)} · Window: "${s.window.slice(0, 60)}"${s.url ? ` · ${s.url.slice(0, 80)}` : ""}\nScreen now (top to bottom):\n${screen}\n\nWhat they just did (oldest first):\n${hist}`;
}

const CHECK_SYSTEM = "You decide which kind of task, if any, a person has just finished on their computer, from their screen and recent actions. Reply with only a letter.";
const TASK_SYSTEM = "You write one short follow-up task, like a to-do item, with the specifics from the screen (names, dates, times, amounts). Under 12 words. No preamble, no quotes.";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTU";
export const MATCH_AT = 0.7;

/**
 * Rule checks with the local model. One forward pass asks which trigger, if any, just happened, with "None of these"
 * as an option, so a rule has to beat doing nothing (a Yes/No question per rule said yes to almost anything). The
 * matching rule then gets one short line: its goal for this case.
 */
export class LlamaRuleChecker implements RuleChecker {
    constructor(private server: LlamaServer) {}

    async check(rules: Rule[], ctx: RuleContext, signal?: AbortSignal): Promise<RuleMatch | null> {
        const family = this.server.spec.family ?? "qwen3";
        const list = rules.slice(0, LETTERS.length - 1).map((rule) => ({ rule, parsed: parseRule(rule.text) }));
        if (!list.length) return null;
        // Finishing a task shows on screen (a confirmation, a new window, a status line). Nothing changed: nothing finished.
        let changes = "";
        if (ctx.before) {
            const d = visibleChanges(ctx.before, ctx.active);
            if (!d.added.length && !d.removed.length) {
                if (process.env.TAB_DEBUG) console.log(`[rules] on "${ctx.active.window.slice(0, 40)}": nothing visible changed, no rule checked`);
                return null;
            }
            changes = `\n\nWhat changed on screen after their last action:\n${[...d.added.map((l) => `+ ${l}`), ...d.removed.map((l) => `- ${l}`)].join("\n")}`;
        }
        const context = contextText(ctx) + changes;
        const options = [...list.map((x) => x.parsed.trigger), "None of these"];
        const user = `${context}\n\nWhich of these have they just finished? Only pick one if the screen shows it done (the changes above, if any). Otherwise pick "None of these".\n${options.map((o, i) => `${LETTERS[i]}) ${o}`).join("\n")}`;
        const r = await this.server.complete(chatPrompt(family, CHECK_SYSTEM, user), { nPredict: 1, nProbs: 24, signal });
        const probs = new Map<string, number>();
        for (const t of r.first) {
            const k = t.token.trim();
            if (k.length === 1 && LETTERS.slice(0, options.length).includes(k)) probs.set(k, (probs.get(k) ?? 0) + t.prob);
        }
        const total = [...probs.values()].reduce((a, b) => a + b, 0);
        if (total <= 0) return null;
        const p = (i: number) => (probs.get(LETTERS[i]) ?? 0) / total;
        if (process.env.TAB_DEBUG) console.log(`[rules] on "${ctx.active.window.slice(0, 40)}" (${r.ms.toFixed(0)} ms): ${options.map((o, i) => `${o} ${p(i).toFixed(2)}`).join(" · ")}`);
        let best = -1;
        for (let i = 0; i < list.length; i++) if (p(i) >= MATCH_AT && (best < 0 || p(i) > p(best))) best = i;
        if (best < 0) return null;
        const { rule, parsed } = list[best];
        const taskUser = `${context}\n\nThey just did: ${parsed.trigger}\nFollow-up to do now: ${parsed.goal}\nWrite that follow-up for this case:`;
        const t = await this.server.complete(chatPrompt(family, TASK_SYSTEM, taskUser), { nPredict: 28, stop: ["\n", "<|im_end|>"], signal });
        const task = t.text.trim().replace(/^["'\-•]+|["'.]+$/g, "").slice(0, 80) || parsed.goal;
        if (process.env.TAB_DEBUG) console.log(`[rules] match "${rule.text}" → "${task}"`);
        return { rule, parsed, score: p(best), task };
    }
}

/** Without the model: a rule matches when every content word of its trigger (or its stem) is on screen or in the last steps. */
export class KeywordRuleChecker implements RuleChecker {
    async check(rules: Rule[], ctx: RuleContext): Promise<RuleMatch | null> {
        const hay = contextText(ctx).toLowerCase();
        const STOP = new Set(["a", "an", "the", "my", "to", "in", "on", "for", "of", "and", "or", "it", "something", "any", "some", "i", "you"]);
        for (const rule of rules) {
            const parsed = parseRule(rule.text);
            const words = parsed.trigger.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
            const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "").slice(0, Math.max(4, w.length - 3));
            if (words.length && words.every((w) => hay.includes(stem(w)))) return { rule, parsed, score: 0.75, task: parsed.goal };
        }
        return null;
    }
}
