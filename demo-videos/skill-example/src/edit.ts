// The edit, shared by all three directions. Every time below is in SOURCE seconds of public/takes/t2.mp4
// (from rec/takes/t2.jsonl via rec/events.mjs); every position is in screen points (1440 × 900).

export const FPS = 60;
export const W = 1920;
export const H = 1080;
export const SW = 1440;
export const SH = 900;
export const SRC = "takes/t2.mp4";

// A piece of the take at `rate`, or a freeze-frame { from: t, to: t, hold: seconds } (still from rec/stills.sh).
export type Seg = { from: number; to: number; rate?: number; hold?: number };
export const SEGS: Seg[] = [
  { from: 4.6, to: 6.6 }, // qty 2 picked by hand; the red Checkout ghost appears at 6.17
  { from: 6.6, to: 6.6, hold: 4.3 }, // freeze on the first ghost while caption 1 is read
  { from: 6.6, to: 7.75 }, // tab (7.59)
  { from: 7.75, to: 8.97, rate: 1.6 }, // checkout page loading
  { from: 8.97, to: 11.2 }, // Buy ghost, tab (10.27), blue Pay ghost at 10.45
  { from: 11.2, to: 11.2, hold: 2.6 }, // freeze on Pay $0.30
  { from: 11.2, to: 12.4 }, // tab (12.27)
  { from: 12.4, to: 13.76, rate: 2 }, // paying (settles at 13.76)
  { from: 13.76, to: 14.8 }, // Paid, two tickets
  { from: 14.8, to: 14.8, hold: 1.3 },
  { from: 14.8, to: 16.4 }, // Calendar ghost on the Dock icon at 15.56
  { from: 16.4, to: 16.4, hold: 3.0 },
  { from: 16.4, to: 17.5 }, // tab (17.38)
  { from: 17.5, to: 18.95, rate: 1.5 }, // Calendar opens, Tab types the quick event
  // 18.95–20.05 cut: Calendar's picker lists the user's own calendars there
  { from: 20.05, to: 21.5 }, // the event on Friday 9 pm
  { from: 21.5, to: 21.5, hold: 2.6 },
];

// Real Tab presses (source seconds) and what they did.
export const PRESSES = [
  { t: 7.59, what: "Checkout" },
  { t: 10.27, what: "Buy" },
  { t: 12.27, what: "Pay" },
  { t: 17.38, what: "Calendar" },
];

// Captions. `ghost` is the part still in "suggested" state until `accept` (a Tab press): direction C greys it,
// B presses the caption's keycap, A stamps its keycap.
export type Cap = { t: number; until: number; title: string; titleGhost?: string; sub?: string; subGhost?: boolean; accept?: number };
export const CAPS: Cap[] = [
  { t: 6.17, until: 7.75, title: "The red box is Tab's guess at your next click.", sub: "Press tab and it clicks it.", subGhost: true, accept: 7.59 },
  { t: 7.75, until: 10.44, title: "Checkout, then Buy.", sub: "One tab each.", subGhost: true, accept: 10.27 },
  { t: 10.45, until: 13.76, title: "Hall 9 wants $0.30.", titleGhost: " Tab pays it.", sub: "In testnet stablecoin.", accept: 12.27 },
  { t: 13.76, until: 15.55, title: "Paid in 1.5 seconds.", sub: "Two tickets, no card form." },
  { t: 15.56, until: 18.95, title: "Tickets for Friday? Next: your calendar.", sub: "Tab points at Calendar in the Dock.", subGhost: true, accept: 17.38 },
  { t: 20.05, until: 99, title: "Friday, 9 pm. On your calendar.", sub: "Four steps, four presses of tab." },
];

// Dock badge counts are the user's (Reminders, Messages): blurred whenever the Dock is in frame.
export const BLURS = [
  { x: 534, y: 831, w: 28, h: 28 },
  { x: 1098, y: 831, w: 28, h: 28 },
];

export type Rect = { x: number; y: number; w: number; h: number };
export type EditDef = {
  segs: Seg[];
  presses: { t: number; what: string }[];
  caps: Cap[];
  blurs: Rect[];
  // Part of the screen to show at source time t (the rest is the viewport's ground), e.g. to keep the Dock out.
  clip?: (t: number) => Rect | null;
};
export type Edit = ReturnType<typeof makeEdit>;

// Timing helpers for one edit: output frames ↔ source seconds.
export function makeEdit(def: EditDef) {
  const segLen = (s: Seg) => Math.round((s.hold ?? (s.to - s.from) / (s.rate ?? 1)) * FPS);
  const frames = def.segs.reduce((n, s) => n + segLen(s), 0);
  // Output frame → { t: source seconds, seg }.
  const srcAt = (frame: number) => {
    let f0 = 0;
    for (const s of def.segs) {
      const n = segLen(s);
      if (frame < f0 + n) return { t: s.hold ? s.from : s.from + ((frame - f0) / FPS) * (s.rate ?? 1), seg: s, f0, n };
      f0 += n;
    }
    const s = def.segs[def.segs.length - 1];
    return { t: s.to, seg: s, f0: f0 - segLen(s), n: segLen(s) };
  };
  // Source seconds → output frame (first playing segment that contains t; else the hold at t; else -1).
  const outFrame = (t: number) => {
    let f0 = 0;
    for (const s of def.segs) {
      const n = segLen(s);
      if (!s.hold && t >= s.from && t <= s.to) return f0 + Math.round(((t - s.from) / (s.rate ?? 1)) * FPS);
      f0 += n;
    }
    f0 = 0;
    for (const s of def.segs) {
      if (s.hold && Math.abs(s.from - t) < 1e-6) return f0;
      f0 += segLen(s);
    }
    return -1;
  };
  const segments = () => {
    let f0 = 0;
    return def.segs.map((s) => {
      const r = { ...s, f0, n: segLen(s) };
      f0 += r.n;
      return r;
    });
  };
  return { ...def, frames, srcAt, outFrame, segments };
}

// v1 of every direction (tab-poster-v1, tab-ghost-v1, tab-accept-v1).
export const EDIT1 = makeEdit({ segs: SEGS, presses: PRESSES, caps: CAPS, blurs: BLURS });
export const SCREEN_FRAMES = EDIT1.frames;
export const srcAt = EDIT1.srcAt;
export const outFrame = EDIT1.outFrame;
export const segments = EDIT1.segments;
export const stillPath = (t: number) => SRC.replace(/\.mp4$/, `-still-${t.toFixed(2)}.jpg`);

// Cards after the screen scene (seconds), same for every direction.
export const ALSO_S = 6.4;
export const END_S = 3.8;
export const TOTAL = SCREEN_FRAMES + Math.round((ALSO_S + END_S) * FPS);

export const ALSO = [
  "After git push, it opens the pull request and writes the description.",
  "Close one ticket by hand. Tab closes the other five.",
];
export const SIGNOFF = { line: "Built at Paradigm Frontiers 2026.", follow: "Follow @alara_martin_ for the release." };

// Camera keys in source seconds. cut: jump at t instead of easing from the previous key.
// z: zoom where 1 = the full screen height fills the viewport height.
export type Cam = { t: number; x: number; y: number; z: number; cut?: boolean; dur?: number }; // dur: this ease's length in source seconds
