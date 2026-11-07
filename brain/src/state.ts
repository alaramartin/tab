import type { El, ScreenState } from "../../protocol/types.ts";

/** Screens are remembered this long after they were last seen (a list in another window feeds the next step). */
export const CACHE_MS = 600_000;

/** One screen per app and window. */
export function stateKey(s: { app: string; window?: string }): string {
    return `${s.app}|${s.window ?? ""}`;
}

/** Content signature: ignores rects, so window moves and scrolls don't re-trigger prediction. */
export function contentSig(s: ScreenState): string {
    return s.elements
        .map((e) => `${e.id}|${e.role}|${e.label}|${e.value ?? ""}|${e.checked ?? ""}|${e.enabled}`)
        .join("\n");
}

export class StateStore {
    private byKey = new Map<string, ScreenState>();
    frontmost: { app: string; window: string } | null = null;

    put(s: ScreenState): void {
        this.byKey.set(stateKey(s), s);
    }

    /** The front app's newest screen. */
    active(): ScreenState | undefined {
        const app = this.frontmost?.app;
        return app ? this.latest(app) : undefined;
    }

    /** An app's newest screen. */
    latest(app: string): ScreenState | undefined {
        let best: ScreenState | undefined;
        for (const s of this.byKey.values()) if (s.app === app && (!best || s.ts > best.ts)) best = s;
        return best;
    }

    /** Screens seen within CACHE_MS, newest first. */
    recent(now: number): ScreenState[] {
        return [...this.byKey.values()].filter((s) => now - s.ts <= CACHE_MS).sort((a, b) => b.ts - a.ts);
    }

    /** The screen a step acts on: that window of the app if we have it, else the app's newest screen. */
    forStep(app: string, window?: string): ScreenState | undefined {
        return (window !== undefined ? this.byKey.get(stateKey({ app, window })) : undefined) ?? this.latest(app);
    }
}

export function findEl(s: ScreenState | undefined, targetId?: string, targetPath?: string): El | undefined {
    if (!s) return undefined;
    if (targetPath) {
        const el = s.elements.find((e) => e.path === targetPath);
        if (el) return el;
    }
    if (targetId) return s.elements.find((e) => e.id === targetId);
    return undefined;
}
