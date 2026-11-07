// takes/<name>.jsonl + .mov → public/takes/<name>.json (events in seconds from the first video frame)
// and public/takes/<name>.mp4 (30 fps, short GOP for fast seeking). Usage: node rec/events.mjs <name> [--no-video]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const name = process.argv[2];
const here = new URL(".", import.meta.url).pathname;
const pub = here + "../public/takes/";
mkdirSync(pub, { recursive: true });
const mov = `${here}takes/${name}.mov`;
const start = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", mov], { encoding: "utf8" }).stdout.trim());
const dur = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mov], { encoding: "utf8" }).stdout.trim());
const lines = readFileSync(`${here}takes/${name}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const t0 = lines.find((l) => l.ev === "rec_frame0").t0; // wall-clock time of the first video frame
void start;
const ev = lines.map((l) => ({ ...l, s: +((l.t - t0) / 1000).toFixed(3) }));
const out = {
  start: t0,
  duration: dur,
  ghosts: ev.filter((e) => e.ev === "ghost").map((e) => ({ s: e.s, kind: e.ghost.kind, label: e.ghost.label, rect: e.ghost.rect, pillAt: e.ghost.pillAt, dockApp: e.ghost.dockApp, text: e.ghost.ghostText?.slice(0, 60) })),
  hides: ev.filter((e) => e.ev === "hide").map((e) => e.s),
  keys: ev.filter((e) => e.ev === "key").map((e) => ({ s: e.s, key: e.key, what: e.what })),
  clicks: ev.filter((e) => e.ev === "click").map((e) => ({ s: e.s, x: e.x, y: e.y, css: e.css })),
  user: ev.filter((e) => e.ev === "user").map((e) => ({ s: e.s, what: e.what })),
  pay: ev.filter((e) => e.ev === "msg" && /payment/.test(e.type)).map((e) => ({ s: e.s, type: e.type, msg: e.msg })),
  hud: ev.filter((e) => e.ev === "hud").map((e) => ({ s: e.s, hud: e.hud })).slice(-1),
  errors: ev.filter((e) => e.ev === "error"),
};
writeFileSync(`${pub}${name}.json`, JSON.stringify(out, null, 1));
console.log(`${name}: video start ${new Date(t0).toISOString()} dur ${dur.toFixed(1)}s`);
for (const g of out.ghosts) console.log(`  ${g.s.toFixed(2).padStart(6)}s ghost ${g.kind.padEnd(7)} ${g.label}${g.rect ? ` @${Math.round(g.rect.x)},${Math.round(g.rect.y)} ${Math.round(g.rect.w)}×${Math.round(g.rect.h)}` : g.pillAt ? ` pill@${Math.round(g.pillAt.x)},${Math.round(g.pillAt.y)}` : ""}`);
for (const k of out.keys) console.log(`  ${k.s.toFixed(2).padStart(6)}s key ${k.key} ${k.what ?? ""}`);
for (const u of out.user) console.log(`  ${u.s.toFixed(2).padStart(6)}s user ${u.what}`);
for (const e of out.errors) console.log(`  ERROR ${e.error}`);
if (!process.argv.includes("--no-video"))
  spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", mov, "-r", "30", "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", `${pub}${name}.mp4`], { stdio: "inherit" });
