// Action memory, raw layer. One SQLite file, ~/.tab/memory.db.
//
//   snapshots  content-addressed screens: meaning only (no rects, no ids), zstd-compressed, stored once however
//              often the same screen comes back; `seen` and `last_ts` count the repeats
//   steps      one row per action, by the user or by Tab: who, what, the element's value-free signature, the
//              value (redacted), and the screens before and after
//   ghosts     every suggestion shown and what happened to it (accepted / dismissed / ignored): labels for eval
//   episodes   the step stream cut into tasks at app switches and 2-minute gaps
//
// What is learned from these tables lives next door: habits.ts, facts.ts, episodes.ts.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { Action, El, ScreenState } from "../../../protocol/types.ts";
import { redact } from "./redact.ts";
import { compactEls, elSig, screenKind, sha1, type CompactEl } from "./sig.ts";

export const DEFAULT_MEMORY_FILE = join(homedir(), ".tab", "memory.db");
const EPISODE_GAP_MS = 120_000;
const AFTER_WINDOW_MS = 5_000;
const MAX_DELTA_DEPTH = 20; // a keyframe at least every 20 screens of a place, so a read decodes ≤ 20 patches

/** Patch from `a` to `b`: new length plus the elements that differ, by index. */
type Delta = { n: number; d: [number, CompactEl][] }; // a step's "after" screen is the first new screen of its app within this long

export type StepBy = "user" | "tab";

export interface StepIn {
    ts: number;
    app: string;
    window?: string;
    url?: string;
    op: Action["op"] | "focus";
    by: StepBy;
    target?: El;
    value?: string;
    before?: string;
    partial?: boolean;
    ghostId?: string;
}

export interface StepRow {
    id: number;
    ts: number;
    app: string;
    window: string | null;
    url: string | null;
    op: string;
    by: StepBy;
    target_sig: string | null;
    target: El | null;
    value: string | null;
    before_value: string | null;
    before_snap: string | null;
    after_snap: string | null;
    episode: number;
    ghost_id: string | null;
    partial: number;
    screen_kind: string;
}

export interface Snapshot {
    hash: string;
    app: string;
    window: string;
    url: string | null;
    source: ScreenState["source"];
    els: CompactEl[];
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS snapshots (
    hash TEXT PRIMARY KEY, app TEXT NOT NULL, window TEXT, url TEXT, kind TEXT, source TEXT, n_els INTEGER,
    first_ts INTEGER, last_ts INTEGER, seen INTEGER DEFAULT 1, data BLOB NOT NULL,
    base TEXT, depth INTEGER DEFAULT 0 -- delta-encoded against base (same place, previous screen); depth 0 = keyframe
);
CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, app TEXT NOT NULL, window TEXT, url TEXT, screen_kind TEXT,
    op TEXT NOT NULL, by TEXT NOT NULL, target_sig TEXT, target TEXT, value TEXT, before_value TEXT,
    before_snap TEXT, after_snap TEXT, episode INTEGER, ghost_id TEXT,
    partial INTEGER DEFAULT 0 -- type in a long text: value = inserted span, before_value = text just before it
);
CREATE INDEX IF NOT EXISTS steps_ts ON steps(ts);
CREATE INDEX IF NOT EXISTS steps_sig ON steps(target_sig);
CREATE INDEX IF NOT EXISTS steps_app ON steps(app, ts);
CREATE TABLE IF NOT EXISTS ghosts (
    id TEXT PRIMARY KEY, ts INTEGER, app TEXT, source TEXT, confidence REAL, label TEXT, action TEXT,
    snap TEXT, latency_ms REAL, outcome TEXT, outcome_ts INTEGER
);
CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY, start_ts INTEGER, end_ts INTEGER, app TEXT, window TEXT, n_steps INTEGER DEFAULT 0, summary TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** Key for "the latest screen of this place": web pages by URL, everything else by app. */
function placeKey(s: { app: string; url?: string | null; source?: string }): string {
    return s.source === "web" && s.url ? `web:${s.url}` : s.app;
}

export class Memory {
    readonly db: DatabaseSync;
    private q: Record<string, StatementSync>;
    private lastSnap = new Map<string, string>(); // placeKey → snapshot hash
    private lastEls = new Map<string, CompactEl[]>(); // placeKey → that snapshot's elements (delta base)
    private trail = new Map<string, { hash: string; els: CompactEl[]; ts: number }[]>(); // placeKey → last screens, oldest first
    private awaitingAfter = new Map<string, { id: number; ts: number; snap: string | null }[]>();
    private episode: { id: number; app: string; lastTs: number } | null = null;

    constructor(readonly file: string = DEFAULT_MEMORY_FILE) {
        if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(SCHEMA);
        this.q = {
            snapGet: this.db.prepare("SELECT hash FROM snapshots WHERE hash = ?"),
            snapSeen: this.db.prepare("UPDATE snapshots SET seen = seen + 1, last_ts = ? WHERE hash = ?"),
            snapPut: this.db.prepare(
                "INSERT INTO snapshots (hash, app, window, url, kind, source, n_els, first_ts, last_ts, data, base, depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ),
            snapRead: this.db.prepare("SELECT hash, app, window, url, source, data, base FROM snapshots WHERE hash = ?"),
            snapDepth: this.db.prepare("SELECT depth FROM snapshots WHERE hash = ?"),
            stepPut: this.db.prepare(
                `INSERT INTO steps (ts, app, window, url, screen_kind, op, by, target_sig, target, value, before_value, before_snap, episode, ghost_id, partial)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ),
            stepAfter: this.db.prepare("UPDATE steps SET after_snap = ? WHERE id = ? AND after_snap IS NULL"),
            epNew: this.db.prepare("INSERT INTO episodes (start_ts, end_ts, app, window, n_steps) VALUES (?, ?, ?, ?, 0)"),
            epTouch: this.db.prepare("UPDATE episodes SET end_ts = ?, n_steps = n_steps + 1 WHERE id = ?"),
            ghostPut: this.db.prepare(
                `INSERT OR REPLACE INTO ghosts (id, ts, app, source, confidence, label, action, snap, latency_ms, outcome)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'shown')`,
            ),
            ghostOutcome: this.db.prepare("UPDATE ghosts SET outcome = ?, outcome_ts = ? WHERE id = ? AND outcome = 'shown'"),
        };
        const last = this.db.prepare("SELECT id, app, end_ts FROM episodes ORDER BY id DESC LIMIT 1").get() as
            | { id: number; app: string; end_ts: number }
            | undefined;
        if (last) this.episode = { id: last.id, app: last.app, lastTs: last.end_ts };
    }

    /** Store a screen once; returns its content hash. Also closes steps waiting for their "after" screen. */
    putState(s: ScreenState, ts = s.ts || Date.now()): string {
        const els = compactEls(s, redact);
        const window = redact(s.window ?? "");
        const url = s.url ? redact(s.url) : null;
        const json = JSON.stringify(els);
        const hash = sha1(`${s.app}\n${window}\n${url ?? ""}\n${json}`).slice(0, 20);
        const key = placeKey(s);
        const prev = this.lastSnap.get(key);
        if (this.q.snapGet.get(hash)) this.q.snapSeen.run(ts, hash);
        else {
            // Most screens differ from the previous one of the same place by a field or two: store just that.
            let data = json, base: string | null = null, depth = 0;
            const prevEls = prev ? this.lastEls.get(key) : undefined;
            const prevDepth = prev ? ((this.q.snapDepth.get(prev) as { depth: number } | undefined)?.depth ?? MAX_DELTA_DEPTH) : MAX_DELTA_DEPTH;
            if (prev && prevEls && prevDepth < MAX_DELTA_DEPTH) {
                const delta: Delta = { n: els.length, d: [] };
                for (let i = 0; i < els.length; i++) if (JSON.stringify(els[i]) !== JSON.stringify(prevEls[i])) delta.d.push([i, els[i]]);
                const dj = JSON.stringify(delta);
                if (dj.length < json.length / 2) (data = dj, base = prev, depth = prevDepth + 1);
            }
            this.q.snapPut.run(hash, s.app, window, url, screenKind({ app: s.app, url: url ?? undefined, window }), s.source, els.length, ts, ts,
                zstdCompressSync(Buffer.from(data)), base, depth);
        }
        this.lastEls.set(key, els);
        if (prev !== hash) {
            const t = this.trail.get(key) ?? [];
            t.push({ hash, els, ts });
            if (t.length > 40) t.shift();
            this.trail.set(key, t);
        }
        this.lastSnap.set(key, hash);
        if (prev !== hash) {
            const waiting = this.awaitingAfter.get(key);
            if (waiting) {
                const keep = [];
                for (const w of waiting) {
                    if (ts - w.ts > AFTER_WINDOW_MS) continue;
                    if (w.snap === hash) { keep.push(w); continue; } // still the screen it was taken on
                    this.q.stepAfter.run(hash, w.id);
                }
                if (keep.length) this.awaitingAfter.set(key, keep);
                else this.awaitingAfter.delete(key);
            }
        }
        return hash;
    }

    /** Record one action. Values are redacted; secure targets never carry one. */
    addStep(st: StepIn): number {
        // Web steps belong to their page's screen (CDP states), everything else to the app's latest screen.
        const snapKey = st.url && this.lastSnap.has(`web:${st.url}`) ? `web:${st.url}` : st.app;
        let before = this.lastSnap.get(snapKey) ?? null;
        // Screens arrive while the user types, so the latest one already shows (some of) the text. A type step's
        // "before" is the last screen from before the typing: walk back past screens where the field holds a growing
        // prefix of the final text (within the last minute).
        if (st.op === "type" && st.target?.path && st.value !== undefined && !st.partial) {
            const final = redact(st.value);
            const trail = this.trail.get(snapKey) ?? [];
            for (let i = trail.length - 1; i >= 0; i--) {
                const t = trail[i];
                if (st.ts - t.ts > 60_000) break;
                const f = t.els.find((e) => e.p === st.target!.path);
                if (!f) continue;
                const v = f.v ?? "";
                if (v && final.startsWith(v)) continue; // mid-typing
                before = t.hash;
                break;
            }
        }
        const ep = this.episodeFor(st);
        const secure = !!st.target?.secure;
        const target = st.target ? { ...st.target, value: undefined, caret: undefined } : undefined; // the value lives in its own column
        const r = this.q.stepPut.run(
            st.ts,
            st.app,
            st.window ? redact(st.window) : null,
            st.url ? redact(st.url) : null,
            screenKind({ app: st.app, url: st.url, window: st.window }),
            st.op,
            st.by,
            st.target ? elSig(st.app, st.target) : null,
            target ? JSON.stringify(target) : null,
            secure ? null : (redact(st.value) ?? null),
            secure ? null : (redact(st.before) ?? null),
            before,
            ep,
            st.ghostId ?? null,
            st.partial ? 1 : 0,
        );
        const id = Number(r.lastInsertRowid);
        const list = this.awaitingAfter.get(snapKey) ?? [];
        list.push({ id, ts: st.ts, snap: before });
        this.awaitingAfter.set(snapKey, list);
        return id;
    }

    private episodeFor(st: StepIn): number {
        const e = this.episode;
        if (e && e.app === st.app && st.ts - e.lastTs <= EPISODE_GAP_MS) {
            e.lastTs = st.ts;
            this.q.epTouch.run(st.ts, e.id);
            return e.id;
        }
        const r = this.q.epNew.run(st.ts, st.ts, st.app, st.window ? redact(st.window) : null);
        const id = Number(r.lastInsertRowid);
        this.q.epTouch.run(st.ts, id);
        this.episode = { id, app: st.app, lastTs: st.ts };
        return id;
    }

    ghostShown(g: { id: string; ts: number; action: Action; latencyMs: number }): void {
        const snap = this.lastSnap.get(g.action.app) ?? (g.action.url ? this.lastSnap.get(`web:${g.action.url}`) : undefined) ?? null;
        this.q.ghostPut.run(g.id, g.ts, g.action.app, g.action.source, g.action.confidence, g.action.label,
            JSON.stringify(g.action, (k, v) => (k === "value" && typeof v === "string" ? redact(v) : v)), snap, g.latencyMs);
    }

    ghostOutcome(id: string, outcome: "accepted" | "dismissed" | "ignored", ts = Date.now()): void {
        this.q.ghostOutcome.run(outcome, ts, id);
    }

    snapshot(hash: string): Snapshot | null {
        const r = this.q.snapRead.get(hash) as { hash: string; app: string; window: string; url: string | null; source: string | null; data: Uint8Array; base: string | null } | undefined;
        if (!r) return null;
        const raw = JSON.parse(zstdDecompressSync(r.data).toString());
        const source = (r.source ?? "ax") as Snapshot["source"];
        if (!r.base) return { hash: r.hash, app: r.app, window: r.window, url: r.url, source, els: raw };
        const base = this.snapshot(r.base);
        if (!base) return null;
        const delta = raw as Delta;
        const els = base.els.slice(0, delta.n);
        for (const [i, e] of delta.d) els[i] = e;
        return { hash: r.hash, app: r.app, window: r.window, url: r.url, source, els };
    }

    steps(opts: { since?: number; until?: number; app?: string; limit?: number } = {}): StepRow[] {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (opts.since !== undefined) (where.push("ts >= ?"), args.push(opts.since));
        if (opts.until !== undefined) (where.push("ts < ?"), args.push(opts.until));
        if (opts.app) (where.push("app = ?"), args.push(opts.app));
        const sql = `SELECT * FROM steps ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts, id ${opts.limit ? "LIMIT " + Math.floor(opts.limit) : ""}`;
        return (this.db.prepare(sql).all(...args) as any[]).map((r) => ({ ...r, target: r.target ? JSON.parse(r.target) : null }));
    }

    stats(): { snapshots: number; seen: number; steps: number; episodes: number; ghosts: number; bytes: number; byApp: { app: string; n: number }[] } {
        const one = (sql: string) => Object.values(this.db.prepare(sql).get() as object)[0] as number;
        return {
            snapshots: one("SELECT COUNT(*) FROM snapshots"),
            seen: one("SELECT COALESCE(SUM(seen), 0) FROM snapshots"),
            steps: one("SELECT COUNT(*) FROM steps"),
            episodes: one("SELECT COUNT(*) FROM episodes"),
            ghosts: one("SELECT COUNT(*) FROM ghosts"),
            bytes: one("SELECT COALESCE(SUM(LENGTH(data)), 0) FROM snapshots"),
            byApp: this.db.prepare("SELECT app, COUNT(*) AS n FROM steps GROUP BY app ORDER BY n DESC").all() as { app: string; n: number }[],
        };
    }

    /** Finished episodes (no step for `quietMs`) with ≥ 3 steps and no summary yet, oldest first. */
    episodesToSummarize(now = Date.now(), limit = 5, quietMs = 10 * 60_000): { id: number; app: string; window: string | null; steps: StepRow[] }[] {
        const eps = this.db.prepare("SELECT id, app, window FROM episodes WHERE summary IS NULL AND n_steps >= 3 AND end_ts < ? ORDER BY id LIMIT ?").all(now - quietMs, limit) as { id: number; app: string; window: string | null }[];
        return eps.map((e) => ({
            ...e,
            steps: (this.db.prepare("SELECT * FROM steps WHERE episode = ? ORDER BY ts LIMIT 40").all(e.id) as any[]).map((r) => ({ ...r, target: r.target ? JSON.parse(r.target) : null })),
        }));
    }

    setEpisodeSummary(id: number, summary: string, vec?: Float32Array): void {
        this.db.exec("CREATE TABLE IF NOT EXISTS episode_vecs (id INTEGER PRIMARY KEY, vec BLOB)");
        this.db.prepare("UPDATE episodes SET summary = ? WHERE id = ?").run(summary, id);
        if (vec) this.db.prepare("INSERT OR REPLACE INTO episode_vecs (id, vec) VALUES (?, ?)").run(id, new Uint8Array(vec.buffer));
    }

    /** Summarised episodes, newest first, with their embedding when there is one. */
    episodes(limit = 50): { id: number; start_ts: number; end_ts: number; app: string; n_steps: number; summary: string; vec?: Float32Array }[] {
        this.db.exec("CREATE TABLE IF NOT EXISTS episode_vecs (id INTEGER PRIMARY KEY, vec BLOB)");
        return (this.db.prepare(
            "SELECT e.id, e.start_ts, e.end_ts, e.app, e.n_steps, e.summary, v.vec FROM episodes e LEFT JOIN episode_vecs v ON v.id = e.id WHERE e.summary IS NOT NULL AND e.summary != '' ORDER BY e.end_ts DESC LIMIT ?",
        ).all(limit) as any[]).map((r) => ({ ...r, vec: r.vec ? new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)) : undefined }));
    }

    /**
     * The Consolidator, run at hub start and every few hours.
     *   screens  kept `screenDays` (30): older ones are deleted; a newer screen delta-encoded on a deleted one is
     *            rewritten as a full keyframe first, so every kept screen still decodes
     *   steps    kept `stepDays` (90), except form fills (type steps into fields), which are what field facts are
     *            made of: those stay, with their screen links cleared
     *   ghosts   kept `stepDays`
     * Returns what it removed. VACUUMs when it freed a lot.
     */
    consolidate(o: { now?: number; screenDays?: number; stepDays?: number } = {}): { screens: number; rekeyed: number; steps: number; ghosts: number } {
        const now = o.now ?? Date.now();
        const screenCut = now - (o.screenDays ?? 30) * 86_400_000;
        const stepCut = now - (o.stepDays ?? 90) * 86_400_000;
        const out = { screens: 0, rekeyed: 0, steps: 0, ghosts: 0 };
        this.db.exec("BEGIN");
        try {
            const doomed = new Set((this.db.prepare("SELECT hash FROM snapshots WHERE last_ts < ?").all(screenCut) as { hash: string }[]).map((r) => r.hash));
            if (doomed.size) {
                // Kept screens whose delta chain runs through a doomed one become keyframes.
                const kept = this.db.prepare("SELECT hash, base FROM snapshots WHERE last_ts >= ? AND base IS NOT NULL").all(screenCut) as { hash: string; base: string }[];
                const rekey = this.db.prepare("UPDATE snapshots SET data = ?, base = NULL, depth = 0 WHERE hash = ?");
                for (const k of kept) {
                    let b: string | null = k.base, hits = false;
                    for (let i = 0; b && i < 64; i++) {
                        if (doomed.has(b)) { hits = true; break; }
                        b = (this.db.prepare("SELECT base FROM snapshots WHERE hash = ?").get(b) as { base: string | null } | undefined)?.base ?? null;
                    }
                    if (!hits) continue;
                    const full = this.snapshot(k.hash);
                    if (full) (rekey.run(zstdCompressSync(Buffer.from(JSON.stringify(full.els))), k.hash), out.rekeyed++);
                }
                // Depths downstream of a new keyframe are now overestimates, which is harmless (an earlier keyframe).
                const del = this.db.prepare("DELETE FROM snapshots WHERE hash = ?");
                for (const h of doomed) out.screens += Number(del.run(h).changes);
                this.db.prepare(`UPDATE steps SET before_snap = NULL WHERE before_snap IS NOT NULL AND before_snap NOT IN (SELECT hash FROM snapshots)`).run();
                this.db.prepare(`UPDATE steps SET after_snap = NULL WHERE after_snap IS NOT NULL AND after_snap NOT IN (SELECT hash FROM snapshots)`).run();
            }
            out.steps = Number(this.db.prepare(
                `DELETE FROM steps WHERE ts < ? AND NOT (op = 'type' AND partial = 0 AND value IS NOT NULL AND length(value) <= 200 AND target LIKE '%"role":"text%')`,
            ).run(stepCut).changes);
            out.ghosts = Number(this.db.prepare("DELETE FROM ghosts WHERE ts < ?").run(stepCut).changes);
            this.db.prepare("DELETE FROM episodes WHERE end_ts < ? AND id NOT IN (SELECT DISTINCT episode FROM steps WHERE episode IS NOT NULL)").run(stepCut);
            this.db.exec("COMMIT");
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        this.lastSnap.clear();
        this.lastEls.clear();
        this.trail.clear();
        if (out.screens + out.steps > 5000) this.db.exec("VACUUM");
        return out;
    }

    /** `tab forget`: drop everything recorded for an app and/or since a time. */
    forget(opts: { app?: string; since?: number }): number {
        const where: string[] = [];
        const args: (string | number)[] = [];
        if (opts.app) (where.push("app = ?"), args.push(opts.app));
        if (opts.since !== undefined) (where.push("ts >= ?"), args.push(opts.since));
        if (!where.length) throw new Error("forget needs an app or a time");
        const w = where.join(" AND ");
        const n = Number(this.db.prepare(`DELETE FROM steps WHERE ${w}`).run(...args).changes);
        this.db.prepare(`DELETE FROM ghosts WHERE ${w}`).run(...args);
        const sw = w.replace(/\bts\b/g, "first_ts");
        this.db.prepare(`DELETE FROM snapshots WHERE ${sw}`).run(...args);
        this.db.prepare(`DELETE FROM episodes WHERE ${w.replace(/\bts\b/g, "start_ts")}`).run(...args);
        this.lastSnap.clear();
        this.lastEls.clear();
        this.trail.clear();
        this.awaitingAfter.clear();
        // Deltas whose base was deleted can't be decoded any more: drop them too.
        for (;;) {
            const c = Number(this.db.prepare("DELETE FROM snapshots WHERE base IS NOT NULL AND base NOT IN (SELECT hash FROM snapshots)").run().changes);
            if (!c) break;
        }
        return n;
    }

    close(): void {
        this.db.close();
    }
}
