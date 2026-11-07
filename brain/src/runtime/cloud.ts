// Opt-in cloud tier for long text: a PR description, an email body, a comment. A 1.7B local
// model writes these badly; Claude writes them well. Only with TAB_CLOUD=1 and Anthropic credentials, only for long-text
// fields the local model already picked as the next step, and the result is a ghost: nothing is typed without Tab.
// What is sent: the screen's text (as the local model sees it), the last screen of another app, and recent actions.
import Anthropic from "@anthropic-ai/sdk";
import type { El } from "../../../protocol/types.ts";

const SYSTEM = `You write the text a person is about to type into a field on their computer, for them to accept with one keystroke.
Write only the text itself: no preamble, no quotes, no explanation. Match the tone and format the field calls for (a pull request
description, an email reply, a comment). Use only facts from the context; if something needed is unknown, leave it out.`;

/** Fields worth writing for: multi-line, or named for prose. */
export function isLongTextField(e: El): boolean {
    if (e.role === "textarea") return true;
    return e.role === "textfield" && /description|comment|message|body|notes?|reply|bio|summary|cover letter|details/i.test(`${e.label} ${e.placeholder ?? ""}`);
}

export class CloudWriter {
    private client: Anthropic | null;
    readonly model: string;

    constructor() {
        const on = process.env.TAB_CLOUD === "1" && !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
        this.client = on ? new Anthropic({ timeout: 30_000, maxRetries: 1 }) : null;
        this.model = process.env.LLM_MODEL || "claude-opus-5-5";
    }

    get enabled(): boolean {
        return !!this.client;
    }

    /** The text for `field`, or null (refused, cut off, empty, or failed). */
    async write(field: El, context: string, signal?: AbortSignal): Promise<string | null> {
        if (!this.client) return null;
        try {
            // fallbacks: "default" re-runs a request the safety classifiers decline on Anthropic's recommended model.
            const res = await this.client.beta.messages.create(
                {
                    model: this.model,
                    max_tokens: 4000,
                    betas: ["server-side-fallback-2026-07-01"],
                    output_config: { effort: "low" },
                    system: SYSTEM,
                    messages: [{ role: "user", content: `${context}\n\nWrite what goes into the ${field.role} "${field.label || field.placeholder || ""}".` }],
                    ...({ fallbacks: "default" } as Record<string, unknown>),
                } as Anthropic.Beta.MessageCreateParamsNonStreaming,
                { signal },
            );
            if (res.stop_reason !== "end_turn") return null; // refusal, max_tokens, …
            const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
            return text || null;
        } catch (err) {
            if (err instanceof Anthropic.APIUserAbortError) return null;
            if (err instanceof Anthropic.APIError) console.error(`[cloud] ${err.status}: ${err.message}`);
            else console.error("[cloud]", (err as Error).message);
            return null;
        }
    }
}
