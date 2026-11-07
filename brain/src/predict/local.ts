// T2: the local LLM picks the next action from code-built candidates.
// One forward pass: the answer is a single letter, and its probability (renormalised over the valid letters,
// "None" included) is the candidate's score. The prompt puts what changes least first (instructions, then the
// screen, then recent actions, then the options) so llama-server's prompt cache covers as much as possible.
import { chatPrompt, type LlamaServer } from "../runtime/llama.ts";
import { appName, describeEl, genericCandidates, historyLines, labelFor, otherScreenLines, screenLines, type OpenAction } from "./generic.ts";
import type { Candidate, PredictContext, Predictor } from "./types.ts";

const LETTERS = "ABCDEFGHIJKLMNOP";

const SYSTEM = `You predict the next single action a person will take on their computer.
You see the current screen, their recent actions, and numbered options.
Prefer continuing what the recent actions are doing: the next field of a form, the next row of a repeated chore, the button that submits what was just filled in.
Reply with only the letter of the most likely next action, or the letter for "None of these" if no option fits.`;

export class LocalModelTier implements Predictor {
    readonly tier = "model" as const;
    lastStats: { promptTokens: number; cachedTokens: number; ms: number; options: number } | null = null;

    constructor(
        private server: LlamaServer,
        private opts: { maxOptions?: number; screenLines?: number } = {},
    ) {}

    /** One throwaway request with the fixed instructions: compiles the GPU kernels and caches the prompt prefix. */
    async warm(): Promise<void> {
        await this.server.complete(chatPrompt(this.server.spec.family ?? "lfm", SYSTEM, "App: Finder · Window: \"Desktop\"\nScreen (top to bottom):\n- button \"OK\"\n\nWhat will they do next?\nA) Click button \"OK\"\nB) None of these"), { nPredict: 1, nProbs: 4 });
    }

    buildPrompt(ctx: PredictContext, upstream: Candidate[] = []) {
        const actions = genericCandidates(ctx, upstream, Math.min(this.opts.maxOptions ?? 12, LETTERS.length - 1));
        const s = ctx.active;
        const head = `App: ${appName(s.app)} · Window: "${s.window.slice(0, 60)}"${s.url ? ` · ${s.url.slice(0, 80)}` : ""}`;
        const screen = screenLines(s, this.opts.screenLines ?? 28);
        const hist = historyLines(ctx.history, ctx.now);
        const other = otherScreenLines(ctx.recent, s);
        const options = [...actions.map((a) => a.label), "None of these"];
        const user = `${head}\nScreen (top to bottom):\n${screen.map((l) => `- ${l}`).join("\n")}\n${
            other.length ? `\nPreviously seen screen, ${other[0]}:\n${other.slice(1).map((l) => `- ${l}`).join("\n")}\n` : ""
        }\nRecent actions (oldest first):\n${
            hist.length ? hist.map((l) => `- ${l}`).join("\n") : "- none"
        }\n\nWhat will they do next?\n${options.map((o, i) => `${LETTERS[i]}) ${o}`).join("\n")}`;
        return { actions, prompt: chatPrompt(this.server.spec.family ?? "lfm", SYSTEM, user), n: options.length };
    }

    async predict(ctx: PredictContext, upstream: Candidate[] = [], signal?: AbortSignal): Promise<Candidate[]> {
        const { actions, prompt, n } = this.buildPrompt(ctx, upstream);
        if (!actions.length) return [];
        const r = await this.server.complete(prompt, { nPredict: 1, nProbs: 24, signal });
        this.lastStats = { promptTokens: r.promptTokens, cachedTokens: r.cachedTokens, ms: r.ms, options: actions.length };
        const valid = LETTERS.slice(0, n);
        const probs = new Map<string, number>();
        for (const t of r.first) {
            const k = t.token.trim();
            if (k.length === 1 && valid.includes(k)) probs.set(k, (probs.get(k) ?? 0) + t.prob);
        }
        const total = [...probs.values()].reduce((a, b) => a + b, 0);
        if (total <= 0) return [];
        const pNone = (probs.get(LETTERS[n - 1]) ?? 0) / total;
        const scored = actions
            .map((a, i) => ({ a, i, p: (probs.get(LETTERS[i]) ?? 0) / total }))
            .filter((x) => x.p > 0)
            .sort((x, y) => y.p - x.p);
        const out: Candidate[] = [];
        for (const [rank, { a, i, p }] of scored.entries()) {
            let action: OpenAction = { ...a, source: "model", confidence: p };
            if (a.needsValue) {
                // Only the top pick gets its value filled (one more short call, mostly served from the prompt cache).
                if (rank > 0) continue;
                const filled = await this.fill(prompt, LETTERS[i], a, ctx, signal);
                if (!filled) continue;
                action = { ...action, value: filled.value, confidence: p * filled.p };
                delete action.needsValue;
                action.label = labelFor(action, ctx.active.elements.find((e) => e.path === a.targetPath || e.id === a.targetId));
            }
            out.push({ action, score: action.confidence, tier: "model", why: `${this.server.spec.name} ${r.ms.toFixed(0)} ms`, pNone });
        }
        return out.sort((a, b) => b.score - a.score);
    }

    /** Choose, then fill: the value for a field (generated) or a select (picked by letter), continuing the same chat. */
    private async fill(prompt: string, letter: string, a: OpenAction, ctx: PredictContext, signal?: AbortSignal): Promise<{ value: string; p: number } | null> {
        const el = ctx.active.elements.find((e) => e.path === a.targetPath || e.id === a.targetId);
        if (!el) return null;
        const think = this.server.spec.family === "qwen3" ? "<think>\n\n</think>\n\n" : "";
        const turn = (q: string) => `${prompt}${letter}<|im_end|>\n<|im_start|>user\n${q}<|im_end|>\n<|im_start|>assistant\n${think}`;
        if (a.needsValue === "option") {
            const opts = (el.options ?? []).slice(0, LETTERS.length);
            const r = await this.server.complete(turn(`Which option do they choose in ${describeEl(el)}?\n${opts.map((o, i) => `${LETTERS[i]}) ${o}`).join("\n")}\nReply with only the letter.`), { nPredict: 1, nProbs: 24, signal });
            const probs = r.first.filter((t) => t.token.trim().length === 1 && LETTERS.slice(0, opts.length).includes(t.token.trim()));
            const tot = probs.reduce((x, t) => x + t.prob, 0);
            const best = probs.sort((x, y) => y.prob - x.prob)[0];
            if (!best || tot <= 0) return null;
            return { value: opts[LETTERS.indexOf(best.token.trim())], p: best.prob / tot };
        }
        const r = await this.server.complete(turn(`What exactly do they type into ${describeEl(el)}? Reply with only the text.`), {
            nPredict: 24, nProbs: 1, stop: ["\n", "<|im_end|>"], signal,
        });
        const value = r.text.trim().replace(/^["'“]|["'”]$/g, "");
        if (!value || value.length > 120) return null;
        // Echoing the field's own label or placeholder is the classic small-model failure: never offer it.
        const n = (x?: string) => (x ?? "").toLowerCase().replace(/\W+/g, " ").trim();
        if ([el.label, el.placeholder].some((x) => x && (n(x) === n(value) || n(value).includes(n(x))))) return null;
        // Copied (the value is somewhere the user has been: another screen, this one, recent steps) vs invented.
        // An invented value is a guess; it stays well under the bar for showing a ghost.
        const v = n(value);
        const seen = [...ctx.recent, ctx.active].some((st) => st.elements.some((e) => e !== el && (n(e.label).includes(v) || n(e.value).includes(v))))
            || ctx.history.some((h) => n(h.value).includes(v));
        return { value, p: Math.min(1, r.first[0]?.prob ?? 0.5) * (seen ? 1 : 0.3) };
    }
}
