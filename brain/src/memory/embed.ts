// Text embeddings for memory (EmbeddingGemma-300M via llama-server --embedding), cached in memory and in memory.db
// so each distinct text is embedded once. ~10 ms per uncached batch on an M2.
import type { DatabaseSync } from "node:sqlite";
import { EMBED_PORT, LlamaServer, MODELS } from "../runtime/llama.ts";
import { sha1 } from "./sig.ts";

export type Vec = Float32Array;

export function cosine(a: Vec, b: Vec): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s; // vectors are unit length
}

export class Embedder {
    readonly server: LlamaServer | null;
    private mem = new Map<string, Vec>();
    private q: { get: any; put: any } | null = null;

    constructor(db: DatabaseSync | null = null, server?: LlamaServer | null) {
        this.server = server === undefined ? new LlamaServer(MODELS.embed, EMBED_PORT) : server;
        if (this.server && !this.server.available()) this.server = null as any;
        if (db) {
            db.exec("CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, model TEXT, vec BLOB)");
            this.q = {
                get: db.prepare("SELECT vec FROM embeddings WHERE key = ?"),
                put: db.prepare("INSERT OR REPLACE INTO embeddings (key, model, vec) VALUES (?, ?, ?)"),
            };
        }
    }

    get available(): boolean {
        return !!this.server;
    }

    /** Cached only: never waits on the model. */
    cached(text: string): Vec | undefined {
        const hit = this.mem.get(text);
        if (hit) return hit;
        const row = this.q?.get.get(sha1(text)) as { vec: Uint8Array } | undefined;
        if (!row) return undefined;
        const v = new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength));
        this.mem.set(text, v);
        return v;
    }

    async embed(texts: string[], signal?: AbortSignal): Promise<Vec[]> {
        const out: (Vec | undefined)[] = texts.map((t) => this.cached(t));
        const missing = [...new Set(texts.filter((_, i) => !out[i]))];
        if (missing.length) {
            if (!this.server) throw new Error("no embedding model");
            const vecs = await this.server.embed(missing, signal);
            missing.forEach((t, i) => {
                const v = Float32Array.from(vecs[i]);
                this.mem.set(t, v);
                this.q?.put.run(sha1(t), this.server!.spec.name, new Uint8Array(v.buffer));
            });
            if (this.mem.size > 20_000) this.mem.clear();
        }
        return texts.map((t, i) => out[i] ?? this.mem.get(t)!);
    }
}
