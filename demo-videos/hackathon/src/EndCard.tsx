import React from "react";
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { Backdrop } from "./Cards";
import { Pill } from "./Ghost";
import { C, FONT } from "./theme";

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

// The HUD's reveal (real numbers from the release take), then the sign-off.
export const EndCard: React.FC<{ tabDid: number; youDid: number }> = ({ tabDid, youDid }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const count = interpolate(frame, [8, 8 + 1.1 * fps], [0, 1], { ...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1) });
  const share = tabDid / (tabDid + youDid);
  const panel = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 18 });
  const swap = Math.round(2.3 * fps);
  const panelOut = interpolate(frame, [swap, swap + 12], [1, 0], clamp);
  const logo = spring({ frame: frame - swap - 6, fps, config: { damping: 14, mass: 0.6 } });
  const press = interpolate(frame, [swap + 30, swap + 34, swap + 40], [0, 1, 0], clamp);
  const line = spring({ frame: frame - swap - 20, fps, config: { damping: 200 } });
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], clamp);
  return (
    <Backdrop>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: panel * panelOut, scale: `${0.94 + 0.06 * panel}`, filter: `blur(${(1 - panelOut) * 10}px)` }}>
        <div style={{ width: 900, background: C.panel, borderRadius: 40, padding: "44px 56px", fontFamily: FONT, color: C.ink, boxShadow: "0 40px 120px rgba(0,0,0,.6), inset 0 0 0 2px rgba(255,255,255,.08)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 34, color: C.dim, fontWeight: 500 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ background: C.hudBlue, color: "white", borderRadius: 10, padding: "2px 14px", fontWeight: 600 }}>tab</span> did
            </span>
            <span>You did</span>
          </div>
          <div style={{ fontSize: 24, color: C.dim, marginTop: 4 }}>clicks + keystrokes in this video</div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 150, fontWeight: 600, letterSpacing: -4, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
            <span>{Math.round(tabDid * count)}</span>
            <span>{Math.round(youDid * count)}</span>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <div style={{ height: 16, borderRadius: 8, background: C.hudBlue, width: `${share * count * 100}%`, minWidth: 16 }} />
            <div style={{ height: 16, borderRadius: 8, background: "rgba(255,255,255,.85)", flex: 1 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, marginTop: 18, fontWeight: 600 }}>
            <span style={{ color: "#409CFF" }}>{Math.round(share * 100 * count)}% by Tab</span>
            <span style={{ color: C.dim }}>{Math.round((1 - share) * 100 * count)}% by you</span>
          </div>
        </div>
      </AbsoluteFill>
      {frame >= swap ? (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 44, opacity: out }}>
          <div style={{ scale: `${0.6 + 0.4 * logo}`, opacity: Math.min(1, logo * 1.5) }}>
            <Pill size={200} pressed={press} />
          </div>
          <div style={{ fontFamily: FONT, fontSize: 56, fontWeight: 600, color: C.ink, letterSpacing: -1.5, opacity: line, translate: `0 ${(1 - line) * 20}px` }}>
            Your Mac, one keystroke ahead.
          </div>
          <div style={{ fontFamily: FONT, fontSize: 28, fontWeight: 500, color: C.dim, opacity: line }}>
            Built at Paradigm Frontiers 2026 · github.com/alaramartin/paradigmhacks
          </div>
        </AbsoluteFill>
      ) : null}
    </Backdrop>
  );
};
