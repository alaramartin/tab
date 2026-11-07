// End-to-end check of the vision fallback on a window with no Accessibility tree (`TabShell --testbed --canvas`).
// TabShell.app needs its own Screen Recording grant for OCR, so this runs the debug TabShell (which inherits the
// terminal's permissions) in place of the app for the duration, then relaunches the app.
//   npm run e2e:canvas
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SHELL = join(ROOT, "shell/.build/debug/TabShell");
const dir = mkdtempSync(join(tmpdir(), "tab-e2e-canvas-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) fails++;
};

const clickSwift = join(dir, "click.swift");
writeFileSync(clickSwift, `import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(40_000)
}
`);
type Ocr = { role: string; label: string; x: number; y: number; w: number; h: number };
const ocr = (): Ocr[] =>
    execFileSync(SHELL, ["--ocr", `pid:${canvas.pid}`]).toString().split("\n").slice(2).filter(Boolean).map((l) => {
        const m = /^\s+(\w+)\s+(-?\d+),(-?\d+) (\d+)×(\d+)\s+(.*)$/.exec(l)!;
        return { role: m[1], x: +m[2], y: +m[3], w: +m[4], h: +m[5], label: m[6] };
    });
const click = (o: Ocr) => execFileSync("swift", [clickSwift, String(o.x + o.w / 2), String(o.y + o.h / 2)]);

const appWasRunning = (() => {
    try {
        execFileSync("pgrep", ["-f", "TabShell.app/Contents/MacOS/TabShell"]);
        return true;
    } catch {
        return false;
    }
})();
try {
    execFileSync("pkill", ["-f", "TabShell.app/Contents/MacOS/TabShell"]);
} catch {}
const hubLog = join(dir, "hub.log");
const dbFile = join(dir, "memory.db");
const hub = spawn("node", ["--import", "tsx", "src/hub.ts"], {
    cwd: join(ROOT, "brain"),
    env: { ...process.env, TAB_VERBOSE: "1", TAB_MEMORY_FILE: dbFile, TAB_MODEL: "", TAB_LADDER_FILE: join(dir, "ladder.json") },
    stdio: ["ignore", openSync(hubLog, "a"), openSync(hubLog, "a")],
});
const shellLog = join(dir, "shell.log");
const shell = spawn(SHELL, [], { stdio: ["ignore", openSync(shellLog, "a"), openSync(shellLog, "a")], env: { ...process.env, TAB_ICON_CACHE: join(dir, "icon-labels.json") } });
const canvasLog = join(dir, "canvas.txt");
const canvas = spawn(SHELL, ["--testbed", "--canvas"], { stdio: "ignore", env: { ...process.env, TAB_CANVAS_LOG: canvasLog } });
try {
    await sleep(4000);
    check(readFileSync(shellLog, "utf8").includes("screen recording granted"), "the shell has Screen Recording (OCR on)");
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${canvas.pid}) to true`]);
    await sleep(1500); // the poller sees a poor AX tree and runs OCR
    // Button centres from the window frame and the canvas layout (a second process can't capture while the shell does).
    const [wx, wy, ww, wh] = execFileSync("osascript", ["-e", `tell application "System Events" to tell (first process whose unix id is ${canvas.pid}) to get {position, size} of window "Canvas"`])
        .toString().trim().split(/,\s*/).map(Number);
    const top = wy + wh - 160; // content area is 160 pt tall, under the title bar
    const names = ["Open", "Archive", "Snooze", "Delete"];
    const btn = (l: string): Ocr => ({ role: "button", label: l, x: wx + 30 + names.indexOf(l) * 120, y: top + 40, w: 100, h: 40 });
    void ww;
    const counts = () => readFileSync(canvasLog, "utf8").trim();

    for (let i = 0; i < 4; i++) {
        click(btn("Open"));
        await sleep(800);
        click(btn("Archive"));
        await sleep(800);
    }
    check(counts() === "Open=4 Archive=4 Snooze=0 Delete=0", `the clicks landed (${counts()})`);
    const mem = new Memory(dbFile);
    const clicks = mem.steps().filter((s) => s.op === "click" && s.app === "exe:TabShell");
    mem.close();
    check(clicks.filter((s) => s.target?.label === "Archive").length >= 4, `canvas clicks are recorded against OCR targets (${clicks.map((s) => s.target?.label ?? "?").join(", ")})`);

    const mark = readFileSync(hubLog, "utf8").length;
    click(btn("Open"));
    let ghost = "";
    for (let i = 0; i < 30 && !ghost; i++) {
        await sleep(150);
        ghost = readFileSync(hubLog, "utf8").slice(mark).split("\n").find((l) => l.includes('"type":"ghost"') && l.includes("Archive")) ?? "";
    }
    check(!!ghost, `after 4 × (Open, Archive), clicking Open brings a ghost on Archive (${/"label":"([^"]+)"/.exec(ghost)?.[1] ?? "none"})`);
    execFileSync("osascript", ["-e", "tell application \"System Events\" to key code 48"]);
    await sleep(1500);
    const status = counts();
    check(/Archive=5/.test(status), `Tab clicked the drawn Archive button (${status})`);

    // ---- icon-only buttons get names from their pixels ----
    canvas.kill();
    const tb = spawn(SHELL, ["--testbed"], { stdio: "ignore" });
    try {
        await sleep(2000);
        execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${tb.pid}) to true`]);
        let named: string[] = [];
        for (let i = 0; i < 40 && named.length < 4; i++) {
            await sleep(250);
            const m = /icons named: (.*)/.exec(readFileSync(shellLog, "utf8").split("\n").filter((l) => l.includes("icons named")).join(", "));
            named = m ? m[1].split(", ").filter((x) => x && x !== "?") : [];
        }
        check(named.length >= 3, `icon-only buttons were named by the vision model (${named.join(", ")})`);
        await sleep(1200);
        const mem2 = new Memory(dbFile);
        const latest = mem2.db.prepare("SELECT hash FROM snapshots WHERE app = 'exe:TabShell' ORDER BY last_ts DESC LIMIT 1").get() as { hash: string } | undefined;
        const labels = latest ? mem2.snapshot(latest.hash)!.els.filter((e) => e.r === "button").map((e) => e.l) : [];
        mem2.close();
        check(labels.some((l) => /trash/i.test(l)) && labels.some((l) => /star/i.test(l)), `the names are on the screens the hub sees (${labels.join(", ")})`);
    } finally {
        tb.kill();
    }
} catch (err) {
    console.error("e2e error:", (err as Error).message);
    fails++;
} finally {
    canvas.kill();
    shell.kill();
    hub.kill();
    if (appWasRunning) execFileSync("open", [join(ROOT, "shell/build/TabShell.app")]);
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
