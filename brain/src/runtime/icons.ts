// Names for icon-only controls (the shell's IconLabeler sends crops of unlabeled icons it hasn't seen before).
// LFM2-VL-450M describes what the icon shows ("Trash can", "Gear"); asking for the action it performs made the model
// copy the prompt's examples. ~130 ms per icon on an M2; each icon is named once (the shell caches by image hash).
import { LlamaServer, MODELS, VLM_PORT } from "./llama.ts";

const PROMPT = "What object or symbol is shown in this icon? Answer with one or two words.";

/** A usable name, or "" (the shell remembers that too, so it never asks again). */
export function cleanCaption(raw: string): string {
    const t = raw.replace(/[^\p{L}\p{N} '-]/gu, " ").replace(/\s+/g, " ").trim();
    const words = t.split(" ").filter(Boolean);
    if (!words.length || words.length > 3 || t.length > 30) return "";
    if (/^(the|this|it|an?|image|icon|symbol)$/i.test(t)) return "";
    return t[0].toUpperCase() + t.slice(1);
}

export class IconNamer {
    readonly server: LlamaServer | null;
    constructor() {
        const s = new LlamaServer(MODELS.vlm, VLM_PORT);
        this.server = s.available() ? s : null;
    }

    async name(items: { hash: string; png: string }[]): Promise<{ hash: string; label: string }[]> {
        if (!this.server) return items.map((i) => ({ hash: i.hash, label: "" }));
        await this.server.start();
        const out: { hash: string; label: string }[] = [];
        for (const i of items) {
            try {
                const r = await fetch(`${this.server.url}/v1/chat/completions`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        temperature: 0,
                        max_tokens: 8,
                        messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${i.png}` } }, { type: "text", text: PROMPT }] }],
                    }),
                    signal: AbortSignal.timeout(5000),
                });
                const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
                out.push({ hash: i.hash, label: cleanCaption(j.choices?.[0]?.message?.content ?? "") });
            } catch {
                out.push({ hash: i.hash, label: "" });
            }
        }
        return out;
    }
}
