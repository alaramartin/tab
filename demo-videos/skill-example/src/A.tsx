import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { FPS, SIGNOFF } from "./edit";
import { ALSO2, ALSO_ACCEPT_S, ALSO_GHOST_S, ALSO_S2, CAMS_A2, EDIT_A2, INTRO_ACCEPT_S, INTRO_S, TOTAL_A2 } from "./editA2";
import { KeySfx, capAt, pressFrames, useFonts } from "./common";
import { ScreenView } from "./Screen";

// tab-poster (v3). Direction A, "Hall 9 poster": the box office's ultramarine, black and yellow, Cabinet Grotesk set big
// straight onto the blue, smooth camera moves (from B), and a yellow keycap that stamps (stepped, 12 fps) on every Tab press.
// Text Tab would write appears first as a ghost suggestion with a keycap, and is accepted with a press (the product's own move).
const BLUE = "#1423b8", YELLOW = "#f7dd47", INK = "#06071c", MUTED = "#b4bcf0", GHOST = "rgba(255,255,255,.38)";
const CAB = `"Cabinet Grotesk", "Helvetica Neue", Arial, sans-serif`;
const sec = (s: number) => Math.round(s * FPS);

// Stepped press: 12 fps (every 5th frame at 60), down for two steps, then back up.
function stamp(frame: number, presses: number[]) {
  let d = 0;
  for (const p of presses) {
    const step = Math.floor((frame - p) / 5);
    if (step >= 0 && step < 3) d = Math.max(d, [1, 1, 0.4][step]);
  }
  return d;
}

const Keycap: React.FC<{ press: number; size?: number }> = ({ press, size = 190 }) => (
  <div
    style={{
      width: size, height: size, borderRadius: size * 0.19, background: YELLOW, color: INK,
      font: `800 ${size * 0.48}px/${size}px ${CAB}`, textAlign: "center", letterSpacing: "-0.02em",
      transform: `translateY(${press * 12}px) rotate(-3deg)`, boxShadow: `0 ${12 * (1 - press)}px 0 #b9a21f`,
    }}
  >
    tab
  </div>
);
const CornerKey: React.FC<{ press: number }> = ({ press }) => (
  <div style={{ position: "absolute", left: 80, top: 80 }}>
    <Keycap press={press} />
  </div>
);

// Text Tab suggests: ghost white with a small keycap, then solid white once accepted.
const Suggested: React.FC<{ text: string; accepted: boolean; size: number; lead?: string }> = ({ text, accepted, size, lead }) => (
  <div style={{ fontFamily: CAB, fontWeight: 800, fontSize: size, lineHeight: 1.0, letterSpacing: "-0.02em", color: "#fff" }}>
    {lead}
    <span style={{ color: accepted ? "#fff" : GHOST }}>{text}</span>
    {accepted || !text ? null : (
      <span
        style={{
          display: "inline-block", verticalAlign: "0.12em", marginLeft: size * 0.25, height: size * 0.62, lineHeight: `${size * 0.62}px`, padding: `0 ${size * 0.16}px`,
          borderRadius: size * 0.13, background: YELLOW, color: INK, fontSize: size * 0.34, letterSpacing: 0,
        }}
      >
        tab
      </span>
    )}
  </div>
);

const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const acc = sec(INTRO_ACCEPT_S);
  return (
    <AbsoluteFill style={{ background: BLUE }}>
      <CornerKey press={stamp(frame, [acc])} />
      <div style={{ position: "absolute", left: 80, top: 470, width: 1760 }}>
        <Suggested lead="Autocomplete " text={frame < 21 ? "" : "for your whole Mac."} accepted={frame >= acc} size={104} />
      </div>
    </AbsoluteFill>
  );
};

const Screen: React.FC = () => {
  const frame = useCurrentFrame();
  const c = capAt(frame, EDIT_A2);
  return (
    <AbsoluteFill style={{ background: BLUE }}>
      <ScreenView vp={{ x: 760, y: 0, w: 1160, h: 1080 }} cams={CAMS_A2} edge={BLUE} ed={EDIT_A2} easeS={0.8} />
      <CornerKey press={stamp(frame, pressFrames(EDIT_A2))} />
      {c ? (
        <div style={{ position: "absolute", left: 80, top: 370, width: 640, color: "#fff", fontFamily: CAB }}>
          <div style={{ fontWeight: 800, fontSize: 80, lineHeight: 0.98, letterSpacing: "-0.02em" }}>{c.cap.title}</div>
          {c.cap.sub && frame - c.a >= 6 ? <div style={{ fontWeight: 500, fontSize: 42, lineHeight: 1.15, color: MUTED, marginTop: 30 }}>{c.cap.sub}</div> : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Also: React.FC = () => {
  const frame = useCurrentFrame();
  const acc = ALSO_ACCEPT_S.map(sec);
  return (
    <AbsoluteFill style={{ background: BLUE }}>
      <CornerKey press={stamp(frame, acc)} />
      <div style={{ position: "absolute", left: 80, top: 400, width: 1680 }}>
        <div style={{ fontFamily: CAB, fontWeight: 500, fontSize: 46, color: MUTED, marginBottom: 34 }}>{ALSO2.head}</div>
        {ALSO2.items.map((l, i) =>
          frame >= sec(ALSO_GHOST_S[i]) ? (
            <div key={i} style={{ marginBottom: 44 }}>
              <Suggested text={l} accepted={frame >= acc[i]} size={70} />
            </div>
          ) : null,
        )}
      </div>
    </AbsoluteFill>
  );
};

const End: React.FC = () => (
  <AbsoluteFill style={{ background: BLUE, fontFamily: CAB, color: "#fff" }}>
    <div style={{ position: "absolute", right: 0, top: 0, width: 760, height: 1080, background: YELLOW, overflow: "hidden" }}>
      <Img src={staticFile("img/owl-etching.jpg")} style={{ width: 760, height: 1080, objectFit: "cover", mixBlendMode: "multiply" }} />
    </div>
    <div style={{ position: "absolute", left: 80, top: 250, fontWeight: 800, fontSize: 300, lineHeight: 0.8, letterSpacing: "-0.04em" }}>Tab</div>
    <div style={{ position: "absolute", left: 86, top: 600, width: 1000 }}>
      <div style={{ fontWeight: 800, fontSize: 60, lineHeight: 1.05, letterSpacing: "-0.01em" }}>{SIGNOFF.line}</div>
      <div style={{ fontWeight: 500, fontSize: 38, color: MUTED, marginTop: 22 }}>{SIGNOFF.follow}</div>
    </div>
  </AbsoluteFill>
);

const fIntro = sec(INTRO_S), fAlso = fIntro + EDIT_A2.frames, fEnd = fAlso + sec(ALSO_S2);

export const DemoA: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: BLUE }}>
      <Sequence durationInFrames={fIntro}>
        <Intro />
        <KeySfx volume={0.5} frames={[sec(INTRO_ACCEPT_S)]} />
      </Sequence>
      <Sequence from={fIntro} durationInFrames={EDIT_A2.frames}>
        <Screen />
        <KeySfx volume={0.5} frames={pressFrames(EDIT_A2)} />
      </Sequence>
      <Sequence from={fAlso} durationInFrames={sec(ALSO_S2)}>
        <Also />
        <KeySfx volume={0.5} frames={ALSO_ACCEPT_S.map(sec)} />
      </Sequence>
      <Sequence from={fEnd}>
        <End />
      </Sequence>
      <Audio src={staticFile("music-solo.wav")} volume={(f) => 0.42 * Math.min(1, (TOTAL_A2 - f) / FPS)} />
    </AbsoluteFill>
  );
};
