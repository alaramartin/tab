// Headless rehearsal of the web flows against the real hub, web process and demo sites.
// Plays the user (real CDP mouse/keys in Chrome) and plays the shell toward the hub (frontmost, accept,
// dismiss), then checks every ghost and every outcome. Screenshots go to design/shots/try-*.png.
//   npm run try -- [flow1|flow2|flow3|flow4|all|flow3-recall]
//   flow2: pushes the demo branch for real, plays the Terminal (A's reader) with the push output, then the PR page:
//   Open pull request → Write description → Create pull request (a real PR on GITHUB_DEMO_REPO; reset-demo closes it).
//   flow3-recall: flow 3, then reset-demo --keep-workflows, RESTART THE HUB (kills whatever listens on :7800 and
//   starts brain's hub detached, log in $TMPDIR/tab-hub-try.log), reload the tracker → "Do all 6 from v1.4.0".
// Needs: npm run demo, the hub (brain: npm start), npm start (this package), Chrome on :9222.
import CDP from "chrome-remote-interface";
import WebSocket from "ws";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ghost } from "../../protocol/types.ts";
const env = { cdpPort: Number(process.env.CDP_PORT ?? 9222), hubUrl: `ws://127.0.0.1:${process.env.HUB_PORT ?? 7800}` };
// Node cannot resolve *.localhost everywhere; talk to 127.0.0.1 with the right Host instead.
const localFetch = (url: string, init?: RequestInit) => { const u = new URL(url); const host = u.host; u.hostname = "127.0.0.1"; return fetch(u, { ...init, headers: { ...(init?.headers as object), host } }); };

const which = process.argv[2] ?? "all";
const shots = fileURLToPath(new URL("../../design/shots/", import.meta.url));
mkdirSync(shots, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond: boolean, what: string) => {
    console.log(`  ${cond ? "✓" : "✗"} ${what}`);
    if (!cond) failures++;
    return cond;
};

// ---------- hub, as the shell ----------
const ghosts: Ghost[] = [];
let hub!: WebSocket;
async function connectHub(): Promise<void> {
    hub = new WebSocket(env.hubUrl);
    await new Promise<void>((res, rej) => (hub.once("open", () => res()), hub.once("error", rej)));
    hub.send(JSON.stringify({ type: "hello", role: "tool" }));
    hub.on("message", (d) => {
        const m = JSON.parse(String(d));
        if (m.to === "shell" && m.msg.type === "ghost") ghosts.push(m.msg.ghost);
        if (m.to === "shell" && m.msg.type === "ghost_hide") ghosts.push({ id: "", kind: "done", label: "(hidden)" });
        // We play A: answer its switch_app execs (flow 2: Terminal → Chrome).
        if (m.to === "shell" && m.msg.type === "exec") hub.send(JSON.stringify({ as: "shell", type: "exec_result", ghostId: m.msg.ghostId, ok: true }));
    });
}
await connectHub();
const asShell = (m: object) => hub.send(JSON.stringify({ as: "shell", ...m }));
const frontmost = () => asShell({ type: "frontmost", app: "com.google.Chrome", window: "Chrome" });

async function waitGhost(pred: (g: Ghost) => boolean, ms = 4000): Promise<Ghost | null> {
    const t0 = Date.now();
    const from = ghosts.length;
    for (;;) {
        // The newest visible ghost counts, including one already showing.
        const live = [...ghosts].reverse().find((g) => g.id);
        const lastIsHide = ghosts.length && !ghosts[ghosts.length - 1].id;
        if (live && !lastIsHide && pred(live)) return live;
        for (const g of ghosts.slice(from)) if (g.id && pred(g)) return g;
        if (Date.now() - t0 > ms) return null;
        await sleep(50);
    }
}
async function accept(pred: (g: Ghost) => boolean, what: string, ms?: number): Promise<Ghost | null> {
    const t0 = Date.now();
    const g = await waitGhost(pred, ms);
    if (!ok(!!g, `ghost: ${what}${g ? ` (${Date.now() - t0} ms)` : ` — last: ${ghosts.filter((x) => x.id).at(-1)?.label ?? "none"}`}`)) return null;
    asShell({ type: "accept", ghostId: g!.id });
    return g;
}

// ---------- Chrome, as the user ----------
async function tabFor(url: string): Promise<CDP.Client> {
    const host = new URL(url).host;
    let t = (await CDP.List({ port: env.cdpPort })).find((x) => x.type === "page" && x.url.includes(host));
    if (!t) t = await CDP.New({ port: env.cdpPort, url });
    const c = await CDP({ port: env.cdpPort, target: t.id });
    await c.Page.enable();
    await c.Page.bringToFront();
    await c.Emulation.setDeviceMetricsOverride({ width: 960, height: 1000, deviceScaleFactor: 1, mobile: false });
    const loaded = c.Page.loadEventFired();
    await c.Page.navigate({ url });
    await loaded;
    await sleep(800);
    return c;
}
async function evalIn(c: CDP.Client, expr: string): Promise<any> {
    const { result, exceptionDetails } = await c.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
}
async function click(c: CDP.Client, css: string) {
    const p = await evalIn(c, `(() => { const el = document.querySelector(${JSON.stringify(css)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const)
        await c.Input.dispatchMouseEvent({ type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
    await sleep(250);
}
async function typeInto(c: CDP.Client, css: string, text: string) {
    await click(c, css);
    await c.Input.insertText({ text });
    await evalIn(c, "document.activeElement.blur()");
    await sleep(250);
}
async function choose(c: CDP.Client, css: string, label: string) {
    await evalIn(c, `(() => { const s = document.querySelector(${JSON.stringify(css)}); s.focus(); s.value = [...s.options].find(o => o.label.trim() === ${JSON.stringify(label)}).value; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); s.blur(); })()`);
    await sleep(250);
}
async function shot(c: CDP.Client, name: string) {
    const { data } = await c.Page.captureScreenshot({ format: "png" });
    writeFileSync(shots + `try-${name}.png`, Buffer.from(data, "base64"));
}
async function until(c: CDP.Client, expr: string, ms = 8000): Promise<boolean> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        if (await evalIn(c, expr).catch(() => false)) return true;
        await sleep(100);
    }
    return false;
}

// ---------- flows ----------
async function flow1() {
    console.log("Flow 1: tickets, then resale");
    const c = await tabFor("http://tickets.localhost:4001/e/night-owls");
    frontmost();
    await choose(c, "#qty", "2");
    if (await accept((g) => g.label.startsWith("Click Checkout"), "Click Checkout ⇥", 6000)) ok(await until(c, `location.pathname === "/checkout"`), "checkout page opened");
    else await click(c, "#checkout");
    await until(c, `location.pathname === "/checkout"`);
    await sleep(600);
    if (!(await accept((g) => g.label.startsWith("Click Buy tickets"), "Click Buy tickets ⇥", 6000))) await click(c, "#buy");
    const pay = await accept((g) => g.kind === "pay", "Pay $0.30 · tickets.localhost ⇥");
    if (pay) ok(pay.label === "Pay $0.30 · tickets.localhost ⇥", `pay label exact: "${pay.label}"`);
    const after = await waitGhost((g) => g.kind === "done" || g.kind === "blocked", 20000);
    ok(after?.kind === "done", `after paying: ${after?.label ?? "nothing"}`);
    if (after?.kind === "done") ok(await until(c, `document.querySelectorAll(".ticket").length === 2`), "two ticket cards rendered");
    await shot(c, "flow1-tickets");
    await c.close();

    const r = await tabFor("http://resale.localhost:4002/checkout?qty=2");
    frontmost();
    await sleep(400);
    await click(r, "#buy");
    const b = await waitGhost((g) => g.kind === "blocked", 6000);
    ok(b?.label === "Blocked · page says $0.30, payment asks $0.51", `resale: ${b?.label ?? "no blocked ghost"}`);
    if (b) {
        asShell({ type: "accept", ghostId: b.id });
        await sleep(500);
        ok(await evalIn(r, `document.querySelectorAll(".ticket").length === 0`), "Tab on blocked does nothing");
        asShell({ type: "dismiss", ghostId: b.id });
        ok(await until(r, `/Payment required/.test(document.getElementById("status").textContent)`), "Esc lets the 402 through to the page");
    }
    await shot(r, "flow1-resale");
    await r.close();
}

async function flow3() {
    console.log("Flow 3: release notes → tracker, teach once then repeat");
    await localFetch("http://tracker.localhost:4003/api/reset", { method: "POST" });
    const rel = await tabFor(process.env.RELEASE_URL ?? "https://github.com/alaramartin/tab-demo/releases/tag/v1.4.0");
    await sleep(1500);
    await rel.close();
    const c = await tabFor("http://tracker.localhost:4003/");
    frontmost();
    if (!process.env.TRY_ALLOW_RECALL) ok(!(await waitGhost((g) => g.label.startsWith("Do all"), 2500)), "no recall ghost before ticket 1 is taught");
    await typeInto(c, "#search", "ENG-142");
    await click(c, "#list li:nth-child(1) button");
    await choose(c, "#p-status", "Done");
    await typeInto(c, "#p-pr", "#12");
    await click(c, "#save");
    const done = (id: string, pr: string) => until(c, `fetch("/api/tickets").then(r => r.json()).then(ts => ts.find(t => t.id === "${id}")?.status === "Done" && ts.find(t => t.id === "${id}")?.pr === "${pr}")`, 10000);
    if (await accept((g) => g.label.startsWith("Repeat for ENG-150"), "Repeat for ENG-150 · #13 ⇥")) ok(await done("ENG-150", "#13"), "ENG-150 Done #13");
    if (await accept((g) => g.label.startsWith("Repeat for ENG-151"), "Repeat for ENG-151 · #14 ⇥", 6000)) ok(await done("ENG-151", "#14"), "ENG-151 Done #14");
    if (await accept((g) => g.label.startsWith("Do the remaining"), "Do the remaining 3 ⇥", 6000)) {
        ok(await done("ENG-160", "#17"), "ENG-160 Done #17");
        ok(await until(c, `fetch("/api/tickets").then(r => r.json()).then(ts => ts.every(t => t.status === "Done"))`), "all six Done");
    }
    await evalIn(c, `(() => { const s = document.getElementById("search"); s.value = ""; s.dispatchEvent(new Event("input")); })()`);
    await sleep(300);
    await shot(c, "flow3-tracker");
    await c.close();
}

async function restartHub(): Promise<void> {
    const pids = spawnSync("lsof", ["-t", `-iTCP:${new URL(env.hubUrl).port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    hub.close();
    for (const p of pids) process.kill(Number(p), "SIGTERM");
    await sleep(800);
    const log = openSync(join(tmpdir(), "tab-hub-try.log"), "a");
    spawn("npx", ["tsx", "src/hub.ts"], { cwd: fileURLToPath(new URL("../../brain/", import.meta.url)), detached: true, stdio: ["ignore", log, log] }).unref();
    for (let i = 0; i < 50; i++) {
        await sleep(200);
        try {
            await connectHub();
            return;
        } catch {}
    }
    throw new Error("hub did not come back");
}

async function flow3Recall() {
    console.log("Flow 3 recall: teach, reset keeping workflows, restart the hub, reload → Do all 6");
    await flow3();
    const r = spawnSync("npx", ["tsx", "scripts/reset-demo.ts", "--keep-workflows"], { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8" });
    ok(/saved workflows kept/.test(r.stdout), `reset-demo --keep-workflows: ${r.stdout.split("\n")[0]}`);
    const rel = await tabFor(process.env.RELEASE_URL ?? "https://github.com/alaramartin/tab-demo/releases/tag/v1.4.0"); // stays open: the source list
    await restartHub();
    ok(true, "hub restarted (workflow must come from disk)");
    await sleep(2500); // web reconnects and re-sends every tab's state
    const c = await tabFor("http://tracker.localhost:4003/");
    frontmost();
    ok(await until(c, `fetch("/api/tickets").then(r => r.json()).then(ts => ts.every(t => t.status === "In review"))`), "tracker reset to In review");
    const g = await accept((g) => g.label.startsWith("Do all 6 from"), "Do all 6 from v1.4.0 · learned …", 8000);
    if (g) {
        ok(/^Do all 6 from v1\.4\.0 · learned \d{1,2}:\d{2} (am|pm) ⇥$/.test(g.label), `label: "${g.label}"`);
        ok(await until(c, `fetch("/api/tickets").then(r => r.json()).then(ts => ts.every(t => t.status === "Done") && ts.map(t => t.pr).join() === "#12,#13,#14,#15,#16,#17")`, 40000), "all six Done with #12–#17");
    }
    await shot(c, "flow3-recall");
    await c.close();
    await rel.close();
}

async function flow2() {
    console.log("Flow 2: git push → pull request");
    const repo = process.env.GITHUB_DEMO_REPO ?? "alaramartin/tab-demo";
    const clone = (process.env.GITHUB_DEMO_CLONE || "~/Projects/tab-demo").replace(/^~/, homedir());
    const push = spawnSync("git", ["push", "-u", "origin", "fix/checkout-rounding"], { cwd: clone, encoding: "utf8" });
    const out = `$ git push -u origin fix/checkout-rounding\n${push.stderr}${push.stdout}`.trim();
    if (!ok(/pull\/new\//.test(out), "git push printed the pull request link")) return;
    // Play A's Terminal reader: frontmost Terminal + its text.
    asShell({ type: "frontmost", app: "com.apple.Terminal", window: "zsh" });
    asShell({ type: "state", source: "native", app: "com.apple.Terminal", window: "zsh", focused: true, seq: Date.now(), ts: Date.now(),
        elements: [{ id: "term", role: "textarea", label: "Terminal", rect: { x: 760, y: 100, w: 660, h: 700 }, enabled: true, value: out.split("\n").slice(-40).join("\n") }] });
    if (!(await accept((g) => g.label.startsWith("Open pull request"), "Open pull request ⇥", 8000))) return;
    await sleep(1500);
    frontmost();
    // Find the tab C navigated (pull/new redirects to compare), bring it up, and clear any GitHub draft of the description.
    let c: CDP.Client | null = null;
    for (let i = 0; i < 40 && !c; i++) {
        const t = (await CDP.List({ port: env.cdpPort })).find((x) => x.type === "page" && /\/(compare|pull\/new)\//.test(x.url) && x.url.includes(repo));
        if (t) c = await CDP({ port: env.cdpPort, target: t.id });
        else await sleep(250);
    }
    if (!ok(!!c, "Chrome opened the pull request page")) return;
    try {
        await flow2OnPage(c!, repo);
    } finally {
        await c!.close();
    }
}

async function flow2OnPage(c: CDP.Client, repo: string) {
    await c.Page.enable();
    await c.Page.bringToFront();
    await until(c, `!!document.getElementById("pull_request_body")`, 15000);
    await evalIn(c, `(() => { const ta = document.getElementById("pull_request_body"); if (!ta.value) return; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ""); ta.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    frontmost();
    if (!(await accept((g) => g.kind === "text" && /Round checkout totals/.test(g.ghostText ?? ""), "Write description (ghost text)", 10000))) return;
    ok(await until(c, `/Round checkout totals/.test(document.getElementById("pull_request_body").value)`, 8000), "description landed");
    if (!(await accept((g) => g.label.startsWith("Click Create pull request"), "Click Create pull request ⇥", 10000))) return;
    let pr = "";
    for (let i = 0; i < 30 && !pr; i++) {
        await sleep(1000);
        pr = spawnSync("gh", ["pr", "list", "--repo", repo, "--head", "fix/checkout-rounding", "--state", "open", "--json", "url", "--jq", ".[0].url"], { encoding: "utf8" }).stdout.trim();
    }
    ok(!!pr, `pull request opened: ${pr || "none"}`);
    await shot(c, "flow2-pr");
}

async function flow4() {
    console.log("Flow 4: inbox → pharmacy, one button");
    const inbox = await tabFor("http://inbox.localhost:4004/");
    await inbox.close();
    const c = await tabFor("http://pharmacy.localhost:4005/refill");
    frontmost();
    // Like flow 1: a step whose ghost doesn't come (no model, or a slow one) is done by hand, so the payment still gets checked.
    const steps: [string, string, string, () => Promise<unknown>][] = [
        ["4471-209", "Rx 4471-209", `document.getElementById("rx").value === "4471-209"`, () => typeInto(c, "#rx", "4471-209")],
        ["Oak St", "Select Oak St", `document.getElementById("loc").value === "Oak St"`, () => choose(c, "#loc", "Oak St")],
        ["5:30", "Click 5:30 pm", `document.querySelectorAll(".chips button")[1].getAttribute("aria-pressed") === "true"`, () => click(c, ".chips li:nth-of-type(2) button")],
        ["Text me", "Check \"Text me when ready\"", `document.getElementById("sms").checked`, () => click(c, "#sms")],
        ["Request refill", "Click Request refill", `false`, () => click(c, "#submit")],
    ];
    for (const [needle, what, check, byHand] of steps) {
        const g = await accept((g) => (g.label + " " + (g.ghostText ?? "")).includes(needle), what, 6000);
        if (!g) await byHand();
        if (check !== "false") ok(await until(c, check, 4000), `${what} ${g ? "landed" : "(by hand)"}`);
        await sleep(300);
    }
    const pay = await accept((g) => g.kind === "pay", "Pay $0.05 · pharmacy.localhost ⇥");
    if (pay) ok(pay.label === "Pay $0.05 · pharmacy.localhost ⇥", `pay label exact: "${pay.label}"`);
    const after = await waitGhost((g) => g.kind === "done" || g.kind === "blocked", 20000);
    ok(after?.kind === "done", `after paying: ${after?.label ?? "nothing"}`);
    if (after?.kind === "done") ok(await until(c, `/Refill requested/.test(document.getElementById("done").textContent)`), "Refill requested ✓ shown");
    await shot(c, "flow4-pharmacy");
    await c.close();
}

try {
    if (which === "flow1" || which === "all") await flow1();
    if (which === "flow2") await flow2();
    if (which === "flow3" || which === "all") await flow3();
    if (which === "flow4" || which === "all") await flow4();
    if (which === "flow3-recall") await flow3Recall();
} finally {
    hub.close();
}
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
