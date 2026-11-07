// End-to-end check of perception, action capture, memory and execution on TabShell's own test window — no user app
// is touched. Needs TabShell.app running (shell/scripts/build-shell.sh --run) and the Accessibility grant.
//   npm run e2e
// 1. starts a hub on a scratch memory.db (port 7800 must be free), opens `TabShell --testbed`
// 2. acts like a user with untagged CGEvents/keystrokes: fills the form, numbers two table rows
// 3. checks the recorded steps (targets resolved, values, before/after screens)
// 4. runs the Actuator on the same window (type, choose, click, a table cell) and checks the screen changed
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../src/memory/store.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SHELL = join(ROOT, "shell/.build/debug/TabShell");
const TB = "exe:TabShell";
const dir = mkdtempSync(join(tmpdir(), "tab-e2e-"));
const dbFile = join(dir, "memory.db");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "✓" : "✗"} ${what}`);
    if (!ok) fails++;
};

type El = { role: string; label: string; path: string; rect: { x: number; y: number; w: number; h: number }; value?: string; checked?: boolean; grid?: { row: number; col?: number } };
const dump = (): El[] => JSON.parse(execFileSync(SHELL, ["--ax-dump", TB]).toString())[0]?.elements ?? [];
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
const exec = (a: object) => execFileSync(SHELL, ["--exec", JSON.stringify({ app: TB, label: "e2e", confidence: 1, source: "model", ...a })]).toString().trim();

import { openSync, readFileSync } from "node:fs";
const hubLog = join(dir, "hub.log");
// Fast tiers only (TAB_LLM=off; E2E_LLM=1 adds the model): the loop under test is perception → memory → habit → ghost → Tab → exec.
const hub = spawn("node", ["--import", "tsx", "src/hub.ts"], {
    cwd: join(ROOT, "brain"),
    env: { ...process.env, TAB_DEBUG: "1", TAB_MEMORY_FILE: dbFile, TAB_LLM: process.env.E2E_LLM ? "on" : "off", TAB_LADDER_FILE: join(dir, "ladder.json") },
    stdio: ["ignore", openSync(hubLog, "a"), openSync(hubLog, "a")],
});
const testbed = spawn(SHELL, ["--testbed", "--signup"], { stdio: "ignore" });
try {
    await sleep(4000); // hub up, TabShell reconnects (≤ 2 s), testbed window opens and comes to the front
    execFileSync("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${testbed.pid}) to true`]);
    await sleep(800);

    // ---- act like a user ----
    let els = dump();
    click(find(els, (e) => e.label === "Full name"));
    await sleep(300);
    keys("Jane Doe");
    await sleep(300);
    click(find(els, (e) => e.label === "Email"));
    await sleep(300);
    keys("jane@acme.com");
    await sleep(300);
    click(find(els, (e) => e.label === "Employer"));
    await sleep(300);
    keys("Initech");
    await sleep(300);
    click(find(els, (e) => e.label === "Subscribe to updates"));
    await sleep(400);
    for (const row of [0, 1]) {
        els = dump();
        click(find(els, (e) => e.role === "textfield" && e.label === "Number" && e.grid?.row === row));
        await sleep(300);
        key(36); // Return starts editing the selected row's cell (a single click only selects the row)
        await sleep(300);
        keys(String(row + 1));
        key(36); // Return commits it
        await sleep(400);
    }
    click(find(els, (e) => e.label === "Submit"));
    await sleep(1800); // the last burst commits after 1.2 s

    const mem = new Memory(dbFile);
    const steps = mem.steps().filter((s) => s.app === TB);
    for (const s of steps) console.log(`   ${s.op.padEnd(5)} ${s.target ? `${s.target.role} "${s.target.label}"${s.target.grid ? ` r${s.target.grid.row}c${s.target.grid.col}` : ""}` : "-"} ${s.value ? JSON.stringify(s.value) : ""} before=${!!s.before_snap} after=${!!s.after_snap}`);
    const typed = (label: string, v: string) => steps.some((s) => s.op === "type" && s.target?.label === label && s.value === v);
    check(typed("Full name", "Jane Doe"), "typing in Full name recorded with its value");
    check(typed("Employer", "Initech"), "typing in Employer recorded");
    check(steps.some((s) => s.op === "click" && s.target?.label === "Subscribe to updates"), "checkbox click resolved to its element");
    check(steps.some((s) => s.op === "type" && s.target?.grid?.row === 1 && s.value === "2"), "table cell edit recorded with its row");
    check(steps.some((s) => s.op === "click" && s.target?.label === "Submit"), "Submit click recorded");
    check(steps.filter((s) => s.op === "type").every((s) => s.before_snap && s.after_snap), "every type step has before and after screens");
    const typeBefore = steps.find((s) => s.op === "type" && s.target?.label === "Employer");
    const bs = typeBefore?.before_snap ? mem.snapshot(typeBefore.before_snap) : null;
    check(!!bs && (bs.els.find((e) => e.l === "Employer")?.v ?? "") === "", "a type step's before screen shows the field empty");
    mem.close();

    // ---- the Actuator on the same window ----
    els = dump();
    const emp = find(els, (e) => e.label === "Employer");
    let t0 = performance.now();
    console.log(`   exec type: ${exec({ op: "type", targetPath: emp.path, value: "Globex Corporation" })}`);
    check(find(dump(), (e) => e.label === "Employer").value === "Globex Corporation", `type replaces the field's value (${(performance.now() - t0).toFixed(0)} ms incl. process start)`);
    const long = "A longer note that should go through the clipboard paste path because it is over forty characters.";
    const name = find(els, (e) => e.label === "Full name");
    execFileSync("bash", ["-c", "printf 'clipboard-sentinel' | pbcopy"]);
    console.log(`   exec paste: ${exec({ op: "type", targetPath: name.path, value: long })}`);
    check(find(dump(), (e) => e.label === "Full name").value === long, "long text is pasted");
    check(execFileSync("pbpaste").toString() === "clipboard-sentinel", "the user's clipboard is restored after a paste");
    const country = find(els, (e) => e.role === "select" && e.label === "Country");
    console.log(`   exec choose: ${exec({ op: "type", targetPath: country.path, value: "Japan" })}`);
    const cv = dump().filter((e) => e.label === "Country").map((e) => `${e.role}=${e.value}`);
    check(cv.includes("select=Japan"), `popup option chosen (${cv.join(", ")})`);
    const sub = find(els, (e) => e.label === "Subscribe to updates");
    const before = sub.checked;
    console.log(`   exec click: ${exec({ op: "click", targetPath: sub.path })}`);
    check(find(dump(), (e) => e.label === "Subscribe to updates").checked !== before, "checkbox toggled by click");
    const cell = find(dump(), (e) => e.role === "textfield" && e.label === "Number" && e.grid?.row === 2);
    console.log(`   exec cell: ${exec({ op: "type", targetPath: cell.path, value: "3" })} · ${exec({ op: "key", value: "Return" })}`);
    check(find(dump(), (e) => e.role === "textfield" && e.label === "Number" && e.grid?.row === 2).value === "3", "table cell typed");

    // ---- the whole loop: a routine done by hand becomes a ghost, and Tab runs it ----
    els = dump();
    const subscribe = find(els, (e) => e.label === "Subscribe to updates");
    const submitBtn = find(els, (e) => e.label === "Submit");
    for (let i = 0; i < 4; i++) {
        click(subscribe);
        await sleep(700);
        click(submitBtn);
        await sleep(700);
    }
    const tMark = Date.now();
    click(subscribe);
    // Wait for a ghost sent after this click (not one from the repetitions), and time it as the hub sees it.
    const traceSince = () => readFileSync(hubLog, "utf8").split("\n").filter((l) => l.startsWith("[trace]") && Number(l.split(" ")[1]) >= tMark);
    let tIn = NaN, tOut = NaN;
    for (let i = 0; i < 80 && Number.isNaN(tOut); i++) {
        await sleep(25);
        const tr = traceSince();
        const iIn = tr.findIndex((l) => l.includes("← shell input click"));
        if (iIn < 0) continue;
        tIn = Number(tr[iIn].split(" ")[1]);
        const out = tr.slice(iIn + 1).find((l) => / → shell ghost$/.test(l));
        if (out) tOut = Number(out.split(" ")[1]);
    }
    const ghostLine = readFileSync(hubLog, "utf8").split("\n").filter((l) => l.startsWith('→ shell {"type":"ghost"')).at(-1) ?? "";
    const ghost = !Number.isNaN(tOut) && ghostLine.includes("Submit") ? ghostLine : "";
    check(!!ghost, `after 4 × (Subscribe, Submit), ticking Subscribe brings a "Click Submit" ghost, ${tOut - tIn} ms after the click`);
    const statusBefore = dump().find((e) => e.role === "text" && e.label.startsWith("Submitted"))?.label;
    await sleep(1600); // the testbed's status shows seconds; let it tick so a new submit is visible
    key(48); // a real Tab press: TabShell's tap accepts the ghost
    await sleep(1200);
    const statusAfter = dump().find((e) => e.role === "text" && e.label.startsWith("Submitted"))?.label;
    check(!!statusAfter && statusAfter !== statusBefore, `Tab ran it: the form was submitted (${statusBefore} → ${statusAfter})`);
    const accepted = readFileSync(hubLog, "utf8").includes('"type":"accept"');
    check(accepted, "the hub got the accept");

    // ---- forms are retrieval: a differently worded field on another form gets what was typed before ----
    const signupWin = () => JSON.parse(execFileSync(SHELL, ["--ax-dump", TB]).toString())[0];
    execFileSync("osascript", ["-e", `tell application "System Events" to tell (first process whose unix id is ${testbed.pid}) to perform action "AXRaise" of window "Sign up"`]);
    await sleep(800);
    const sw = signupWin();
    check(sw?.window === "Sign up", `the Sign up window is focused (${sw?.window})`);
    const workEmail = (sw?.elements as El[]).find((e) => e.label === "Work email");
    if (workEmail) {
        const mark = readFileSync(hubLog, "utf8").length;
        click(workEmail);
        let g = "";
        for (let i = 0; i < 30 && !g; i++) {
            await sleep(150);
            g = readFileSync(hubLog, "utf8").slice(mark).split("\n").find((l) => l.includes('"type":"ghost"') && l.includes("jane@acme.com")) ?? "";
        }
        check(!!g, `focusing "Work email" offers jane@acme.com (typed into "Email" on the other form)${g ? "" : ""}`);
        key(48); // Tab accepts
        await sleep(900);
        const v = (signupWin()?.elements as El[]).find((e) => e.label === "Work email")?.value;
        check(v === "jane@acme.com", `Tab filled it (${v})`);

        // Autocomplete while typing: "Jane" in "Your name" completes to "Jane Doe" (typed into "Full name" before).
        const yourName = (signupWin()?.elements as El[]).find((e) => e.label === "Your name");
        if (yourName) {
            click(yourName);
            await sleep(300);
            const mark2 = readFileSync(hubLog, "utf8").length;
            keys("Jane");
            let g2 = "";
            for (let i = 0; i < 30 && !g2; i++) {
                await sleep(150);
                g2 = readFileSync(hubLog, "utf8").slice(mark2).split("\n").find((l) => l.includes('"type":"ghost"') && l.includes('"ghostText":" Doe"')) ?? "";
            }
            check(!!g2 && g2.includes('"caret"'), `typing "Jane" shows a completion " Doe" at the insertion point`);
            key(48);
            await sleep(900);
            const v2 = (signupWin()?.elements as El[]).find((e) => e.label === "Your name")?.value;
            check(v2 === "Jane Doe", `Tab completed it (${v2})`);
        }
    }

    // ---- numbering rows: three by hand, Tab for the next, Tab for the rest ----
    execFileSync("osascript", ["-e", `tell application "System Events" to tell (first process whose unix id is ${testbed.pid}) to perform action "AXRaise" of window "Tab Testbed"`]);
    await sleep(800);
    const numberCell = (row: number) => dump().find((e) => e.role === "textfield" && e.label === "Number" && e.grid?.row === row);
    for (const [row, v] of [[2, "10"], [3, "20"], [4, "30"]] as const) {
        click(numberCell(row)!);
        await sleep(300);
        key(36);
        await sleep(300);
        keys(v);
        key(36);
        await sleep(500);
    }
    const ghostAfter = async (mark: number, needle: string) => {
        for (let i = 0; i < 30; i++) {
            const g = readFileSync(hubLog, "utf8").slice(mark).split("\n").find((l) => l.includes('"type":"ghost"') && l.includes(needle));
            if (g) return g;
            await sleep(150);
        }
        return "";
    };
    let mark = 0;
    check(!!(await ghostAfter(mark, '"ghostText":"40"')), "after 10, 20, 30 the next row gets a 40 ghost");
    mark = readFileSync(hubLog, "utf8").length;
    key(48);
    await sleep(1200);
    check(numberCell(5)?.value === "40", `Tab typed it (row 5 = ${numberCell(5)?.value})`);
    const batch = await ghostAfter(mark, "Fill the remaining");
    check(!!batch, `then: ${/"label":"([^"]+)"/.exec(batch)?.[1] ?? "no batch ghost"}`);
    key(48);
    await sleep(2500);
    check(numberCell(6)?.value === "50" && numberCell(7)?.value === "60", `Tab filled the rest (rows 6, 7 = ${numberCell(6)?.value}, ${numberCell(7)?.value})`);
} catch (err) {
    console.error("e2e error:", (err as Error).message);
    fails++;
} finally {
    testbed.kill();
    hub.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : "\nall checks passed");
process.exit(fails ? 1 : 0);
