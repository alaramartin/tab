// Synthesizes each direction's music to the edit, so hits land on the real Tab presses.
//   npx tsx rec/music.mts   → public/music-A.wav, music-B.wav, music-C.wav
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ALSO_S, CAPS, FPS, PRESSES, SCREEN_FRAMES, TOTAL, outFrame } from "../src/edit.ts";
import { ALSO_ACCEPT_S, ALSO_S2, EDIT_A2, INTRO_ACCEPT_S, INTRO_S, TOTAL_A2 } from "../src/editA2.ts";

const SR = 48000;
const dur = TOTAL / FPS + 0.5;
const N = Math.ceil(dur * SR);
const pub = fileURLToPath(new URL("../public/", import.meta.url));
const presses = PRESSES.map((p) => outFrame(p.t) / FPS);
const capStarts = CAPS.map((c) => outFrame(c.t) / FPS);
const alsoAt = SCREEN_FRAMES / FPS, endAt = alsoAt + ALSO_S;

let rnd = 7;
const noise = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function wav(name: string, buf: Float32Array) {
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.89 / peak : 1;
  const b = Buffer.alloc(44 + buf.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + buf.length * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(buf.length * 2, 40);
  buf.forEach((v, i) => b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v * g)) * 32767), 44 + i * 2));
  writeFileSync(pub + name, b);
  console.log(name, dur.toFixed(1) + "s");
}
function add(buf: Float32Array, at: number, len: number, f: (t: number) => number) {
  const i0 = Math.round(at * SR);
  for (let i = 0; i < len * SR && i0 + i < buf.length; i++) if (i0 + i >= 0) buf[i0 + i] += f(i / SR);
}
const kick = (b: Float32Array, at: number, amp = 1) => add(b, at, 0.35, (t) => amp * Math.sin(2 * Math.PI * (50 * t + 90 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 9));
const clap = (b: Float32Array, at: number, amp = 1) => add(b, at, 0.25, (t) => amp * noise() * (Math.exp(-t * 25) + 0.6 * Math.exp(-Math.abs(t - 0.012) * 300)));
const hat = (b: Float32Array, at: number, amp = 0.25) => add(b, at, 0.05, (t) => amp * noise() * Math.exp(-t * 90));
const bass = (b: Float32Array, at: number, len: number, f: number, amp = 0.5) =>
  add(b, at, len, (t) => amp * Math.tanh(2.2 * Math.sin(2 * Math.PI * f * t)) * Math.min(1, t * 200) * Math.exp(-t * 1.6));
function pluck(b: Float32Array, at: number, f: number, amp = 0.5, len = 1.6) {
  const p = Math.round(SR / f), ring = Float32Array.from({ length: p }, noise);
  let k = 0;
  add(b, at, len, (t) => {
    const v = ring[k % p];
    ring[k % p] = 0.5 * (v + ring[(k + 1) % p]) * 0.996;
    k++;
    return amp * v * Math.min(1, (len - t) * 4);
  });
}

// A, v2 (tab-poster-v2): same groove, its beat on the intro's accept; a clap + kick on every press and accept.
function grooveA(len: number, hits: number[], sections: number[]) {
  const b = new Float32Array(Math.ceil((len + 0.5) * SR));
  const P = 60 / 116;
  const off = hits[0] % P;
  const roots = [45, 41, 48, 43];
  for (let i = 0; off + i * P < len - 0.6; i++) {
    const t = off + i * P;
    if (i % 2 === 0) kick(b, t, 0.9);
    else clap(b, t, 0.28);
    hat(b, t + P / 2, 0.18);
    hat(b, t, 0.1);
    if (i % 2 === 0) bass(b, t, P * 1.9, hz(roots[Math.floor(i / 4) % 4]), 0.32);
  }
  for (const t of hits) (clap(b, t, 0.7), kick(b, t, 0.8));
  for (const t of sections) (kick(b, t, 1), add(b, t, 1.4, (x) => 0.35 * noise() * Math.exp(-x * 3)));
  return b;
}
{
  const screen0 = INTRO_S, also0 = screen0 + EDIT_A2.frames / FPS, end0 = also0 + ALSO_S2;
  const hits = [INTRO_ACCEPT_S, ...EDIT_A2.presses.map((p) => screen0 + EDIT_A2.outFrame(p.t) / FPS), ...ALSO_ACCEPT_S.map((t) => also0 + t)];
  wav("music-A2.wav", grooveA(TOTAL_A2 / FPS, hits, [screen0, also0, end0]));
}

// A: dry drums + saturated bass on a grid whose beat falls on the first Tab press; a clap + kick on every press.
{
  const b = new Float32Array(N);
  const P = 60 / 116;
  const off = presses[0] % P;
  const roots = [45, 41, 48, 43]; // A, F, C, G
  for (let i = 0; off + i * P < dur - 0.6; i++) {
    const t = off + i * P;
    if (i % 2 === 0) kick(b, t, 0.9);
    else clap(b, t, 0.28);
    hat(b, t + P / 2, 0.18);
    hat(b, t, 0.1);
    if (i % 2 === 0) bass(b, t, P * 1.9, hz(roots[Math.floor(i / 4) % 4]), 0.32);
  }
  for (const t of presses) (clap(b, t, 0.7), kick(b, t, 0.8));
  for (const t of [alsoAt, endAt]) (kick(b, t, 1), add(b, t, 1.4, (x) => 0.35 * noise() * Math.exp(-x * 3)));
  wav("music-A.wav", b);
}

// B: near silence: a low breathing pulse, a soft thump under each press (the key sfx plays on top).
{
  const b = new Float32Array(N);
  add(b, 0, dur, (t) => (0.16 * Math.sin(2 * Math.PI * 55 * t) + 0.05 * Math.sin(2 * Math.PI * 82.5 * t)) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.5 * t)) * Math.min(1, t / 1.5));
  for (const t of [...presses, alsoAt, endAt]) add(b, t, 0.5, (x) => 0.5 * Math.sin(2 * Math.PI * 48 * x) * Math.exp(-x * 7));
  wav("music-B.wav", b);
}

// C: sparse plucks: a low note when a caption arrives, a rising pentatonic pluck on every accept.
{
  const b = new Float32Array(N);
  const pent = [57, 60, 62, 64, 67, 69, 72, 74];
  capStarts.forEach((t, i) => pluck(b, t, hz(pent[i % 3] - 12), 0.35, 2.2));
  [...presses, alsoAt + 40 / FPS, alsoAt + 130 / FPS].forEach((t, i) => (pluck(b, t, hz(pent[2 + (i % 6)]), 0.5), pluck(b, t + 0.06, hz(pent[2 + (i % 6)] + 7), 0.25)));
  for (const n of [45, 52, 57]) pluck(b, endAt, hz(n), 0.4, 3);
  wav("music-C.wav", b);
}
