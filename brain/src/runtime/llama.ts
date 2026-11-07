// Local model runtime (EXTENDED_PLAN.md §4 T2): llama.cpp's llama-server as a child process, one per model.
// Models live in ~/.tab/models (TAB_MODELS_DIR). The chat model runs with prompt caching, so a request that shares a
// prefix with the previous one (the fixed instructions, often the same screen) only pays for the new tokens.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const MODELS_DIR = process.env.TAB_MODELS_DIR || join(homedir(), ".tab", "models");

export type Family = "lfm" | "qwen3" | "chatml";
export interface ModelSpec {
    name: string;
    file: string;
    family?: Family;
    embedding?: boolean;
}

export const MODELS: Record<string, ModelSpec> = {
    lfm: { name: "lfm", file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf", family: "lfm" },
    qwen: { name: "qwen", file: "Qwen3-1.7B-Q4_K_M.gguf", family: "qwen3" },
    qwen4: { name: "qwen4", file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", family: "chatml" }, // non-thinking instruct
    embed: { name: "embed", file: "embeddinggemma-300M-Q8_0.gguf", embedding: true },
};

/** Chat prompt in the model's own template, ending where the assistant's answer starts. */
export function chatPrompt(family: Family, system: string, user: string, answerPrefix = ""): string {
    // Both families use ChatML turns. Qwen3 gets an empty think block so it answers directly.
    const bos = family === "lfm" ? "<|startoftext|>" : "";
    const think = family === "qwen3" ? "<think>\n\n</think>\n\n" : "";
    return `${bos}<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n${think}${answerPrefix}`;
}

export interface TokenProb {
    token: string;
    prob: number;
}

export interface CompletionResult {
    text: string;
    /** First generated token's top alternatives (pre-sampling probabilities). */
    first: TokenProb[];
    promptTokens: number;
    cachedTokens: number;
    ms: number;
}

/** Servers this process started: stopped when it exits, so no llama-server outlives the hub or a tool. */
const children = new Set<ChildProcess>();
function stopChildren(): void {
    for (const c of children) c.kill();
    children.clear();
}
process.on("exit", stopChildren);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
        stopChildren();
        process.exit(128 + (sig === "SIGINT" ? 2 : sig === "SIGTERM" ? 15 : 1));
    });
}

export class LlamaServer {
    private proc: ChildProcess | null = null;
    private ready: Promise<void> | null = null;
    readonly url: string;

    constructor(
        readonly spec: ModelSpec,
        readonly port: number,
        private opts: { ctx?: number; log?: boolean } = {},
    ) {
        this.url = `http://127.0.0.1:${port}`;
    }

    get path(): string {
        return join(MODELS_DIR, this.spec.file);
    }

    available(): boolean {
        return existsSync(this.path);
    }

    /** Start the server (or reuse one already listening on the port) and wait until it serves. */
    start(): Promise<void> {
        if (this.ready) return this.ready;
        this.ready = (async () => {
            if (await this.healthy()) return; // someone (an earlier hub) already runs it
            if (!this.available()) throw new Error(`model file missing: ${this.path}`);
            const args = ["-m", this.path, "--port", String(this.port), "--host", "127.0.0.1", "-ngl", "99", "--no-webui",
                "-c", String(this.opts.ctx ?? 4096), "-np", "1"];
            if (this.spec.embedding) args.push("--embedding", "--pooling", "mean", "-ub", "2048", "-b", "2048");
            else args.push("--cache-reuse", "64");
            this.proc = spawn("llama-server", args, { stdio: this.opts.log ? "inherit" : "ignore" });
            const p = this.proc;
            children.add(p);
            this.proc.on("exit", () => {
                children.delete(p);
                this.proc = null;
                this.ready = null;
            });
            for (let i = 0; i < 300; i++) {
                if (await this.healthy()) return;
                await new Promise((r) => setTimeout(r, 100));
            }
            throw new Error(`llama-server for ${this.spec.name} did not come up on :${this.port}`);
        })();
        return this.ready;
    }

    async healthy(): Promise<boolean> {
        try {
            const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(500) });
            return r.ok;
        } catch {
            return false;
        }
    }

    stop(): void {
        this.proc?.kill();
        this.proc = null;
        this.ready = null;
    }

    async complete(prompt: string, o: { nPredict?: number; nProbs?: number; grammar?: string; signal?: AbortSignal; stop?: string[] } = {}): Promise<CompletionResult> {
        await this.start();
        const t0 = performance.now();
        const r = await fetch(`${this.url}/completion`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                prompt,
                n_predict: o.nPredict ?? 1,
                n_probs: o.nProbs ?? 0,
                temperature: 0,
                cache_prompt: true,
                ...(o.grammar ? { grammar: o.grammar } : {}),
                ...(o.stop ? { stop: o.stop } : {}),
            }),
            signal: o.signal,
        });
        if (!r.ok) throw new Error(`llama-server ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as any;
        const cp = j.completion_probabilities?.[0];
        const first: TokenProb[] = (cp?.top_logprobs ?? cp?.top_probs ?? cp?.probs ?? []).map(
            (p: any) => ({ token: p.token ?? p.tok_str, prob: p.prob ?? Math.exp(p.logprob ?? -Infinity) }),
        );
        return {
            text: j.content ?? "",
            first,
            promptTokens: j.timings?.prompt_n ?? j.tokens_evaluated ?? 0,
            cachedTokens: j.timings?.cache_n ?? 0,
            ms: performance.now() - t0,
        };
    }

    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
        await this.start();
        const r = await fetch(`${this.url}/v1/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: texts }),
            signal,
        });
        if (!r.ok) throw new Error(`embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as { data: { embedding: number[]; index: number }[] };
        return j.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
    }
}

function normalize(v: number[]): number[] {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
}

export const CHAT_PORT = Number(process.env.TAB_CHAT_PORT ?? 7811);
export const EMBED_PORT = Number(process.env.TAB_EMBED_PORT ?? 7812);
