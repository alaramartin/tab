// Episode summaries: one line per finished task, written by the local model while the user
// is idle, and embedded so past work can be searched by meaning ("the form I filled last week").
import { stepDesc } from "../predict/generic.ts";
import type { PastStep } from "../predict/types.ts";
import { chatPrompt, type LlamaServer } from "../runtime/llama.ts";
import { cosine, type Embedder } from "./embed.ts";
import type { Memory } from "./store.ts";

const SYSTEM = "You summarise what a person did on their computer in one short line (under 12 words), like a commit message: what they did and where. No preamble.";

export async function summarizeEpisodes(mem: Memory, llm: LlamaServer, embedder: Embedder | null, o: { limit?: number; now?: number } = {}): Promise<number> {
    let n = 0;
    for (const ep of mem.episodesToSummarize(o.now, o.limit ?? 5)) {
        const lines = ep.steps.map((r) => stepDesc({ ts: r.ts, app: r.app, op: r.op as PastStep["op"], by: r.by, target: r.target ?? undefined, value: r.value ?? undefined }));
        const user = `App: ${ep.app}${ep.window ? ` · window "${ep.window}"` : ""}\nWhat they did, in order:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nOne line:`;
        const r = await llm.complete(chatPrompt(llm.spec.family ?? "qwen3", SYSTEM, user), { nPredict: 24, stop: ["\n", "<|im_end|>"] });
        const summary = r.text.trim().replace(/^["'-]+|["']+$/g, "").slice(0, 120);
        let vec: Float32Array | undefined;
        if (summary && embedder?.available) vec = (await embedder.embed([`task: search result | query: ${summary}`]))[0];
        mem.setEpisodeSummary(ep.id, summary, vec);
        n++;
    }
    return n;
}

/**
 * Past tasks by meaning, plus by the words in them: `sim` is the cosine of the embedded query and summary, with
 * up to 0.5 more for the share of query words the summary contains. Without the embedding model, words alone.
 */
export async function searchEpisodes(mem: Memory, embedder: Embedder | null, query: string, k = 8) {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
    if (!words.length) return [];
    let q: Float32Array | undefined;
    if (embedder?.available) {
        try {
            [q] = await embedder.embed([`task: search result | query: ${query}`]);
        } catch {}
    }
    const share = (s: string) => words.filter((w) => s.toLowerCase().includes(w)).length / words.length;
    return mem
        .episodes(5000)
        .map((e) => {
            const kw = share(`${e.summary} ${e.app}`);
            return { ...e, sim: (q && e.vec ? cosine(q, e.vec) : 0) + (q ? 0.5 : 1) * kw, kw };
        })
        .filter((e) => (q && e.vec ? e.sim >= 0.35 : e.kw > 0))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, k);
}
