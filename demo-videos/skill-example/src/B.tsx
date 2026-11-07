import React from "react";
import { Audio } from "@remotion/media";
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";
import { ALSO, ALSO_S, CAPS, FPS, SCREEN_FRAMES, SIGNOFF, TOTAL, outFrame, type Cam, srcAt } from "./edit";
import { KeySfx, SF, capAt, pressFrames, useFonts } from "./common";
import { ScreenView } from "./Screen";

// Direction B, "captions are ghosts": the screen fills the frame and every caption is drawn as Tab's own ghost pill
// (design/ghost-spec.md: slate capsule, semibold head + regular tail after " · ", keycap at the right end), scaled up.
// The caption's keycap goes down when the real Tab key is pressed.
const SLATE = "#636366", DESK = "#3a3d46";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const CAMS: Cam[] = [
  { t: 0, x: 500, y: 600, z: 1.6 },
  { t: 5.8, x: 300, y: 700, z: 2.3 },
  { t: 7.75, x: 892, y: 500, z: 2.2 },
  { t: 10.3, x: 892, y: 520, z: 2.6 },
  { t: 13.76, x: 560, y: 540, z: 1.6 },
  { t: 15.56, x: 480, y: 780, z: 2.0 },
  { t: 17.45, x: 420, y: 260, z: 1.9 },
  { t: 20.05, x: 1060, y: 720, z: 2.4, cut: true },
];
// Where each caption sits: away from what the camera is pointing at.
const AT: ("top" | "bottom")[] = ["top", "top", "bottom", "bottom", "top", "top"];

function pressAmt(frame: number) {
  let d = 0;
  for (const p of pressFrames()) d = Math.max(d, interpolate(frame - p, [-2, 1, 9, 14], [0, 1, 1, 0], clamp));
  return d;
}

export const Pill: React.FC<{ head: string; tail?: string; size?: number; keycap?: boolean; press?: number; weight?: number }> = ({ head, tail, size = 56, keycap, press = 0, weight = 600 }) => {
  const h = size * 2;
  const kh = h - size * 0.42;
  return (
    <div
      style={{
        display: "inline-flex", alignItems: "center", height: h, borderRadius: h / 2, background: SLATE, color: "#fff",
        padding: `0 ${keycap ? size * 0.21 : size * 0.86}px 0 ${size * 0.86}px`, fontFamily: SF, fontSize: size, fontWeight: weight, whiteSpace: "nowrap",
        boxShadow: "0 4px 16px rgba(0,0,0,.22), inset 0 0 0 2px rgba(255,255,255,.22)",
      }}
    >
      <span>{head}</span>
      {tail ? <span style={{ fontWeight: 400, opacity: 0.82, marginLeft: size * 0.3 }}>· {tail.trim()}</span> : null}
      {keycap ? (
        <span
          style={{
            marginLeft: size * 0.57, height: kh, minWidth: kh * 1.5, padding: `0 ${size * 0.43}px`, borderRadius: size * 0.36,
            background: press > 0.5 ? "rgba(255,255,255,.42)" : "rgba(255,255,255,.24)", fontSize: size * 0.86, fontWeight: 600,
            lineHeight: `${kh}px`, textAlign: "center", transform: `translateY(${press * 5}px) scale(${1 - press * 0.06})`,
          }}
        >
          tab
        </span>
      ) : null}
    </div>
  );
};

const Screen: React.FC = () => {
  const frame = useCurrentFrame();
  // No caption while Calendar's quick-event popover is up (it sits where the caption would).
  const t = srcAt(frame).t;
  const c = t >= 17.5 && t < 20 ? null : capAt(frame);
  const idx = c ? capIndex(c.a) : -1;
  const at = idx >= 0 ? AT[idx] : "top";
  const k = c ? interpolate(frame - c.a, [0, 8], [0, 1], clamp) : 0;
  const press = c && c.cap.accept && frame >= c.acc - 3 && frame <= c.acc + 20 ? pressAmt(frame) : 0;
  return (
    <AbsoluteFill>
      <ScreenView vp={{ x: 0, y: 0, w: 1920, h: 1080 }} cams={CAMS} easeS={0.8} />
      {c ? (
        <div
          style={{
            position: "absolute", left: 72, ...(at === "top" ? { top: 64 } : { bottom: 64 }), display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 18,
            opacity: k, transform: `scale(${0.96 + 0.04 * k})`, transformOrigin: "left center",
          }}
        >
          <Pill head={c.cap.titleGhost ? c.cap.title.replace(/\.$/, "") : c.cap.title} tail={c.cap.titleGhost} size={64} keycap={!!c.cap.accept} press={press} />
          {c.cap.sub ? <Pill head={c.cap.sub} size={40} weight={400} /> : null}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

function capIndex(a: number) {
  return CAPS.findIndex((cp) => outFrame(cp.t) === a);
}

const Also: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: DESK, justifyContent: "center", paddingLeft: 120, gap: 40 }}>
      <div style={{ fontFamily: SF, fontSize: 48, fontWeight: 500, color: "#C7C7CC" }}>Same key, other chores:</div>
      {ALSO.map((l, i) => {
        const k = interpolate(frame - i * 72, [0, 8], [0, 1], clamp);
        return (
          <div key={i} style={{ opacity: k, transform: `scale(${0.96 + 0.04 * k})`, transformOrigin: "left center" }}>
            <Pill head={l} size={56} keycap />
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

const End: React.FC = () => {
  const frame = useCurrentFrame();
  const press = interpolate(frame, [30, 33, 41, 46], [0, 1, 1, 0], clamp);
  return (
    <AbsoluteFill style={{ background: DESK, justifyContent: "center", alignItems: "center", gap: 44 }}>
      <Pill head="Tab" tail="built at Paradigm Frontiers 2026" size={84} keycap press={press} />
      <div style={{ fontFamily: SF, fontSize: 44, fontWeight: 500, color: "#fff", textAlign: "center" }}>{SIGNOFF.follow}</div>
    </AbsoluteFill>
  );
};

export const DemoB: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: DESK }}>
      <Sequence durationInFrames={SCREEN_FRAMES}>
        <Screen />
      </Sequence>
      <Sequence from={SCREEN_FRAMES} durationInFrames={Math.round(ALSO_S * FPS)}>
        <Also />
      </Sequence>
      <Sequence from={SCREEN_FRAMES + Math.round(ALSO_S * FPS)}>
        <End />
      </Sequence>
      <Audio src={staticFile("music-B.wav")} volume={(f) => 0.45 * Math.min(1, (TOTAL - f) / FPS)} />
      <KeySfx volume={0.8} />
    </AbsoluteFill>
  );
};
