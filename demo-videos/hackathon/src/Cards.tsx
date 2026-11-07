import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { GhostLine, Pill } from "./Ghost";
import { C, FONT } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const Backdrop: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill style={{ background: `radial-gradient(120% 90% at 50% 40%, #161618 0%, ${C.bg} 60%)` }}>
    <AbsoluteFill style={{ opacity: 0.05, backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")" }} />
    {children}
  </AbsoluteFill>
);

// Chapter card: one GhostLine that gets accepted.
export const Card: React.FC<{ solid: string; ghost: string; kicker?: string }> = ({ solid, ghost, kicker }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const k = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", gap: 36 }}>
        {kicker ? (
          <div style={{ fontFamily: FONT, fontSize: 30, fontWeight: 500, color: C.dim, letterSpacing: 4, textTransform: "uppercase", opacity: k * interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp) }}>
            {kicker}
          </div>
        ) : null}
        <GhostLine solid={solid} ghost={ghost} ghostAt={Math.round(0.35 * fps)} pressAt={Math.round(0.95 * fps)} size={88} outAt={durationInFrames - 10} />
      </AbsoluteFill>
    </Backdrop>
  );
};

// Opening: the product explained by doing it.
export const Intro: React.FC<{ pace?: number }> = ({ pace = 1 }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const logoAt = Math.round(2.6 * pace * fps);
  const lineOut = interpolate(frame, [logoAt - 12, logoAt], [1, 0], clamp);
  const logo = spring({ frame: frame - logoAt, fps, config: { damping: 14, mass: 0.6 } });
  const press = interpolate(frame, [logoAt + 34, logoAt + 38, logoAt + 44], [0, 1, 0], clamp);
  const tag = spring({ frame: frame - logoAt - 22, fps, config: { damping: 200 } });
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: lineOut, filter: `blur(${(1 - lineOut) * 14}px)` }}>
        <GhostLine solid="Autocomplete" ghost=" for your whole Mac." ghostAt={Math.round(0.55 * pace * fps)} pressAt={Math.round(1.55 * pace * fps)} size={92} />
      </AbsoluteFill>
      {frame >= logoAt - 2 ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 40 }}>
          <div style={{ scale: `${0.6 + 0.4 * logo}`, opacity: Math.min(1, logo * 1.5) }}>
            <Pill size={220} pressed={press} />
          </div>
          <div style={{ fontFamily: FONT, fontSize: 40, fontWeight: 500, color: C.dim, opacity: tag, translate: `0 ${(1 - tag) * 20}px` }}>
            It sees your next step. <span style={{ color: C.ink }}>Tab</span> takes it.
          </div>
        </AbsoluteFill>
      ) : null}
    </Backdrop>
  );
};

// Closing list for the single-demo cut: other things Tab does, one line each.
export const UseCases: React.FC<{ items: { title: string; sub: string }[] }> = ({ items }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();
  const out = interpolate(frame, [durationInFrames - 10, durationInFrames], [1, 0], clamp);
  const head = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 16 });
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: out }}>
        <div style={{ fontFamily: FONT, width: 1180 }}>
          <div style={{ fontSize: 30, fontWeight: 500, color: C.dim, letterSpacing: 4, textTransform: "uppercase", opacity: head, marginBottom: 40 }}>Also works for</div>
          {items.map((it, i) => {
            const p = spring({ frame: frame - Math.round((0.35 + i * 0.45) * fps), fps, config: { damping: 200 }, durationInFrames: 18 });
            return (
              <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 28, padding: "22px 0", borderTop: "1px solid rgba(255,255,255,.1)", opacity: p, translate: `${(1 - p) * 40}px 0` }}>
                <div style={{ width: 12, height: 12, borderRadius: 6, background: C.red, flex: "none", translate: "0 -10px" }} />
                <div style={{ fontSize: 60, fontWeight: 700, color: C.ink, letterSpacing: -1.2 }}>{it.title}</div>
                <div style={{ fontSize: 36, fontWeight: 500, color: C.dim }}>{it.sub}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    </Backdrop>
  );
};
