// Stable, value-free signatures for elements and screens. Used to dedupe snapshots, to key steps, and later to
// abstract steps into templates. Rects and ids never enter a signature (windows move; ids are positional).
import { createHash } from "node:crypto";
import type { El, ScreenState } from "../../../protocol/types.ts";

/** Lowercase, collapse whitespace, replace digit runs with '#', so "Row 12" and "Row 13" share a signature. */
export function norm(s: string | undefined, digits = true): string {
    let t = (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (digits) t = t.replace(/\d+/g, "#");
    return t.slice(0, 80);
}

/** The element as a kind of thing, not an instance: role + label + section + AX id (+ grid column). */
export function elSig(app: string, e: Pick<El, "role" | "label" | "section" | "axId" | "grid" | "placeholder" | "path">): string {
    const name = norm(e.label || e.placeholder);
    // An icon-only control with no AX id has nothing else to tell it apart: use its position in the window's tree.
    const where = !name && !e.axId && e.role !== "cell" && e.role !== "row" ? (e.path ?? "") : "";
    return [app, e.role, name, norm(e.section), e.axId ?? "", e.grid?.col ?? "", where].filter((x, i) => i < 6 || x).join("|");
}

/** Host for web pages, else the window title with digits folded: the "kind of screen". */
export function screenKind(s: { app: string; url?: string; window?: string }): string {
    if (s.url) {
        try {
            const u = new URL(s.url);
            return `${s.app}|${u.host}${u.pathname.replace(/\/\d+(?=\/|$)/g, "/#").replace(/\/[0-9a-f]{8,}(?=\/|$)/gi, "/*")}`;
        } catch {}
    }
    return `${s.app}|${norm(s.window)}`;
}

/** What a snapshot stores per element: meaning, no geometry. */
export type CompactEl = {
    r: El["role"];
    l: string;
    v?: string;
    s?: string;
    p?: string;
    c?: boolean;
    g?: El["grid"];
    ph?: string;
    f?: true;
    off?: true;
    o?: string[]; // select options
    li?: El["list"]; // web: item in a repeated structure (the pattern engine's provenance needs it)
};

export function compactEls(s: ScreenState, redact: (x: string) => string): CompactEl[] {
    return s.elements.map((e) => {
        const c: CompactEl = { r: e.role, l: e.label };
        if (e.value && !e.secure) c.v = redact(e.value.slice(0, 2000));
        if (e.section) c.s = e.section;
        if (e.path) c.p = e.path;
        if (e.checked !== undefined) c.c = e.checked;
        if (e.grid) c.g = e.grid;
        if (e.placeholder) c.ph = e.placeholder;
        if (e.focused) c.f = true;
        if (!e.enabled) c.off = true;
        if (e.list) c.li = e.list;
        if (e.options?.length) c.o = e.options.slice(0, 40);
        return c;
    });
}

export function sha1(s: string): string {
    return createHash("sha1").update(s).digest("hex");
}

/** Back from a stored element to an El (no geometry: rects are zero, the id is the path or the position). */
export function expandEls(els: CompactEl[]): El[] {
    return els.map((c, i) => ({
        id: c.p ?? `#${i}`,
        role: c.r,
        label: c.l,
        ...(c.v !== undefined ? { value: c.v } : {}),
        ...(c.c !== undefined ? { checked: c.c } : {}),
        ...(c.s ? { section: c.s } : {}),
        ...(c.g ? { grid: c.g } : {}),
        ...(c.ph ? { placeholder: c.ph } : {}),
        ...(c.f ? { focused: true } : {}),
        ...(c.li ? { list: c.li } : {}),
        ...(c.o ? { options: c.o } : {}),
        rect: { x: 0, y: 0, w: 0, h: 0 },
        enabled: !c.off,
        path: c.p,
    }));
}
