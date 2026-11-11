// Small, lossless rewrites of a value between where it was read and where it was typed: case, digits only (a phone
// number without its punctuation), and dates in another format. Provenance records which one, so a replay applies
// the same rewrite to a new value.
export type Transform = "upper" | "lower" | "title" | "digits" | `date:${DateFmt}`;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export type DateFmt = "yyyy-mm-dd" | "m/d/yyyy" | "mm/dd/yyyy" | "d/m/yyyy" | "dd/mm/yyyy" | "dd.mm.yyyy" | "mm/dd/yy" | "mon d, yyyy" | "month d, yyyy" | "d mon yyyy" | "d month yyyy";
export interface Ymd { y: number; m: number; d: number }

const pad = (n: number) => String(n).padStart(2, "0");
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function formatDate(t: Ymd, fmt: DateFmt): string {
    const mon = cap(MONTHS[t.m - 1]);
    switch (fmt) {
        case "yyyy-mm-dd": return `${t.y}-${pad(t.m)}-${pad(t.d)}`;
        case "m/d/yyyy": return `${t.m}/${t.d}/${t.y}`;
        case "mm/dd/yyyy": return `${pad(t.m)}/${pad(t.d)}/${t.y}`;
        case "d/m/yyyy": return `${t.d}/${t.m}/${t.y}`;
        case "dd/mm/yyyy": return `${pad(t.d)}/${pad(t.m)}/${t.y}`;
        case "dd.mm.yyyy": return `${pad(t.d)}.${pad(t.m)}.${t.y}`;
        case "mm/dd/yy": return `${pad(t.m)}/${pad(t.d)}/${pad(t.y % 100)}`;
        case "mon d, yyyy": return `${mon.slice(0, 3)} ${t.d}, ${t.y}`;
        case "month d, yyyy": return `${mon} ${t.d}, ${t.y}`;
        case "d mon yyyy": return `${t.d} ${mon.slice(0, 3)} ${t.y}`;
        case "d month yyyy": return `${t.d} ${mon} ${t.y}`;
    }
}

function valid(y: number, m: number, d: number): Ymd | null {
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 ? { y, m, d } : null;
}

function month(s: string): number {
    const i = MONTHS.findIndex((m) => m.startsWith(s.toLowerCase()) && s.length >= 3);
    return i + 1;
}

/** Every reading of `s` as a date, with the format that reproduces `s` exactly. "3/4/2026" reads two ways. */
export function parseDate(s: string): { date: Ymd; fmt: DateFmt }[] {
    const v = s.trim();
    const out: { date: Ymd; fmt: DateFmt }[] = [];
    const add = (date: Ymd | null, fmt: DateFmt) => {
        if (date && formatDate(date, fmt) === v) out.push({ date, fmt });
    };
    let m: RegExpMatchArray | null;
    if ((m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/))) add(valid(+m[1], +m[2], +m[3]), "yyyy-mm-dd");
    else if ((m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
        for (const f of ["m/d/yyyy", "mm/dd/yyyy"] as const) add(valid(+m[3], +m[1], +m[2]), f);
        for (const f of ["d/m/yyyy", "dd/mm/yyyy"] as const) add(valid(+m[3], +m[2], +m[1]), f);
    } else if ((m = v.match(/^(\d{2})\/(\d{2})\/(\d{2})$/))) add(valid(2000 + +m[3], +m[1], +m[2]), "mm/dd/yy");
    else if ((m = v.match(/^(\d{2})\.(\d{2})\.(\d{4})$/))) add(valid(+m[3], +m[2], +m[1]), "dd.mm.yyyy");
    else if ((m = v.match(/^([A-Za-z]{3,9}) (\d{1,2}), (\d{4})$/))) {
        const date = valid(+m[3], month(m[1]), +m[2]);
        add(date, "mon d, yyyy");
        add(date, "month d, yyyy");
    } else if ((m = v.match(/^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/))) {
        const date = valid(+m[3], month(m[2]), +m[1]);
        add(date, "d mon yyyy");
        add(date, "d month yyyy");
    }
    // A day ≤ 12 written with one digit parses as both m/d and mm/dd only when padding doesn't matter; keep distinct dates.
    return out.filter((x, i) => out.findIndex((y) => y.fmt === x.fmt) === i);
}

function titleCase(s: string): string {
    return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
}

/** Apply a transform; undefined when the value doesn't fit it (a date transform on something that isn't a date). */
export function applyTransform(t: Transform, v: string): string | undefined {
    switch (t) {
        case "upper": return v.toUpperCase();
        case "lower": return v.toLowerCase();
        case "title": return titleCase(v);
        case "digits": {
            const d = v.replace(/\D/g, "");
            return d.length >= 4 ? d : undefined;
        }
        default: {
            const fmt = t.slice(5) as DateFmt;
            const p = parseDate(v)[0];
            return p ? formatDate(p.date, fmt) : undefined;
        }
    }
}

/** The transform that turns `from` into `to`, if one does (and they differ). Dates first, then digits, then case. */
export function findTransform(from: string, to: string): Transform | undefined {
    const a = from.trim(), b = to.trim();
    if (!a || !b || a === b) return undefined;
    const pa = parseDate(a), pb = parseDate(b);
    for (const x of pb) if (pa.some((y) => y.date.y === x.date.y && y.date.m === x.date.m && y.date.d === x.date.d && y.fmt !== x.fmt)) return `date:${x.fmt}`;
    if (/^\d{4,}$/.test(b) && /\D/.test(a) && a.replace(/\D/g, "") === b && /^[\d\s()+.-]+$/.test(a)) return "digits";
    if (/\p{L}/u.test(a) && a.toLowerCase() === b.toLowerCase()) {
        if (b === b.toUpperCase()) return "upper";
        if (b === b.toLowerCase()) return "lower";
        if (b === titleCase(b)) return "title";
    }
    return undefined;
}
