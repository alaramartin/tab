// Records one real take of the Hall 9 tickets flow: full-screen capture (ffmpeg, wall-clock timestamps) + every hub message,
// while playing the user with real OS input (drive) and pressing the real Tab key on ghosts.
//   npx tsx rec/take.mts <name> [--no-rec]
// Output: rec/takes/<name>.mov + rec/takes/<name>.jsonl ({t, ev, ...}); t = epoch ms. Then: node rec/events.mjs <name>
import CDP from "chrome-remote-interface";
import WebSocket from "ws";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const name = process.argv[2] ?? "tickets";
const noRec = process.argv.includes("--no-rec");
const here = fileURLToPath(new URL(".", import.meta.url));
const out = here + "takes/";
mkdirSync(out, { recursive: true });
const logFile = `${out}${name}.jsonl`;
writeFileSync(logFile, "");
const log = (ev: string, data: object = {}) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), ev, ...data }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drive = (...a: (string | number)[]) => spawnSync(here + "drive", a.map(String), { stdio: "inherit" });
const osa = (s: string) => spawnSync("osascript", ["-e", s], { encoding: "utf8" }).stdout.trim();

// ---------- hub ----------
type Ghost = { id: string; kind: string; label: string; rect?: any; pillAt?: any; ghostText?: string; dockApp?: string };
let live: Ghost | null = null;
const hub = new WebSocket("ws://127.0.0.1:7800");
await new Promise<void>((res, rej) => (hub.once("open", () => res()), hub.once("error", rej)));
hub.send(JSON.stringify({ type: "hello", role: "tool" }));
hub.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.to === "shell" && m.msg?.type === "ghost") (live = m.msg.ghost), log("ghost", { ghost: m.msg.ghost });
    else if (m.to === "shell" && m.msg?.type === "ghost_hide") (live = null), log("hide");
    else if (m.to === "shell" && m.msg?.type === "hud") log("hud", { hud: m.msg.hud });
    else if (m.msg?.type && m.msg.type !== "state") log("msg", { to: m.to, from: m.from, type: m.msg.type, msg: m.msg.type === "exec" || m.msg.type === "payment_result" || m.msg.type === "payment_required" ? m.msg : undefined });
});
async function waitGhost(pred: (g: Ghost) => boolean, ms = 10000, what = ""): Promise<Ghost> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (live && pred(live)) return live;
        await sleep(40);
    }
    throw new Error(`no ghost: ${what} (last: ${live?.label ?? "none"})`);
}
async function tab(what: string) {
    log("key", { key: "tab", what });
    drive("key", "tab");
}

// ---------- Chrome (debug, :9222) ----------
async function page(match: string, url?: string): Promise<CDP.Client> {
    let t = (await CDP.List({ port: 9222 })).find((x: any) => x.type === "page" && x.url.includes(match));
    if (!t) t = await CDP.New({ port: 9222, url: url ?? match });
    const c = await CDP({ port: 9222, target: t.id });
    await c.Page.enable();
    await c.Runtime.enable();
    return c;
}
async function ev(c: CDP.Client, expr: string) {
    const { result, exceptionDetails } = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
}
async function bounds(c: CDP.Client, left: number, top: number, width: number, height: number) {
    const { targetInfo } = await c.Target.getTargetInfo();
    const { windowId } = await c.Browser.getWindowForTarget({ targetId: targetInfo.targetId });
    await c.Browser.setWindowBounds({ windowId, bounds: { windowState: "normal" } });
    await c.Browser.setWindowBounds({ windowId, bounds: { left, top, width, height } });
}
async function nav(c: CDP.Client, url: string) {
    const loaded = c.Page.loadEventFired();
    await c.Page.navigate({ url });
    await loaded;
    await sleep(600);
}
// Screen point (points) of an element's center.
async function at(c: CDP.Client, css: string, dx = 0, dy = 0): Promise<[number, number]> {
    const p = await ev(c, `(() => { const el = document.querySelector(${JSON.stringify(css)}); el.scrollIntoViewIfNeeded?.(); const r = el.getBoundingClientRect();
        return [window.screenX + r.left + r.width / 2, window.screenY + (window.outerHeight - window.innerHeight) + r.top + r.height / 2]; })()`);
    return [Math.round(p[0] + dx), Math.round(p[1] + dy)];
}
async function clickEl(c: CDP.Client, css: string, dx = 0, dy = 0) {
    const [x, y] = await at(c, css, dx, dy);
    log("click", { css, x, y });
    drive("click", x, y);
}

// ---------- recording ----------
let ff: ChildProcess | null = null;
async function recStart() {
    if (noRec) return;
    ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "avfoundation", "-capture_cursor", "1", "-pixel_format", "nv12", "-framerate", "60",
        "-i", "Capture screen 0:none", "-c:v", "h264_videotoolbox", "-b:v", "60M", "-progress", "pipe:1", "-stats_period", "0.1", `${out}${name}.mov`], { stdio: ["pipe", "pipe", "inherit"] });
    // Sync: the first progress report with frame=N>0 puts frame 0 at now - N/60 s.
    await new Promise<void>((res) => {
        let done = false;
        ff!.stdout!.on("data", (d: Buffer) => {
            const m = /frame=(\d+)/.exec(String(d));
            if (!done && m && Number(m[1]) > 0) {
                done = true;
                log("rec_frame0", { t0: Date.now() - (Number(m[1]) / 60) * 1000 });
                res();
            }
        });
    });
    await sleep(1200);
    log("rec_start");
}
async function recStop() {
    log("rec_stop");
    if (!ff) return;
    ff.stdin!.write("q");
    await new Promise((r) => ff!.once("exit", r));
}

// ---------- setup ----------
// Hub only (pattern history, HUD counters); no GitHub, unlike web's reset-demo.
async function resetHub() {
    hub.send(JSON.stringify({ type: "reset", keepWorkflows: false }));
    await sleep(400);
}
// Events Tab put in the Tab Demo calendar on earlier takes.
function clearTabDemoCalendar() {
    const n = osa(`tell application "Calendar"
        if not (exists calendar "Tab Demo") then return 0
        set evs to (every event of calendar "Tab Demo")
        set n to count of evs
        repeat with e in evs
            delete e
        end repeat
        return n
    end tell`);
    log("calendar_cleared", { n });
    osa('tell application "System Events" to set visible of process "Calendar" to false');
}

// ---------- take ----------
const L = { x: 24, y: 44, w: 1100, h: 790 }; // single-window layout (points); HUD lives top right

async function tickets() {
    clearTabDemoCalendar();
    await resetHub();
    const c = await page("tickets.localhost", "http://tickets.localhost:4001/e/night-owls");
    await nav(c, "http://tickets.localhost:4001/e/night-owls");
    await bounds(c, L.x, L.y, L.w, L.h);
    await c.Page.bringToFront();
    osa('tell application "Google Chrome" to activate');
    await sleep(400);
    drive("move", 760, 600, 300);
    await recStart();
    await sleep(1800);
    await clickEl(c, "#qty");
    await sleep(500);
    drive("type", "2", 6);
    await sleep(200);
    drive("key", "return");
    log("user", { what: "Qty 2" });
    drive("move", 900, 640, 700);
    await waitGhost((g) => g.label.startsWith("Click Checkout"), 12000, "Checkout");
    await sleep(1400);
    await tab("Checkout");
    await waitGhost((g) => g.label.startsWith("Click Buy"), 12000, "Buy");
    await sleep(1300);
    await tab("Buy");
    await waitGhost((g) => g.kind === "pay", 12000, "Pay");
    await sleep(1800);
    await tab("Pay");
    await waitGhost((g) => g.kind === "done" || g.kind === "blocked", 25000, "Paid");
    await waitGhost((g) => !!g.dockApp || /Calendar/.test(g.label), 12000, "Calendar offer");
    await sleep(1800);
    await tab("Calendar");
    await sleep(6500);
    await recStop();
}

try {
    log("take", { name });
    await tickets();
    console.log(`take ${name} ✓`);
} catch (e) {
    log("error", { error: String(e) });
    console.error(`take ${name} ✗ ${e}`);
    await recStop().catch(() => {});
    process.exitCode = 1;
} finally {
    hub.close();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
