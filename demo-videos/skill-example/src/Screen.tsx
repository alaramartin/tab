import React from "react";
import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { EDIT1, FPS, SH, SRC, SW, stillPath, type Cam, type Edit } from "./edit";

const ease = Easing.bezier(0.65, 0, 0.25, 1);

// Camera at source time t. A key with `cut` is a hard cut (no easing into it); otherwise ease, zoom in log space.
function camAt(cams: Cam[], t: number, dur = 0.7): Cam {
  let cur = cams[0];
  for (let i = 1; i < cams.length; i++) {
    const b = cams[i];
    if (t < b.t) break;
    if (b.cut) cur = b;
    else {
      const p = ease(Math.min(1, (t - b.t) / (b.dur ?? dur)));
      const z = Math.exp(Math.log(cur.z) + (Math.log(b.z) - Math.log(cur.z)) * p);
      cur = { t, x: cur.x + (b.x - cur.x) * p, y: cur.y + (b.y - cur.y) * p, z };
    }
  }
  return cur;
}

// Keep the camera inside [lo, hi]; if the view is bigger than that span, center on it.
const fit = (c: number, half: number, lo: number, hi: number) => (hi - lo <= 2 * half ? (lo + hi) / 2 : Math.min(Math.max(c, lo + half), hi - half));

export type Viewport = { x: number; y: number; w: number; h: number };

// The recorded screen inside `vp` (output pixels), framed by the camera. Outside the screen (or the edit's clip) shows `edge`.
export const ScreenView: React.FC<{ vp: Viewport; cams: Cam[]; edge?: string; easeS?: number; ed?: Edit }> = ({ vp, cams, edge = "#3a3d46", easeS, ed = EDIT1 }) => {
  const frame = useCurrentFrame();
  const { t } = ed.srcAt(frame);
  const cam = camAt(cams, t, easeS);
  const clip = ed.clip?.(t) ?? { x: 0, y: 0, w: SW, h: SH };
  const s = Math.max((vp.h / SH) * cam.z, vp.w / SW);
  const cx = fit(cam.x, vp.w / s / 2, clip.x, clip.x + clip.w);
  const cy = fit(cam.y, vp.h / s / 2, clip.y, clip.y + clip.h);
  const tx = vp.w / 2 - cx * s;
  const ty = vp.h / 2 - cy * s;
  return (
    <div style={{ position: "absolute", left: vp.x, top: vp.y, width: vp.w, height: vp.h, overflow: "hidden", background: edge }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: SW, height: SH, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${s})` }}>
        <div style={{ position: "absolute", left: clip.x, top: clip.y, width: clip.w, height: clip.h, overflow: "hidden" }}>
          <div style={{ position: "absolute", left: -clip.x, top: -clip.y, width: SW, height: SH }}>
            {ed.segments().map((sg, i) => (
              <Sequence key={i} from={sg.f0} durationInFrames={sg.n} premountFor={FPS}>
                {sg.hold ? (
                  <Img src={staticFile(stillPath(sg.from))} style={{ width: SW, height: SH, position: "absolute", left: 0, top: 0 }} />
                ) : (
                  <Video src={staticFile(SRC)} trimBefore={Math.round(sg.from * FPS)} playbackRate={sg.rate ?? 1} muted style={{ width: SW, height: SH, position: "absolute", left: 0, top: 0 }} />
                )}
              </Sequence>
            ))}
            {ed.blurs.map((b, i) => (
              <div key={i} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, borderRadius: 14, backdropFilter: "blur(6px)", background: "rgba(142,142,147,.9)" }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export const Fill: React.FC<{ bg: string; children?: React.ReactNode }> = ({ bg, children }) => <AbsoluteFill style={{ background: bg }}>{children}</AbsoluteFill>;
