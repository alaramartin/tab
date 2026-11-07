import React from "react";
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// The red suggestion pill with its `tab` keycap, as the shell draws it, scaled up for the film.
export const Pill: React.FC<{ label?: string; size?: number; pressed?: number; color?: string; keyLabel?: string }> = ({
  label,
  size = 40,
  pressed = 0,
  color = C.red,
  keyLabel = "tab",
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.35,
      background: color,
      borderRadius: size,
      padding: label ? `${size * 0.16}px ${size * 0.18}px ${size * 0.16}px ${size * 0.5}px` : size * 0.16,
      color: "white",
      fontFamily: FONT,
      fontWeight: 600,
      fontSize: size * 0.62,
      lineHeight: 1,
      boxShadow: `0 ${size * 0.15}px ${size * 0.6}px rgba(255,59,48,${0.35 * (1 - pressed)}), 0 0 0 ${size * 0.04}px rgba(255,255,255,.18) inset`,
      whiteSpace: "nowrap",
    }}
  >
    {label}
    <Keycap size={size} pressed={pressed} label={keyLabel} />
  </span>
);

export const Keycap: React.FC<{ size?: number; pressed?: number; label?: string; dark?: boolean }> = ({ size = 40, pressed = 0, label = "tab", dark }) => (
  <span
    style={{
      display: "inline-block",
      background: dark ? "#2C2C2E" : "rgba(255,255,255,.22)",
      borderRadius: size * 0.2,
      padding: `${size * 0.1}px ${size * 0.24}px`,
      fontSize: size * 0.48,
      fontWeight: 600,
      color: "white",
      fontFamily: FONT,
      boxShadow: `0 ${size * 0.06 * (1 - pressed)}px 0 rgba(0,0,0,.28)`,
      translate: `0 ${size * 0.05 * pressed}px`,
      lineHeight: 1.15,
    }}
  >
    {label}
  </span>
);

// A line of type that behaves like Tab: solid text, gray ghost text + pill, then the press accepts it.
export const GhostLine: React.FC<{
  solid: string;
  ghost: string;
  ghostAt: number; // frame the ghost appears
  pressAt: number; // frame Tab is pressed
  size?: number;
  outAt?: number;
}> = ({ solid, ghost, ghostAt, pressAt, size = 96, outAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const words = solid.split(" ");
  const ghostIn = spring({ frame: frame - ghostAt, fps, config: { damping: 200 }, durationInFrames: 14 });
  const press = interpolate(frame, [pressAt, pressAt + 4, pressAt + 9], [0, 1, 0], clamp);
  const sweep = interpolate(frame, [pressAt + 3, pressAt + 3 + 0.35 * fps], [0, 1], { ...clamp, easing: Easing.bezier(0.2, 0, 0, 1) });
  const pillGone = interpolate(frame, [pressAt + 4, pressAt + 12], [1, 0], clamp);
  const out = outAt === undefined ? 1 : interpolate(frame, [outAt, outAt + 10], [1, 0], clamp);
  const chars = [...ghost];
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 600,
        letterSpacing: -size * 0.03,
        color: C.ink,
        lineHeight: 1.1,
        textAlign: "center",
        opacity: out,
        filter: `blur(${(1 - out) * 12}px)`,
        whiteSpace: "nowrap",
      }}
    >
      {words.map((w, i) => {
        const p = spring({ frame: frame - i * 4, fps, config: { damping: 200 }, durationInFrames: 18 });
        return (
          <span key={i} style={{ display: "inline-block", opacity: p, translate: `0 ${(1 - p) * size * 0.25}px`, filter: `blur(${(1 - p) * 8}px)`, whiteSpace: "pre" }}>
            {w + (i < words.length - 1 ? " " : "")}
          </span>
        );
      })}
      <span style={{ opacity: ghostIn }}>
        {chars.map((ch, i) => {
          const lit = interpolate(sweep * (chars.length + 6) - i, [0, 6], [0, 1], clamp);
          return (
            <span key={i} style={{ color: lit > 0 ? mix(C.ghost, C.ink, lit) : C.ghost, whiteSpace: "pre" }}>
              {ch}
            </span>
          );
        })}
      </span>
      <span
        style={{
          display: "inline-block",
          marginLeft: size * 0.25,
          verticalAlign: "middle",
          translate: `0 ${-size * 0.08}px`,
          opacity: ghostIn * pillGone,
          scale: `${(0.85 + 0.15 * ghostIn) * (1 - 0.08 * press) * (0.6 + 0.4 * pillGone)}`,
          width: pillGone < 0.02 ? 0 : undefined,
        }}
      >
        <Pill size={size * 0.78} pressed={press} />
      </span>
    </div>
  );
};

export function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(",")})`;
}
