import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, staticFile, useCurrentFrame } from "remotion";
import { ALSO, ALSO_S, FPS, SCREEN_FRAMES, SIGNOFF, TOTAL, type Cam } from "./edit";
import { KeySfx, SF, capAt, useFonts } from "./common";
import { ScreenView } from "./Screen";

// Direction C, "gray text that gets accepted": locked-off shots joined by hard cuts (no camera moves at all) above a
// light band of Newsreader (the release tracker's face). The part of a caption Tab is about to do sits in Tab's
// ghost-text gray with a keycap, and turns to ink on the frame the real Tab key is pressed.
const PAPER = "#EEEFF1", INK = "#151517", GHOST = "#8E8E93", SUB = "#4a4a50";
const NEWS = `Newsreader, Georgia, serif`;

const CAMS: Cam[] = [
  { t: 0, x: 480, y: 700, z: 2.37 },
  { t: 7.75, x: 700, y: 480, z: 2.84, cut: true },
  { t: 13.76, x: 560, y: 520, z: 2.13, cut: true },
  { t: 15.6, x: 560, y: 689, z: 2.13, cut: true },
  { t: 17.5, x: 400, y: 300, z: 2.37, cut: true },
  { t: 20.05, x: 1060, y: 720, z: 3.0, cut: true },
];

const Key: React.FC<{ size: number }> = ({ size }) => (
  <span
    style={{
      display: "inline-block", verticalAlign: "0.16em", marginLeft: size * 0.3, height: size * 0.8, padding: `0 ${size * 0.22}px`, minWidth: size * 1.2,
      borderRadius: size * 0.17, background: "#636366", color: "#fff", font: `600 ${size * 0.46}px/${size * 0.8}px ${SF}`, textAlign: "center",
    }}
  >
    tab
  </span>
);

// One line of copy, with an optional ghost part that turns to ink once `accepted`.
const Line: React.FC<{ ink: string; ghost?: string; accepted: boolean; size: number; color?: string; weight?: number }> = ({ ink, ghost, accepted, size, color = INK, weight = 500 }) => (
  <div style={{ fontFamily: NEWS, fontSize: size, fontWeight: weight, lineHeight: 1.12, color }}>
    {ink}
    {ghost ? <span style={{ color: accepted ? color : GHOST }}>{ghost}</span> : null}
    {ghost && !accepted ? <Key size={size} /> : null}
  </div>
);

const Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const c = capAt(frame);
  const acc = !!c && c.acc >= 0 && frame >= c.acc;
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <ScreenView vp={{ x: 0, y: 0, w: 1920, h: 760 }} cams={CAMS} />
      {c ? (
        <div style={{ position: "absolute", left: 96, top: 808, right: 96 }}>
          <Line ink={c.cap.title} ghost={c.cap.titleGhost} accepted={acc} size={66} />
          {c.cap.sub ? (
            <div style={{ marginTop: 14 }}>
              <Line ink={c.cap.subGhost ? "" : c.cap.sub} ghost={c.cap.subGhost ? c.cap.sub : undefined} accepted={acc} size={42} color={SUB} weight={400} />
            </div>
          ) : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

// Each "also" line is suggested in gray, then accepted.
const ACCEPT = [40, 130];
const Also: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: PAPER, justifyContent: "center", padding: "0 140px", gap: 46 }}>
      <Line ink="Same key, other chores:" accepted size={46} color={SUB} weight={400} />
      {ALSO.map((l, i) => (frame >= ACCEPT[i] - 34 ? <Line key={i} ink="" ghost={l} accepted={frame >= ACCEPT[i]} size={70} /> : null))}
    </AbsoluteFill>
  );
};
const AlsoSfx: React.FC = () => (
  <>
    {ACCEPT.map((f, i) => (
      <Sequence key={i} from={SCREEN_FRAMES + f} durationInFrames={30} layout="none">
        <Audio src={staticFile("sfx/key.wav")} volume={0.6} />
      </Sequence>
    ))}
  </>
);

const End: React.FC = () => (
  <AbsoluteFill style={{ background: PAPER, justifyContent: "center", padding: "0 140px" }}>
    <div style={{ fontFamily: NEWS, fontSize: 220, fontWeight: 500, color: INK, lineHeight: 1 }}>Tab</div>
    <div style={{ marginTop: 40 }}>
      <Line ink={SIGNOFF.line} accepted size={48} color={SUB} weight={400} />
      <Line ink={SIGNOFF.follow} accepted size={48} color={INK} weight={400} />
    </div>
  </AbsoluteFill>
);

export const DemoC: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: PAPER }}>
      <Sequence durationInFrames={SCREEN_FRAMES}>
        <Screen />
      </Sequence>
      <Sequence from={SCREEN_FRAMES} durationInFrames={Math.round(ALSO_S * FPS)}>
        <Also />
      </Sequence>
      <Sequence from={SCREEN_FRAMES + Math.round(ALSO_S * FPS)}>
        <End />
      </Sequence>
      <Audio src={staticFile("music-C.wav")} volume={(f) => 0.55 * Math.min(1, (TOTAL - f) / FPS)} />
      <KeySfx volume={0.6} />
      <AlsoSfx />
    </AbsoluteFill>
  );
};
