import React from "react";
import { Audio } from "@remotion/media";
import { Sequence, continueRender, delayRender, staticFile } from "remotion";
import { EDIT1, type Cap, type Edit } from "./edit";

// Fonts from public/fonts, loaded once before the first frame renders.
const faces: [string, string, string][] = [
  ["Cabinet Grotesk", "fonts/cabinet-500.woff2", "500"],
  ["Cabinet Grotesk", "fonts/cabinet-800.woff2", "800"],
  ["Newsreader", "fonts/newsreader.woff2", "300 700"],
];
let loaded = false;
export function useFonts() {
  if (loaded || typeof document === "undefined") return;
  loaded = true;
  const h = delayRender("fonts");
  Promise.all(faces.map(([f, u, w]) => new FontFace(f, `url(${staticFile(u)})`, { weight: w }).load().then((ff) => document.fonts.add(ff)))).then(() => continueRender(h));
}

export const SF = `-apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif`;

// Caption on screen at this output frame, with its frame range and the frame its ghost part is accepted.
export function capAt(frame: number, ed: Edit = EDIT1): { cap: Cap; a: number; b: number; acc: number } | null {
  for (const cap of ed.caps) {
    const a = ed.outFrame(cap.t), b0 = ed.outFrame(cap.until), b = b0 < 0 ? ed.frames : b0;
    if (frame >= a && frame < b) return { cap, a, b, acc: cap.accept ? ed.outFrame(cap.accept) : -1 };
  }
  return null;
}
export const pressFrames = (ed: Edit = EDIT1) => ed.presses.map((p) => ed.outFrame(p.t));

// The real key's click on each Tab press.
export const KeySfx: React.FC<{ volume?: number; frames?: number[] }> = ({ volume = 0.6, frames = pressFrames() }) => (
  <>
    {frames.map((f, i) => (
      <Sequence key={i} from={f} durationInFrames={30} layout="none">
        <Audio src={staticFile("sfx/key.wav")} volume={volume} />
      </Sequence>
    ))}
  </>
);
