// tab-poster v2: its own cut of take t2. Times in source seconds of public/takes/t2.mp4, positions in screen points.
import { BLURS, FPS, makeEdit, type Cam, type Rect } from "./edit";

// Everything above the Dock. The Dock only shows while Tab points at Calendar's icon.
const NO_DOCK: Rect = { x: 0, y: 0, w: 1440, h: 824 };

export const EDIT_A2 = makeEdit({
  segs: [
    { from: 4.6, to: 6.6 }, // the whole window: qty 2 picked by hand; red Checkout ghost at 6.17
    { from: 6.6, to: 6.6, hold: 1.3 }, // every ghost gets a short, similar hold
    { from: 6.6, to: 7.75 }, // tab (7.59)
    { from: 7.75, to: 8.97, rate: 1.6 }, // checkout page loading
    { from: 8.97, to: 9.6 }, // Buy ghost
    { from: 9.6, to: 9.6, hold: 1.2 },
    { from: 9.6, to: 11.2 }, // tab (10.27), blue Pay ghost at 10.45
    { from: 11.2, to: 11.2, hold: 1.5 },
    { from: 11.2, to: 13.76 }, // tab (12.27), pays in real time, Paid at 13.76
    { from: 13.76, to: 16.4 }, // two tickets; Calendar ghost on the Dock icon at 15.56
    { from: 16.4, to: 16.4, hold: 2.0 },
    { from: 16.4, to: 17.5 }, // tab (17.38)
    { from: 17.5, to: 19.35, rate: 0.6 }, // Calendar opens, Tab types the quick event, the event's details pop up (slowed to follow)
    { from: 19.35, to: 19.35, hold: 1.2 }, // details: Night Owls at Hall 9, Oct 23, 9–10 PM
    // 19.35–20.05 cut: Calendar's picker lists the user's own calendars there
    { from: 20.05, to: 21.5 }, // the event on Friday
    { from: 21.5, to: 21.5, hold: 2.2 },
  ],
  presses: [
    { t: 7.59, what: "Checkout" },
    { t: 10.27, what: "Buy" },
    { t: 12.27, what: "Pay" },
    { t: 17.38, what: "Calendar" },
  ],
  caps: [
    { t: 4.6, until: 7.75, title: "Tab guesses your next click.", sub: "It boxes it in red. Press tab to do it." },
    { t: 7.75, until: 10.44, title: "Checkout, then Buy.", sub: "One press of tab each." },
    { t: 10.45, until: 13.76, title: "Tab pays the $0.30 in testnet stablecoin.", sub: "It first checks the charge matches the page." },
    { t: 13.76, until: 15.56, title: "Paid in 1.5 seconds." },
    { t: 15.56, until: 17.5, title: "It predicts across apps, too.", sub: "You bought tickets, so next is Calendar." },
    { t: 17.5, until: 20.05, title: "Tab opens Calendar and types the event." },
    { t: 20.05, until: 99, title: "Saved for Friday, 9\u00a0pm.", sub: "Four presses of tab in total." },
  ],
  blurs: BLURS,
  // The Dock slides into view (eased) when Tab points at it, and is gone again once Calendar opens.
  clip: (t) => {
    if (t < 15.56 || t >= 17.5) return NO_DOCK;
    const p = Math.min(1, (t - 15.56) / 0.6);
    return { ...NO_DOCK, h: NO_DOCK.h + (900 - NO_DOCK.h) * (p * p * (3 - 2 * p)) };
  },
});

// Smooth moves (v3): each ease finishes before the next freeze, so the camera never stops mid-move on a hold.
// z 0.875 = the whole browser window in the 1160 px wide viewport.
export const CAMS_A2: Cam[] = [
  { t: 0, x: 574, y: 430, z: 0.875 },
  { t: 5.4, x: 380, y: 600, z: 1.6 }, // in to Qty/Checkout before the ghost appears (6.17)
  { t: 7.75, x: 830, y: 430, z: 1.5 }, // across to the order panel as checkout loads
  { t: 10.3, x: 892, y: 500, z: 2.0 }, // in on Buy/Pay
  { t: 13.76, x: 400, y: 500, z: 1.4 }, // out to the two tickets
  { t: 15.56, x: 480, y: 620, z: 1.6 }, // down to the Dock as it slides into view
  { t: 17.45, x: 390, y: 200, z: 2.0 }, // up to Calendar's quick-event field
  { t: 18.95, x: 850, y: 600, z: 1.6, dur: 0.4 }, // across to the event's details
  { t: 20.05, x: 1060, y: 700, z: 2.2 }, // in on the saved event
];

// Cards around the screen scene, in seconds.
export const INTRO_S = 3.2;
export const INTRO_ACCEPT_S = 1.3;
export const ALSO_S2 = 9.0;
export const ALSO_GHOST_S = [0.3, 3.8]; // each line appears as a suggestion...
export const ALSO_ACCEPT_S = [1.2, 4.7]; // ...and is accepted with tab
export const END_S2 = 3.4;
export const TOTAL_A2 = Math.round((INTRO_S + ALSO_S2 + END_S2) * FPS) + EDIT_A2.frames;

export const ALSO2 = {
  head: "Tab isn't built for one task. Two more examples:",
  items: ["After a git push, it opens the pull request and writes the description.", "Close one ticket by hand; it learns the steps and closes the rest."],
};
