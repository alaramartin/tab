// Records one real take of a Tab flow: full-screen capture (ffmpeg, wall-clock timestamps) + every hub message,
// while playing the user with real OS input (drive) and pressing the real Tab key on ghosts.
//   npx tsx rec/take.ts tickets|resale|push|release|hud [--no-rec]
// Output: rec/takes/<name>.mp4 + rec/takes/<name>.jsonl ({t, ev, ...}); t = epoch ms.
import CDP from "chrome-remote-interface";
import WebSocket from "ws";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
const noRec = process.argv.includes("--no-rec");
const here = fileURLToPath(new URL(".", import.meta.url));
const out = here + "takes/";
mkdirSync(out, { recursive: true });
const logFile = `${out}${name}.jsonl`;
writeFileSync(logFile, "");
const log = (ev: string, data: object = {}) => appendFileSync(logFile, JSON.stringify({ t: Date.now(), ev, ...data }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drive = (...a: (string | number)[]) => spawnSync(here + "drive", a.map(String), { stdio: "inherit" });

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
// A page in its own new Chrome window (so two-window layouts don't share one window).
async function newWindow(url: string): Promise<CDP.Client> {
    const { webSocketDebuggerUrl } = await (await fetch("http://127.0.0.1:9222/json/version")).json();
    const b = await CDP({ target: webSocketDebuggerUrl });
    const { targetId } = await b.Target.createTarget({ url, newWindow: true });
    await b.close();
    const c = await CDP({ port: 9222, target: targetId });
    await c.Page.enable();
    await c.Runtime.enable();
    await sleep(2500);
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
const front = (app: string) => spawnSync("osascript", ["-e", `tell application "${app}" to activate`]);
const chromeFront = async (c: CDP.Client) => { await c.Page.bringToFront(); front("Google Chrome"); await sleep(400); };

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

// ---------- takes ----------
const L = { x: 24, y: 44, w: 1100, h: 790 }; // single-window layout (points); HUD lives top right

async function tickets() {
    const c = await page("tickets.localhost", "http://tickets.localhost:4001/e/night-owls");
    await nav(c, "http://tickets.localhost:4001/e/night-owls");
    await bounds(c, L.x, L.y, L.w, L.h);
    await chromeFront(c);
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
    let g = await waitGhost((g) => g.label.startsWith("Click Checkout"), 12000, "Checkout");
    await sleep(1400);
    await tab("Checkout");
    g = await waitGhost((g) => g.label.startsWith("Click Buy"), 12000, "Buy");
    await sleep(1300);
    await tab("Buy");
    g = await waitGhost((g) => g.kind === "pay", 12000, "Pay");
    await sleep(1800);
    await tab("Pay");
    await waitGhost((g) => g.kind === "done" || g.kind === "blocked", 25000, "Paid");
    g = await waitGhost((g) => !!g.dockApp || /Calendar/.test(g.label), 12000, "Calendar offer");
    await sleep(1800);
    await tab("Calendar");
    await sleep(6500);
    await recStop();
}

async function resale() {
    const c = await page("resale.localhost", "http://resale.localhost:4002/e/night-owls");
    await nav(c, "http://resale.localhost:4002/checkout?qty=2");
    await bounds(c, L.x, L.y, L.w, L.h);
    await chromeFront(c);
    drive("move", 700, 300, 300);
    await recStart();
    await sleep(1500);
    // Tab may offer "Click Buy"; accept it if so, else click by hand.
    try {
        await waitGhost((g) => g.label.startsWith("Click Buy"), 5000, "Buy");
        await sleep(1000);
        await tab("Buy");
    } catch {
        await clickEl(c, "#buy");
    }
    await waitGhost((g) => g.kind === "blocked", 12000, "Blocked");
    await sleep(2200);
    await tab("Blocked (does nothing)");
    await sleep(1800);
    log("key", { key: "esc" });
    drive("key", "esc");
    await sleep(2200);
    await recStop();
}

async function push() {
    // Close the demo-site tabs so no stale ghost from them shows over Terminal.
    for (const t of await CDP.List({ port: 9222 })) if (t.type === "page" && /(tickets|resale)\.localhost/.test(t.url)) await CDP.Close({ port: 9222, id: t.id });
    // Chrome left (the repo), Terminal right.
    const c = await newWindow("https://github.com/alaramartin/tab-demo");
    await bounds(c, 0, 38, 760, 820);
    spawnSync("osascript", ["-e", `tell application "Terminal"
        activate
        if (count of windows) = 0 then do script ""
        set bounds of front window to {772, 204, 1432, 858}
        set font size of current settings of front window to 14
        do script "cd ~/Projects/tab-demo && clear" in front window
    end tell`]);
    spawnSync("osascript", ["-e", 'tell application "System Events" to set visible of process "Terminal" to true', "-e", 'tell application "System Events" to set frontmost of process "Terminal" to true']);
    await sleep(1200);
    const fm = spawnSync("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { encoding: "utf8" }).stdout.trim();
    if (fm !== "Terminal") throw new Error(`Terminal not frontmost (${fm})`);
    drive("click", 1100, 600, 300); // focus the Terminal window
    await recStart();
    await sleep(1500);
    drive("type", "git push -u origin fix/checkout-rounding", 16);
    await sleep(300);
    drive("key", "return");
    log("user", { what: "git push" });
    await waitGhost((g) => g.label.startsWith("Open pull request"), 20000, "Open PR");
    await sleep(1500);
    await tab("Open PR");
    // Like a person: once GitHub's compare page is up, scroll down to the description box.
    await sleep(2500);
    const gh = await page("/compare/");
    await ev(gh, `new Promise(r => { const t = setInterval(() => { if (document.getElementById("pull_request_body")) { clearInterval(t); r(1); } }, 100); })`);
    for (let i = 0; i < 12; i++) {
        const y = await ev(gh, `document.getElementById("pull_request_body").getBoundingClientRect().top / innerHeight`);
        if (y < 0.45) break;
        drive("scroll", 380, 600, -4);
        await sleep(120);
    }
    log("user", { what: "scrolled to description" });
    await waitGhost((g) => g.kind === "text", 25000, "Description");
    await sleep(2000);
    await tab("Description");
    await waitGhost((g) => g.label.startsWith("Click Create pull request"), 20000, "Create PR");
    await sleep(1500);
    await tab("Create PR");
    await sleep(5000);
    await recStop();
}

async function release() {
    await fetch("http://127.0.0.1:4003/api/reset", { method: "POST", headers: { host: "tracker.localhost:4003" } }).catch(() => {});
    const rel = await newWindow("https://github.com/alaramartin/tab-demo/releases/tag/v1.4.0");
    await bounds(rel, 0, 38, 700, 820);
    const c = await page("tracker.localhost", "http://tracker.localhost:4003/");
    await nav(c, "http://tracker.localhost:4003/");
    await bounds(c, 700, 210, 732, 650);
    await chromeFront(c);
    drive("move", 1080, 500, 300);
    await recStart();
    await sleep(1500);
    await clickEl(c, "#search");
    drive("type", "ENG-142", 10);
    await sleep(500);
    await clickEl(c, "#list li:nth-child(1) button");
    await sleep(600);
    await clickEl(c, "#p-status");
    await sleep(500);
    drive("type", "Done", 8);
    drive("key", "return");
    await sleep(400);
    await clickEl(c, "#p-pr");
    drive("type", "#12", 8);
    await sleep(300);
    await clickEl(c, "#save");
    log("user", { what: "ticket 1 done" });
    drive("move", 1150, 760, 600);
    await waitGhost((g) => g.label.startsWith("Repeat for ENG-150"), 12000, "Repeat 150");
    await sleep(1600);
    await tab("Repeat 150");
    await waitGhost((g) => g.label.startsWith("Repeat for ENG-151"), 12000, "Repeat 151");
    await sleep(1200);
    await tab("Repeat 151");
    await waitGhost((g) => g.label.startsWith("Do the remaining"), 12000, "Remaining");
    await sleep(1500);
    await tab("Remaining");
    await ev(c, `new Promise(r => { const t = setInterval(() => fetch("/api/tickets").then(x => x.json()).then(ts => { if (ts.every(t => t.status === "Done")) { clearInterval(t); r(1); } }), 200); setTimeout(() => r(0), 25000); })`);
    log("user", { what: "all six done" });
    // Clear the search so the whole list shows six Done, like a person checking.
    await clickEl(c, "#search");
    drive("key", "cmd-a");
    drive("key", "delete");
    await sleep(3500);
    await recStop();
}

async function hud() {
    // Just a few seconds of the desktop with the HUD, for the end card.
    await recStart();
    await sleep(4000);
    await recStop();
}

const takes: Record<string, () => Promise<void>> = { tickets, resale, push, release, hud };
try {
    log("take", { name });
    await takes[name]();
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
