// STRETCH (branch stretch/calendar-native; never merge into main without explicit human permission):
// cross-app memory. After a paid order for something with a day and time on the page, offer to add it to Calendar.
import type { ScreenState } from "../../protocol/types.ts";
import type { PatternAction, Step } from "./pattern.ts";
import { CHROME } from "./state.ts";

export const CALENDAR = "com.apple.iCal";
/** The calendar Tab files demo events into (human's choice: a dedicated calendar, never their own). */
export const CALENDAR_NAME = process.env.TAB_CALENDAR_NAME || "Tab Demo";

const DAY = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i;
const SKIP = /^(checkout|cart|basket|order|payment|confirm(ation)?|receipt)$/i;

export interface EventInfo {
    title: string; // "Night Owls"
    venue?: string; // "Hall 9"
    when: string; // "Fri 9pm"
}

/** "Checkout · Night Owls · Hall 9" + "Friday 9 pm" somewhere on the page → { Night Owls, Hall 9, Fri 9pm }. */
export function eventFrom(page: ScreenState): EventInfo | null {
    let when: string | undefined;
    for (const e of page.elements) {
        const m = `${e.label}`.match(DAY);
        if (m) {
            when = `${m[1][0].toUpperCase()}${m[1].slice(1, 3).toLowerCase()} ${m[2]}${m[3] ? `:${m[3]}` : ""}${m[4].toLowerCase()}m`;
            break;
        }
    }
    if (!when) return null;
    const parts = (page.window || "").split(" · ").map((p) => p.trim()).filter((p) => p && !SKIP.test(p));
    if (!parts.length) return null;
    return { title: parts[0], venue: parts[1], when };
}

/**
 * One sequence: Calendar → Add Event → type the quick event (Calendar parses the date) → Return creates it → file it in
 * CALENDAR_NAME → Return again finalizes it (closes the event popover, like a person pressing Enter) → Escape deselects
 * it → stay in Calendar, so the audience sees the confirmed event. Only after a failure does Tab switch back to Chrome.
 */
export function calendarOffer(ev: EventInfo, back = CHROME): PatternAction {
    const text = `${ev.title}${ev.venue ? ` at ${ev.venue}` : ""} ${ev.when}`;
    const step = (s: Partial<Step> & Pick<Step, "op" | "app">): Step => ({ label: "", confidence: 1, source: "pattern", ...s });
    const steps: Step[] = [
        step({ op: "click", app: CALENDAR, targetId: "desc:Add Event", targetPath: "desc:Add Event" }),
        step({ op: "type", app: CALENDAR, targetId: "id:QuickEventCell", targetPath: "id:QuickEventCell", value: text }),
        step({ op: "key", app: CALENDAR, value: "Return" }),
        // Optional: right after Calendar launches (still syncing) Return saves the event without opening its popover.
        // Tab Demo is Calendar's default for new events, so the event still lands there.
        step({ op: "type", app: CALENDAR, targetId: "id:calendar-button", targetPath: "id:calendar-button", value: CALENDAR_NAME, optional: true }),
        // Finalize: Return in the event's title field commits it and closes the popover (only if the popover is open).
        step({ op: "key", app: CALENDAR, targetId: "id:title-field", targetPath: "id:title-field", value: "Return", optional: true }),
        // Deselect, so it shows as a confirmed event. Never while the popover is open: Escape there discards the event.
        step({ op: "key", app: CALENDAR, value: "Escape", unlessPresent: "id:title-field" }),
        step({ op: "switch_app", app: back, value: back, onFail: true }),
    ];
    return { op: "sequence", app: CALENDAR, steps, label: `Add ${ev.title} · ${ev.when} to Calendar`, confidence: 0.9, source: "pattern", sig: `calendar|${text}` };
}
