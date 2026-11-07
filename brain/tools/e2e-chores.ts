// End-to-end check of teach once, repeat, then "do the remaining", on TabShell's chores test windows: no user app is
// touched. Needs TabShell.app running (shell/scripts/build-shell.sh --run) and the Accessibility grant. It moves the
// real mouse and types, so leave the Mac alone while it runs.
//   npm run e2e:chores
// 1. starts a hub on a scratch memory.db (port 7800 must be free), opens `TabShell --testbed --chores`
// 2. by hand, enters the first release (ENG-141, #11) in Tracker, copying the values from Releases, and saves
// 3. Tab accepts "Repeat for ENG-142 · #12", then the same for ENG-143, then "Do the remaining 2"
// 4. checks every entry the Tracker saved, then that coming back to Tracker offers the whole list again
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const SHELL = join(ROOT, "shell/.build/debug/TabShell");
const TB = "exe:TabShell";
const dir = mkdtempSync(join(tmpdir(), "tab-e2e-chores-"));
const choresLog = join(dir, "saved.txt");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) fails++;
};

type El = { role: string; label: string; path: string; rect: { x: number; y: number; w: number; h: number } };
const front = (): { window: string; elements: El[] } => JSON.parse(execFileSync(SHELL, ["--ax-dump", TB]).toString())[0] ?? { window: "", elements: [] };
const find = (els: El[], f: (e: El) => boolean) => {
    const e = els.find(f);
    if (!e) throw new Error("element not found");
    return e;
};

// Untagged input: Tab's recorder must see these as the user's.
const clickSwift = join(dir, "click.swift");
writeFileSync(clickSwift, `import CoreGraphics
import Foundation
let x = Double(CommandLine.arguments[1])!, y = Double(CommandLine.arguments[2])!
for t in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseUp] {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!.post(tap: .cghidEventTap)
    usleep(40_000)
}
`);
const click = (e: El) => execFileSync("swift", [clickSwift, String(e.rect.x + e.rect.w / 2), String(e.rect.y + e.rect.h / 2)]);
const keys = (s: string) => execFileSync("osascript", ["-e", `tell application "System Events" to keystroke ${JSON.stringify(s)}`]);
const key = (code: number) => execFileSync("osascript", ["-e", `tell application "System Events" to key code ${code}`]);
const saved = () => (existsSync(choresLog) ? readFileSync(choresLog, "utf8").trim().split("\n").filter(Boolean) : []);

const hubLog = join(dir, "hub.log");
const hub = spawn("node", ["--import", "tsx", "src/hub.ts"], {
    cwd: join(ROOT, "brain"),
    env: { ...process.env, TAB_DEBUG: "1", TAB_MEMORY_FILE: join(dir, "memory.db"), TAB_LLM: "off", TAB_LADDER_FILE: join(dir, "ladder.json") },
    stdio: ["ignore", openSync(hubLog, "a"), openSync(hubLog, "a")],
});
const testbed = spawn(SHELL, ["--testbed", "--chores"], { stdio: "ignore", env: { ...process.env, TAB_CHORES_LOG: choresLog } });
const raise = (title: string) =>
    execFileSync("osascript", ["-e", `tell application "System Events" to tell (first process whose unix id is ${testbed.pid}) to perform action "AXRaise" of window "${title}"`]);
const logLen = () => readFileSync(hubLog, "utf8").length;
const ghostAfter = async (mark: number, needle: string, tries = 40) => {
    for (let i = 0; i < tries; i++) {
        const g = readFileSync(hubLog, "utf8").slice(mark).split("\n").find((l) => l.includes('"type":"ghost"') && l.includes(needle));
        if (g) return g;
        await sleep(150);
    }
    return "";
};
const pill = (g: string) => /"label":"([^"]+)"/.exec(g)?.[1] ?? "no ghost";

try {
    await sleep(4000); // hub up, TabShell reconnects (≤ 2 s), the windows open
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${testbed.pid}) to true`]);
    raise("Releases"); // TabShell reads the list once, as a user glancing at it would
    await sleep(1000);
    raise("Tracker");
    await sleep(1000);
    const tr = front();
    check(tr.window === "Tracker", `Tracker is focused (${tr.window})`);

    // ---- teach once: the first release by hand ----
    click(find(tr.elements, (e) => e.label === "Ticket" && e.role === "textfield"));
    await sleep(300);
    keys("ENG-141");
    await sleep(300);
    click(find(tr.elements, (e) => e.label === "PR" && e.role === "textfield"));
    await sleep(300);
    keys("#11");
    await sleep(300);
    click(find(tr.elements, (e) => e.label === "Done"));
    await sleep(400);
    let mark = logLen();
    click(find(tr.elements, (e) => e.label === "Save"));
    for (let i = 0; i < 20 && !saved().length; i++) await sleep(100);
    check(saved()[0] === "ENG-141 #11 done", `saved by hand: ${saved()[0]}`);

    // ---- repeat, twice ----
    for (const [n, t, p] of [[2, "ENG-142", "#12"], [3, "ENG-143", "#13"]] as const) {
        const g = await ghostAfter(mark, `Repeat for ${t}`);
        check(!!g, `then: ${pill(g)}`);
        mark = logLen();
        key(48); // a real Tab press: TabShell's tap accepts the ghost
        for (let i = 0; i < 40 && saved().length < n; i++) await sleep(150);
        check(saved()[n - 1] === `${t} ${p} done`, `Tab entered ${t}: ${saved()[n - 1] ?? "nothing saved"}`);
    }

    // ---- the rest at once ----
    const rest = await ghostAfter(mark, "Do the remaining 2");
    check(!!rest, `then: ${pill(rest)}`);
    key(48);
    for (let i = 0; i < 60 && saved().length < 5; i++) await sleep(150);
    check(saved().slice(3).join(", ") === "ENG-144 #14 done, ENG-145 #15 done", `Tab entered the rest: ${saved().slice(3).join(", ")}`);
    check(saved().length === 5, `5 entries, none twice (${saved().length})`);

    // ---- recall: back in Tracker later, the learned chore is offered for the whole list ----
    raise("Releases");
    await sleep(1000);
    mark = logLen();
    raise("Tracker");
    const again = await ghostAfter(mark, "Do all 5 from Releases");
    check(!!again, `back in Tracker: ${pill(again)}`);
    key(53); // Esc: dismiss it, nothing runs
    await sleep(800);
    check(saved().length === 5, "dismissed: nothing more was saved");
} catch (err) {
    console.error("e2e error:", (err as Error).message);
    fails++;
} finally {
    testbed.kill();
    hub.kill();
}
console.log(fails ? `\n${fails} check(s) failed (hub log: ${hubLog})` : "\nall checks passed");
process.exit(fails ? 1 : 0);
