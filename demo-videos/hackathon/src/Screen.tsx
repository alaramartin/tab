import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "./Cards";
import { Keycap } from "./Ghost";
import { C, FONT } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// Screen is 1440×900 points (recorded at 2880×1800).
export const SW = 1440;
export const SH = 900;

// A piece of the source recording, played at `rate` (2 = twice as fast).
// A freeze-frame is { from: t, to: t, hold: seconds } (shown from a still extracted by rec/stills.mjs).
export type Seg = { from: number; to: number; rate?: number; hold?: number };
export type Blur = { from: number; to: number; x: number; y: number; w: number; h: number };
const segLen = (s: Seg, fps: number) => Math.round((s.hold ?? (s.to - s.from) / (s.rate ?? 1)) * fps);
export const stillPath = (src: string, t: number) => src.replace(/\.mp4$/, `-still-${t.toFixed(2)}.jpg`);
// Camera key in SOURCE seconds: center (points) + zoom (1 = whole screen fits the frame height with a margin).
export type Cam = { t: number; x: number; y: number; z: number };
export type Cap = { t: number; until: number; text: string; sub?: string; tone?: "red" | "blue" | "green"; at?: "top" | "bottom" };

export function segFrames(segs: Seg[], fps: number) {
  return segs.reduce((n, s) => n + segLen(s, fps), 0);
}

// Output frame → source seconds.
function srcTime(segs: Seg[], frame: number, fps: number) {
  let f0 = 0;
  for (const s of segs) {
    const n = segLen(s, fps);
    if (frame < f0 + n) return s.hold ? s.from : s.from + ((frame - f0) / fps) * (s.rate ?? 1);
    f0 += n;
  }
  const last = segs[segs.length - 1];
  return last.to;
}
// Source seconds → output frame (first match), for overlays timed by log events.
export function outFrame(segs: Seg[], t: number, fps: number) {
  let f0 = 0;
  for (const s of segs) {
    const n = segLen(s, fps);
    if (!s.hold && t >= s.from && t <= s.to) return f0 + Math.round(((t - s.from) / (s.rate ?? 1)) * fps);
    f0 += n;
  }
  return -1;
}

const ease = Easing.bezier(0.65, 0, 0.25, 1);
function camAt(cams: Cam[], t: number): Cam {
  if (t <= cams[0].t) return cams[0];
  for (let i = 0; i < cams.length - 1; i++) {
    const a = cams[i], b = cams[i + 1];
    if (t <= b.t) {
      const p = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      // Interpolate zoom in log space so in/out moves feel even.
      const z = Math.exp(Math.log(a.z) + (Math.log(b.z) - Math.log(a.z)) * p);
      return { t, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, z };
    }
  }
  return cams[cams.length - 1];
}

export const ScreenScene: React.FC<{
  src: string;
  segs: Seg[];
  cams: Cam[];
  keys?: { t: number; label?: string }[]; // Tab presses (source seconds)
  caps?: Cap[];
  speedBadges?: boolean;
  blurs?: Blur[];
}> = ({ src, segs, cams, keys = [], caps = [], speedBadges = true, blurs = [] }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const t = srcTime(segs, frame, fps);
  const cam = camAt(cams, t);
  // At z=1 the screen is 88% of frame height; the camera scales around (cam.x, cam.y).
  const base = (height * 0.88) / SH;
  const s = base * cam.z;
  const fx = Math.max(cam.z, 1); // keep the frame filled once zoomed in
  void fx;
  const tx = width / 2 - cam.x * s;
  const ty = height / 2 - cam.y * s;
  const radius = 18 / Math.max(1, cam.z * 0.6);
  // Scene in/out.
  const inP = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const outP = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);
  let f0 = 0;
  const curSeg = segs.find((sg) => {
    const n = segLen(sg, fps);
    const hit = frame >= f0 && frame < f0 + n;
    if (!hit) f0 += n;
    return hit;
  });
  return (
    <Backdrop>
      <AbsoluteFill style={{ opacity: inP * outP }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: SW,
            height: SH,
            transformOrigin: "0 0",
            transform: `translate(${tx}px, ${ty}px) scale(${s})`,
            borderRadius: radius,
            overflow: "hidden",
            boxShadow: "0 40px 120px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08)",
          }}
        >
          {(() => {
            let at = 0;
            return segs.map((sg, i) => {
              const n = segLen(sg, fps);
              const from = at;
              at += n;
              return (
                <Sequence key={i} from={from} durationInFrames={n} premountFor={fps} layout="none">
                  {sg.hold ? <Img src={staticFile(stillPath(src, sg.from))} style={{ width: SW, height: SH, position: "absolute", left: 0, top: 0 }} /> : <Video src={staticFile(src)} trimBefore={Math.round(sg.from * fps)} playbackRate={sg.rate ?? 1} muted style={{ width: SW, height: SH, position: "absolute", left: 0, top: 0 }} />}
                </Sequence>
              );
            });
          })()}
          {blurs.filter((b) => t >= b.from && t <= b.to).map((b, i) => (
            <div key={`b${i}`} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, backdropFilter: "blur(9px)", background: "rgba(240,240,242,.35)", borderRadius: 8 }} />
          ))}
        </div>
        {speedBadges && curSeg && !curSeg.hold && (curSeg.rate ?? 1) > 1.3 ? <SpeedBadge rate={curSeg.rate!} /> : null}
        {keys.map((k, i) => {
          const f = outFrame(segs, k.t, fps);
          return f < 0 ? null : (
            <Sequence key={i} from={f - 4} durationInFrames={Math.round(0.9 * fps)} layout="none">
              <KeyCast label={k.label} />
            </Sequence>
          );
        })}
        {caps.map((c, i) => {
          const a = outFrame(segs, c.t, fps);
          const b = outFrame(segs, c.until, fps);
          return a < 0 ? null : (
            <Sequence key={i} from={a} durationInFrames={Math.max(1, (b < 0 ? durationInFrames : b) - a)} layout="none">
              <Caption {...c} />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    </Backdrop>
  );
};

// The key-cast: a big `tab` keycap that pops in and presses, bottom center.
export const KeyCast: React.FC<{ label?: string }> = ({ label = "tab" }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const inP = spring({ frame, fps, config: { damping: 15, mass: 0.5 } });
  const press = interpolate(frame, [4, 7, 13], [0, 1, 0], clamp);
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);
  const isEsc = label === "esc";
  return (
    <AbsoluteFill style={{ alignItems: "flex-end", justifyContent: "flex-end", padding: "0 72px 64px 0" }}>
      <div style={{ opacity: Math.min(1, inP) * out, scale: `${0.7 + 0.3 * inP}`, translate: `0 ${(1 - inP) * 30}px` }}>
        <div
          style={{
            background: isEsc ? "#3A3A3C" : C.red,
            borderRadius: 26,
            padding: "14px 34px",
            fontFamily: FONT,
            fontSize: 52,
            fontWeight: 600,
            color: "white",
            boxShadow: `0 ${10 * (1 - press)}px 0 ${isEsc ? "#1C1C1E" : C.redDeep}, 0 24px 60px rgba(0,0,0,.5)`,
            translate: `0 ${10 * press}px`,
            letterSpacing: 0.5,
          }}
        >
          {label}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const SpeedBadge: React.FC<{ rate: number }> = ({ rate }) => (
  <div style={{ position: "absolute", top: 40, right: 48, fontFamily: FONT, fontSize: 26, fontWeight: 600, color: C.ink, background: "rgba(28,28,30,.85)", borderRadius: 999, padding: "8px 18px", border: "1px solid rgba(255,255,255,.12)" }}>
    {Math.round(rate)}× ▸▸
  </div>
);

export const Caption: React.FC<Cap> = ({ text, sub, tone, at = "bottom" }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const p = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const subP = spring({ frame: frame - 8, fps, config: { damping: 200 }, durationInFrames: 18 });
  const out = interpolate(frame, [durationInFrames - 8, durationInFrames], [1, 0], clamp);
  const accent = tone === "red" ? C.red : tone === "blue" ? C.pay : tone === "green" ? C.green : C.red;
  return (
    <div
      style={{
        position: "absolute",
        left: 64,
        ...(at === "top" ? { top: 56 } : { bottom: 60 }),
        opacity: p * out,
        translate: `0 ${(1 - p) * (at === "top" ? -30 : 30)}px`,
        fontFamily: FONT,
        background: "rgba(12,12,14,.92)",
        border: "1px solid rgba(255,255,255,.12)",
        borderRadius: 28,
        padding: "26px 40px 28px 34px",
        maxWidth: 1360,
        display: "flex",
        gap: 26,
        boxShadow: "0 30px 80px rgba(0,0,0,.55)",
      }}
    >
      <div style={{ width: 8, borderRadius: 4, background: accent, flex: "none", scale: `1 ${p}`, transformOrigin: "top" }} />
      <div>
        <div style={{ fontSize: 66, fontWeight: 700, color: "#fff", letterSpacing: -1.4, lineHeight: 1.08 }}>{text}</div>
        {sub ? <div style={{ fontSize: 38, color: "#C7C7CC", marginTop: 10, fontWeight: 500, lineHeight: 1.2, opacity: subP }}>{sub}</div> : null}
      </div>
    </div>
  );
};

export { Keycap };
