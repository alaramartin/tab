// Synthetic Accessibility screens for tests: a release-notes window with a table of tickets, and a tracker window
// where each ticket is closed by hand (search, open it, set Done, link the PR, Save).
import type { El, ScreenState } from "../../protocol/types.ts";

export const APP = "com.example.browser";
export const TICKETS = ["ENG-142", "ENG-150", "ENG-151", "ENG-155", "ENG-157", "ENG-160"];
export const PRS = ["#12", "#13", "#14", "#15", "#16", "#17"];
const r = (y = 0) => ({ x: 10, y, w: 120, h: 24 });

export function el(id: string, role: El["role"], label: string, extra: Partial<El> = {}): El {
    return { id, path: id, role, label, rect: r(), enabled: true, ...extra };
}

export function releaseWindow(ts: number): ScreenState {
    const elements: El[] = TICKETS.flatMap((t, i) => [
        el(`text:${t}`, "text", t, { list: { key: "desc:Notes", index: i, field: "text@0" }, grid: { row: i, col: 0 } }),
        el(`text:${PRS[i]}`, "text", PRS[i], { list: { key: "desc:Notes", index: i, field: "text@2" }, grid: { row: i, col: 2 } }),
    ]);
    return { type: "state", app: APP, window: "Release v1.4.0", elements, seq: 1, ts };
}

export function trackerWindow(ts: number, search = ""): ScreenState {
    const results = TICKETS.filter((t) => !search || t.toLowerCase().includes(search.toLowerCase()));
    return {
        type: "state",
        app: APP,
        window: "Tracker",
        seq: 2,
        ts,
        elements: [
            el("desc:Search", "textfield", "Search", { value: search, rect: r(10) }),
            ...results.map((t, i) => el(`desc:Result#${i}`, "button", `${t} In review`, { list: { key: "desc:Results", index: i, field: "button@-" }, rect: r(40 + i * 30) })),
            el("desc:Status", "select", "Status", { value: "In review", options: ["In review", "Done"], rect: r(300) }),
            el("desc:Linked PR", "textfield", "Linked PR", { rect: r(340) }),
            el("desc:Save", "button", "Save", { rect: r(380) }),
        ],
    };
}
