import React from "react";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from "remotion";
import { Card, Intro, UseCases } from "./Cards";
import { EndCard } from "./EndCard";
import { ScreenScene, segFrames, outFrame, type Cam, type Cap, type Seg } from "./Screen";
import { FPS } from "./theme";

// ---------- the edit: source seconds from rec/takes (see public/takes/*.json) ----------

export const TICKETS = {
  src: "takes/tickets.mp4",
  segs: [
    { from: 2.7, to: 6.0, rate: 1.1 }, // you set Qty 2
    { from: 6.0, to: 7.0 }, // ghost: Click Checkout
    { from: 7.0, to: 7.0, hold: 1.6 },
    { from: 7.0, to: 8.0 }, // tab
    { from: 8.0, to: 9.0, rate: 1.25 },
    { from: 9.0, to: 10.5 }, // Click Buy tickets → tab
    { from: 10.5, to: 11.4 }, // Pay $0.30
    { from: 11.4, to: 11.4, hold: 1.8 },
    { from: 11.4, to: 12.6 }, // tab
    { from: 12.6, to: 14.0, rate: 1.4 }, // settling on Tempo
    { from: 14.0, to: 15.5 }, // Paid ✓, two tickets
    { from: 15.5, to: 16.0, rate: 1.5 },
    { from: 16.0, to: 17.0 }, // Dock ghost
    { from: 17.0, to: 17.0, hold: 1.4 },
    { from: 17.0, to: 17.8 }, // tab
    { from: 17.8, to: 21.4 }, // Calendar fills itself in
  ] as Seg[],
  cams: [
    { t: 2.7, x: 560, y: 520, z: 1.3 },
    { t: 5.2, x: 300, y: 730, z: 2.2 },
    { t: 8.0, x: 300, y: 730, z: 2.2 },
    { t: 9.0, x: 880, y: 515, z: 2.2 },
    { t: 12.6, x: 880, y: 515, z: 2.2 },
    { t: 13.6, x: 600, y: 520, z: 1.35 },
    { t: 15.6, x: 600, y: 520, z: 1.35 },
    { t: 16.4, x: 520, y: 785, z: 2.0 },
    { t: 17.8, x: 520, y: 785, z: 2.0 },
    { t: 18.6, x: 330, y: 300, z: 1.8 },
    { t: 19.8, x: 330, y: 300, z: 1.8 },
    { t: 20.7, x: 760, y: 600, z: 1.35 },
  ] as Cam[],
  keys: [{ t: 7.68 }, { t: 10.4 }, { t: 12.44 }, { t: 17.74 }],
  caps: [
    { t: 2.7, until: 6.2, text: "Tab watches what you do", sub: "Here you're buying tickets: you set the quantity to 2" , at: "top" },
    { t: 6.25, until: 8.05, text: "It predicts your next click", sub: "The red ghost says “Click Checkout”. Press Tab to do it." , at: "top" },
    { t: 8.05, until: 10.55, text: "Tab again: Buy tickets", sub: "One keystroke per step" },
    { t: 10.55, until: 12.6, text: "Checkout asks for payment (HTTP 402)", sub: "Tab checks it matches the page, then offers: Pay $0.30", tone: "blue" },
    { t: 12.6, until: 15.55, text: "Paid $0.30 on Tempo testnet", sub: "Only because you pressed Tab", tone: "green" },
    { t: 15.95, until: 17.8, text: "Next likely step: your calendar", sub: "You just booked a show, so Tab offers “Add Night Owls · Fri 9pm to Calendar”" , at: "top" },
    { t: 17.8, until: 21.4, text: "Tab fills in Calendar for you", sub: "Night Owls at Hall 9, Friday 9 pm" },
  ] as Cap[],
  blurs: [{ from: 19.6, to: 20.3, x: 1200, y: 530, w: 175, h: 245 }],
};

export const RESALE = {
  src: "takes/resale.mp4",
  segs: [
    { from: 2.4, to: 3.9 },
    { from: 3.9, to: 4.6 },
    { from: 4.6, to: 4.6, hold: 2.0 },
    { from: 4.6, to: 8.8 },
  ] as Seg[],
  cams: [
    { t: 2.4, x: 800, y: 420, z: 1.6 },
    { t: 3.9, x: 900, y: 425, z: 2.3 },
    { t: 8.8, x: 900, y: 425, z: 2.3 },
  ] as Cam[],
  keys: [{ t: 3.82 }, { t: 6.22 }, { t: 8.17, label: "esc" }],
  caps: [
    { t: 2.4, until: 4.0, text: "Same show, on a resale site", sub: "Tab clicks Buy tickets" },
    { t: 4.0, until: 8.8, text: "Blocked: the 402 asks $0.51", sub: "The page says $0.30, so Tab won't pay. Tab does nothing; Esc dismisses.", tone: "red" },
  ] as Cap[],
};

export const PUSH = {
  src: "takes/push.mp4",
  segs: [
    { from: 1.3, to: 6.0, rate: 1.5 }, // you type git push
    { from: 6.0, to: 8.3 }, // output + ghost: Open pull request
    { from: 8.3, to: 8.3, hold: 1.6 },
    { from: 8.3, to: 9.6 }, // tab
    { from: 9.6, to: 11.3, rate: 1.5 }, // Chrome opens GitHub's PR page
    { from: 11.3, to: 12.2 }, // gray ghost description
    { from: 12.2, to: 12.2, hold: 2.0 },
    { from: 12.2, to: 14.95, rate: 1.2 }, // tab
    { from: 14.95, to: 16.2 }, // ghost: Create pull request
    { from: 16.2, to: 16.2, hold: 1.4 },
    { from: 16.2, to: 17.2 }, // tab
    { from: 17.2, to: 20.2, rate: 2 }, // GitHub creates the PR
    { from: 20.2, to: 22.2 }, // PR #4 open
  ] as Seg[],
  cams: [
    { t: 1.3, x: 1090, y: 330, z: 1.9 },
    { t: 6.4, x: 1090, y: 330, z: 1.9 },
    { t: 7.6, x: 1060, y: 560, z: 1.45 },
    { t: 9.6, x: 1060, y: 560, z: 1.45 },
    { t: 10.4, x: 390, y: 470, z: 1.15 },
    { t: 11.0, x: 390, y: 470, z: 1.15 },
    { t: 11.6, x: 380, y: 705, z: 1.9 },
    { t: 15.0, x: 380, y: 705, z: 1.9 },
    { t: 15.6, x: 470, y: 470, z: 2.0 },
    { t: 17.2, x: 470, y: 470, z: 2.0 },
    { t: 19.6, x: 470, y: 470, z: 2.0 },
    { t: 20.4, x: 505, y: 400, z: 1.8 },
  ] as Cam[],
  keys: [{ t: 9.47 }, { t: 14.82 }, { t: 17.05 }],
  caps: [
    { t: 1.3, until: 7.9, text: "You push a branch in Terminal", sub: "git push prints a link for opening a pull request" },
    { t: 7.95, until: 9.6, text: "Tab reads your Terminal", sub: "The ghost says “Open pull request”. Press Tab.", at: "top" },
    { t: 9.6, until: 11.45, text: "Chrome opens the pull request page", sub: "Tab switched apps for you" },
    { t: 11.5, until: 14.95, text: "It writes the description", sub: "Gray ghost text, drafted from the commits you pushed. Tab accepts it." },
    { t: 15.55, until: 17.2, text: "Then: Click Create pull request", sub: "Press Tab" },
    { t: 17.2, until: 22.2, text: "Pull request opened", sub: "From git push to PR: three presses of Tab, no typing", tone: "green", at: "top" },
  ] as Cap[],
};

export const RELEASE = {
  src: "takes/release.mp4",
  segs: [
    { from: 0.6, to: 2.6 }, // the setup: release notes + tracker
    { from: 2.6, to: 10.9, rate: 2.5 }, // you do ticket 1 by hand
    { from: 10.9, to: 11.6 }, // Repeat for ENG-150
    { from: 11.6, to: 11.6, hold: 1.8 },
    { from: 11.6, to: 13.15 }, // tab
    { from: 13.15, to: 17.2, rate: 1.8 }, // Tab does the 4 steps
    { from: 17.2, to: 18.6 }, // Repeat for ENG-151 → tab
    { from: 18.6, to: 22.7, rate: 2.2 },
    { from: 22.7, to: 23.5 }, // Do the remaining 3
    { from: 23.5, to: 23.5, hold: 1.4 },
    { from: 23.5, to: 24.45 }, // tab
    { from: 24.45, to: 34.6, rate: 3 },
    { from: 34.6, to: 37.6 }, // six Done
  ] as Seg[],
  cams: [
    { t: 0.6, x: 720, y: 520, z: 1.08 },
    { t: 2.3, x: 720, y: 520, z: 1.08 },
    { t: 3.6, x: 1010, y: 505, z: 2.0 },
    { t: 34.9, x: 1010, y: 505, z: 2.0 },
    { t: 36.3, x: 720, y: 560, z: 1.05 },
  ] as Cam[],
  keys: [{ t: 12.9 }, { t: 18.43 }, { t: 24.23 }],
  caps: [
    { t: 0.6, until: 2.6, text: "6 shipped tickets to close", sub: "Release notes on the left, the team's tracker on the right" },
    { t: 2.6, until: 10.95, text: "First, you close ticket 1 by hand", sub: "Search it, set Done, link PR #12, Save" },
    { t: 11.3, until: 13.15, text: "Tab learned the steps", sub: "“Repeat for ENG-150 · #13”: press Tab", tone: "green" },
    { t: 13.15, until: 22.7, text: "It repeats all four steps itself", sub: "No model call: it replays what you did, for the next ticket" },
    { t: 22.75, until: 24.45, text: "Then: Do the remaining 3", sub: "One keystroke for the rest" },
    { t: 24.45, until: 34.6, text: "Tab works through the list" },
    { t: 34.6, until: 37.6, text: "6 of 6 done", sub: "You did one ticket. Tab did five.", tone: "green" },
  ] as Cap[],
};

const sec = (s: number) => Math.round(s * FPS);
const T = 14; // crossfade frames

// The second demo after the ticket purchase: release day (repeat) or git push → PR.
export type Second = "release" | "pr";
export const SECOND = {
  release: { scene: RELEASE, card: { kicker: "Repetitive work", solid: "Do it once.", ghost: " Tab does the rest." }, tabDid: 121, youDid: 33 },
  pr: { scene: PUSH, card: { kicker: "Across apps", solid: "From git push", ghost: " to pull request." }, tabDid: 154, youDid: 52 },
};
export function durations(second: Second) {
  return {
    intro: sec(4.4),
    tickets: segFrames(TICKETS.segs, FPS),
    card2: sec(1.7),
    demo2: segFrames(SECOND[second].scene.segs, FPS),
    end: sec(4.8),
  };
}
export const total = (second: Second) => {
  const D = durations(second);
  return Object.values(D).reduce((a, b) => a + b, 0) - T * (Object.keys(D).length - 1);
};

// Start frame of each scene in the final timeline (for sound effects).
function starts(D: ReturnType<typeof durations>) {
  const keys = Object.keys(D) as (keyof typeof D)[];
  const out: Record<string, number> = {};
  let f = 0;
  keys.forEach((k, i) => {
    out[k] = f;
    f += D[k] - (i < keys.length - 1 ? T : 0);
  });
  return out;
}

export const Main: React.FC<{ second: Second }> = ({ second }) => {
  const { fps } = useVideoConfig();
  const D = durations(second);
  const st = starts(D);
  const { scene, card, tabDid, youDid } = SECOND[second];
  const keyFrames = [
    ...TICKETS.keys.map((k) => st.tickets + outFrame(TICKETS.segs, k.t, fps)),
    ...scene.keys.map((k) => st.demo2 + outFrame(scene.segs, k.t, fps)),
  ];
  const cardPress = [st.card2].map((f) => f + Math.round(0.95 * fps));
  return (
    <AbsoluteFill style={{ background: "#0A0A0B" }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={D.intro} premountFor={fps}>
          <Intro />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={D.tickets} premountFor={fps}>
          <ScreenScene {...TICKETS} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={D.card2} premountFor={fps}>
          <Card {...card} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={D.demo2} premountFor={fps}>
          <ScreenScene {...scene} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={D.end} premountFor={fps}>
          <EndCard tabDid={tabDid} youDid={youDid} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Audio src={staticFile("music.wav")} volume={0.42} />
      {[...keyFrames, ...cardPress, st.intro + Math.round(1.55 * fps), st.intro + Math.round(2.6 * fps) + 36].map((f, i) => (
        <Sequence key={`k${i}`} from={f} durationInFrames={fps} layout="none">
          <Audio src={staticFile("sfx/key.wav")} volume={0.7} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// Single-demo cut: just the ticket purchase, played slower with longer freeze-frames.
export const TICKETS_SOLO = {
  ...TICKETS,
  segs: [
    { from: 2.7, to: 6.0, rate: 0.85 }, // you set Qty 2
    { from: 6.0, to: 7.0 }, // ghost: Click Checkout
    { from: 7.0, to: 7.0, hold: 1.7 },
    { from: 7.0, to: 9.8 }, // tab, then ghost: Click Buy tickets
    { from: 9.8, to: 9.8, hold: 0.6 },
    { from: 9.8, to: 11.4 }, // tab → Pay $0.30
    { from: 11.4, to: 11.4, hold: 2.4 },
    { from: 11.4, to: 12.6 }, // tab
    { from: 12.6, to: 15.0 }, // settling on Tempo → Paid ✓
    { from: 15.0, to: 15.0, hold: 0.8 },
    { from: 15.0, to: 17.0 }, // Dock ghost
    { from: 17.0, to: 17.0, hold: 2.6 },
    { from: 17.0, to: 17.8 }, // tab
    { from: 17.8, to: 23.0 }, // Calendar fills itself in, then rests on the event
  ] as Seg[],
  cams: [...TICKETS.cams, { t: 21.3, x: 760, y: 600, z: 1.35 }, { t: 23.0, x: 900, y: 660, z: 1.75 }] as Cam[],
  caps: [
    { t: 2.7, until: 6.2, text: "Tab watches what you do", sub: "Here, you're buying 2 tickets", at: "top" },
    { t: 6.25, until: 8.05, text: "It predicts your next click", sub: "Press Tab to click Checkout", at: "top" },
    { t: 8.05, until: 10.55, text: "Tab again: Buy tickets", sub: "One keystroke per step" },
    { t: 10.55, until: 12.6, text: "Checkout asks for payment (HTTP 402)", sub: "Tab checks the price matches the page", tone: "blue" },
    { t: 12.6, until: 15.6, text: "Paid $0.30 on Tempo testnet", sub: "Only because you pressed Tab", tone: "green" },
    { t: 15.7, until: 17.8, text: "Booked a show? Next: Calendar", sub: "That's the likely next step, so Tab suggests it", at: "top" },
    { t: 17.8, until: 23.0, text: "Tab fills in Calendar for you", sub: "Night Owls at Hall 9, Friday 9 pm" },
  ] as Cap[],
};
export const USES = [
  { title: "Pull requests", sub: "git push → description written → PR opened" },
  { title: "Repetitive work", sub: "do one ticket, Tab repeats the rest" },
  { title: "Safe payments", sub: "won't pay if the price doesn't match the page" },
];
const PACE = 1.15; // the solo intro runs 15% slower
const SOLO_D = { intro: sec(5.6), tickets: segFrames(TICKETS_SOLO.segs, FPS), uses: sec(4.8), end: sec(4.8) };
export const soloTotal = Object.values(SOLO_D).reduce((a, b) => a + b, 0) - T * (Object.keys(SOLO_D).length - 1);

export const Solo: React.FC = () => {
  const { fps } = useVideoConfig();
  const st = starts(SOLO_D as unknown as ReturnType<typeof durations>);
  const keyFrames = TICKETS_SOLO.keys.map((k) => st.tickets + outFrame(TICKETS_SOLO.segs, k.t, fps));
  return (
    <AbsoluteFill style={{ background: "#0A0A0B" }}>
      <TransitionSeries>
        <TransitionSeries.Sequence durationInFrames={SOLO_D.intro} premountFor={fps}>
          <Intro pace={PACE} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={SOLO_D.tickets} premountFor={fps}>
          <ScreenScene {...TICKETS_SOLO} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={SOLO_D.uses} premountFor={fps}>
          <UseCases items={USES} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: T })} />
        <TransitionSeries.Sequence durationInFrames={SOLO_D.end} premountFor={fps}>
          <EndCard tabDid={36} youDid={7} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Audio src={staticFile("music.wav")} volume={(f) => 0.42 * Math.min(1, (soloTotal - f) / fps)} />
      {[...keyFrames, st.intro + Math.round(1.55 * PACE * fps), st.intro + Math.round(2.6 * PACE * fps) + 36].map((f, i) => (
        <Sequence key={`k${i}`} from={f} durationInFrames={fps} layout="none">
          <Audio src={staticFile("sfx/key.wav")} volume={0.7} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
