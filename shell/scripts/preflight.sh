#!/bin/bash
# Demo-day preflight: one command that checks, read-only, that everything Tab's demo needs is up and set right.
#   shell/scripts/preflight.sh [--offline]
# One line per check: ✓ fine, ! worth a look, ✗ breaks the demo. Anything not ✓ ends with "→ <fix>".
# Exits 1 if any ✗. Takes a few seconds.
#
# It only reads: no kills, installs, sudo, `defaults write` or System Settings changes, and no network except
# 127.0.0.1 (hub, demo sites, the debug Chrome's DevTools port) and one read-only balance lookup for the payer
# (`cd web && npm run balance`, on the rail PAY_RAIL picks; --offline skips it). It does run `TabShell --dump` (prints
# one Terminal snapshot and exits) and evaluates read-only expressions (zoom, GitHub theme/login) in the debug Chrome's
# tabs.
set -uo pipefail
OFFLINE=0
for a in "$@"; do
    case "$a" in
        --offline) OFFLINE=1 ;;
        *) echo "unknown flag $a (only --offline)" >&2; exit 2 ;;
    esac
done
cd "$(dirname "$0")/../.."
REPO="$(pwd)"
APP="$REPO/shell/build/TabShell.app"
BIN="$APP/Contents/MacOS/TabShell"
HUB_PORT=7800
CDP_PORT=9222
DEMO_BRANCH="fix/checkout-rounding"
CHROME_CMD='open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/tab-chrome'
AX_FIX="grant Accessibility to TabShell (System Settings → Privacy & Security → Accessibility)"

# ---- output ----
if [ -t 1 ]; then
    G="$(tput setaf 2 2>/dev/null)" || G=$'\033[32m'
    Y="$(tput setaf 3 2>/dev/null)" || Y=$'\033[33m'
    R="$(tput setaf 1 2>/dev/null)" || R=$'\033[31m'
    B="$(tput bold 2>/dev/null)" || B=$'\033[1m'
    D="$(tput dim 2>/dev/null)" || D=$'\033[2m'
    N="$(tput sgr0 2>/dev/null)" || N=$'\033[0m'
else
    G="" Y="" R="" B="" D="" N=""
fi
NOK=0 NWARN=0 NFAIL=0
ok() { NOK=$((NOK + 1)); printf '%s✓%s %s\n' "$G" "$N" "$1"; }
warn() { NWARN=$((NWARN + 1)); printf '%s!%s %s%s\n' "$Y" "$N" "$1" "${2:+  ${D}→ $2${N}}"; }
fail() { NFAIL=$((NFAIL + 1)); printf '%s✗%s %s%s\n' "$R" "$N" "$1" "${2:+  ${D}→ $2${N}}"; }
section() { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
# Report "ok|warn|fail <TAB> message <TAB> fix" lines printed by the node helpers below.
emit() {
    local lvl msg fix
    while IFS=$'\t' read -r lvl msg fix; do
        case "$lvl" in
            ok) ok "$msg" ;;
            warn) warn "$msg" "$fix" ;;
            fail) fail "$msg" "$fix" ;;
        esac
    done
}

# ---- helpers ----
have() { command -v "$1" >/dev/null 2>&1; }
# Run with a time limit, so nothing here can hang the preflight (perl's alarm survives exec).
tmo() {
    local s="$1"
    shift
    if [ -x /usr/bin/perl ]; then /usr/bin/perl -e 'alarm shift @ARGV; exec { $ARGV[0] } @ARGV or exit 127' "$s" "$@"; else "$@"; fi
}
# Like tmo, but for commands that spawn children (npm → sh → node): on timeout it kills the whole process group, since a
# child left alive keeps the output pipe open and $(…) would wait for it. Exit 142 on timeout.
tmo_group() {
    /usr/bin/perl -e '
        my $s = shift @ARGV;
        my $pid = fork // exit 127;
        if (!$pid) { setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127; }
        $SIG{ALRM} = sub { kill "TERM", -$pid; sleep 1; kill "KILL", -$pid; exit 142; };
        alarm $s;
        waitpid($pid, 0);
        exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
    ' "$@"
}
rel() { case "$1" in "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
hms() { date -r "$1" +%H:%M:%S; }
listen_pid() { tmo 3 lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
cwd_of() { tmo 3 lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1; }
# Established TCP connections of a comma-separated pid list.
conns_of() { tmo 3 lsof -nP -a -p "$1" -iTCP -sTCP:ESTABLISHED 2>/dev/null; }
talks_to() { grep -Eq -- "->(127\.0\.0\.1|\[::1\]):$1 "; } # stdin: conns_of output
# Process start time, epoch seconds.
proc_start() {
    local s
    s="$(LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/[[:space:]]*$//')"
    [ -n "$s" ] && LC_ALL=C date -j -f "%a %b %d %T %Y" "$s" +%s 2>/dev/null
}
# True if pid $1 started before epoch second $2 (false when its start time can't be read).
started_before() { local t; t="$(proc_start "$1")"; [ -n "$t" ] && [ "$t" -lt "$2" ]; }
sod() { # HH:MM:SS → seconds of the day
    local h m s
    IFS=: read -r h m s <<<"$1"
    echo $((10#$h * 3600 + 10#$m * 60 + 10#$s))
}
# Value of KEY in a .env file (quotes and inline comment stripped). Never printed by this script.
env_get() {
    local line val
    [ -f "$1" ] || return 0
    line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1" | tail -1)"
    [ -n "$line" ] || return 0
    val="${line#*=}"
    val="${val%%[[:space:]]#*}"
    val="$(printf '%s' "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    val="${val#[\"\']}"
    val="${val%[\"\']}"
    printf '%s' "$val"
}

# ---- node helpers (no npm deps; Node 22+ for the global WebSocket) ----
IFS= read -r -d "" DISPLAYS_JS <<'JS'
import { readFileSync } from "node:fs";
const say = (lvl, msg, fix = "") => console.log(`${lvl}\t${msg}\t${fix}`);
let j;
try { j = JSON.parse(readFileSync(0, "utf8")); } catch { say("warn", "couldn't read the display list (system_profiler)", "check System Settings → Displays by eye"); process.exit(0); }
const ds = [];
for (const gpu of j.SPDisplaysDataType ?? [])
    for (const d of gpu.spdisplays_ndrvs ?? []) {
        if ((d.spdisplays_online ?? "spdisplays_yes") !== "spdisplays_yes") continue;
        const px = /(\d+)\s*x\s*(\d+)/.exec(d._spdisplays_pixels ?? "");
        const ui = /(\d+)\s*x\s*(\d+)(?:\s*@\s*([\d.]+)\s*Hz)?/.exec(d._spdisplays_resolution ?? d.spdisplays_resolution ?? "");
        const w = ui ? +ui[1] : 0, h = ui ? +ui[2] : 0;
        // Backing scale: 2 when the panel has more pixels than the UI "looks like" (any HiDPI mode), else 1.
        const scale = px && w ? (+px[1] / w > 1.1 ? 2 : 1) : /retina/i.test(d.spdisplays_pixelresolution ?? "") ? 2 : 1;
        ds.push({ name: d._name ?? "display", w, h, hz: ui?.[3] ? Math.round(+ui[3]) : 0, scale,
                  main: d.spdisplays_main === "spdisplays_yes", mirror: (d.spdisplays_mirror ?? "spdisplays_off") !== "spdisplays_off" });
    }
if (!ds.length) { say("warn", "system_profiler lists no display", "check System Settings → Displays by eye"); process.exit(0); }
const main = ds.find((d) => d.main) ?? ds[0];
const fmt = (d) => `${d.name}, looks like ${d.w} × ${d.h}${d.hz ? ` @ ${d.hz} Hz` : ""} (${d.scale}×)`;
const screens = ds.filter((d) => !d.mirror).length + (ds.some((d) => d.mirror) ? 1 : 0);
say("ok", `main display: ${fmt(main)}${ds.length > 1 && screens === 1 ? `, mirrored to ${ds.length - 1} more` : ""}`);
if (screens > 1)
    say("warn", `${screens} displays (also ${ds.filter((d) => d !== main && !d.mirror).map(fmt).join("; ")}): ghosts follow the display under the target; PLAN wants one display`,
        "mirror the projector (System Settings → Displays → Use as → Mirror) or unplug the extra screen");
console.log(`DISPLAYS\t${JSON.stringify(ds.map(({ name, w, h, scale }) => ({ name, w, h, scale })))}`);
JS

IFS= read -r -d "" CDP_JS <<'JS'
const port = process.env.CDP_PORT || "9222";
let displays = [];
try { displays = JSON.parse(process.env.TAB_DISPLAYS || "[]"); } catch {}
const say = (lvl, msg, fix = "") => console.log(`${lvl}\t${msg}\t${fix}`);
setTimeout(() => { say("warn", "Chrome tab checks took over 6 s and were stopped", "is the debug Chrome hung? Check it by eye"); process.exit(0); }, 6000).unref();
if (typeof WebSocket !== "function") {
    say("warn", `Node ${process.version} has no built-in WebSocket: zoom and GitHub checks skipped`, "use Node 22 or newer");
    process.exit(0);
}
let list;
try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
} catch (e) {
    say("warn", `couldn't list the debug Chrome's tabs (${e.message})`, "restart the debug Chrome");
    process.exit(0);
}
const SITES = { "tickets.localhost:4001": "tickets", "resale.localhost:4002": "resale", "tracker.localhost:4003": "tracker",
                "inbox.localhost:4004": "inbox", "pharmacy.localhost:4005": "pharmacy" };
const pages = list.filter((t) => t.type === "page");
const tabs = [];
for (const t of pages) {
    let u;
    try { u = new URL(t.url); } catch { continue; }
    if (SITES[u.host]) tabs.push({ t, u, gh: false, name: SITES[u.host] });
    else if (u.hostname === "github.com") tabs.push({ t, u, gh: true, name: `github.com${u.pathname.length > 40 ? u.pathname.slice(0, 39) + "…" : u.pathname}` });
}
const open = [...new Set(tabs.filter((x) => !x.gh).map((x) => x.name))];
const missing = Object.values(SITES).filter((s) => !open.includes(s));
const nGh = tabs.filter((x) => x.gh).length;
if (!tabs.length)
    say("warn", `no demo or GitHub tab is open in the debug Chrome (${pages.length} other tab${pages.length === 1 ? "" : "s"})`,
        "open tickets.localhost:4001/e/night-owls, tracker.localhost:4003 and the tab-demo release page there");
else
    say("ok", `tabs open: ${[...open, ...(nGh ? [`github.com${nGh > 1 ? ` ×${nGh}` : ""}`] : [])].join(", ")}${missing.length ? ` (not open: ${missing.join(", ")})` : ""}`);

// Read-only: no Runtime.enable, no side effects on the page.
const EXPR = `(() => {
    const h = document.documentElement, m = document.querySelector('meta[name="user-login"]');
    return { dpr: devicePixelRatio, ow: outerWidth, iw: innerWidth, oh: outerHeight, sx: screenX, sy: screenY,
             sw: screen.width, sh: screen.height, pinch: window.visualViewport ? visualViewport.scale : 1,
             mode: h.getAttribute("data-color-mode"), lightTheme: h.getAttribute("data-light-theme"),
             darkTheme: h.getAttribute("data-dark-theme"), prefersDark: matchMedia("(prefers-color-scheme: dark)").matches,
             login: m ? m.content : null };
})()`;
const probe = (t) => new Promise((resolve) => {
    let ws;
    const done = (v) => { clearTimeout(timer); try { ws?.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => done({ error: "timed out" }), 2500);
    try { ws = new WebSocket(t.webSocketDebuggerUrl || `ws://127.0.0.1:${port}/devtools/page/${t.id}`); } catch (e) { return done({ error: e.message }); }
    ws.onerror = () => done({ error: "DevTools connection failed" });
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: EXPR, returnByValue: true } }));
    ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.id !== 1) return;
        const v = m.result?.result?.value;
        done(v ? { v } : { error: m.error?.message || m.result?.exceptionDetails?.text || "no result" });
    };
});
const results = await Promise.all(tabs.map(async (x) => ({ ...x, r: await probe(x.t) })));

// Zoom: devicePixelRatio = display backing scale × Chrome zoom. Ghost rects assume 100% (web/src/inject.js).
const scaleFor = (v) => displays.find((d) => d.w === v.sw && d.h === v.sh)?.scale ?? (displays.length === 1 ? displays[0].scale : null);
let zoomOk = 0, zoomBad = 0;
const panelSeen = new Set();
for (const x of results) {
    if (x.r.error) { say("warn", `${x.name}: couldn't read the tab (${x.r.error})`, "reload that tab"); continue; }
    const v = x.r.v, s = scaleFor(v);
    const zoom = s ? v.dpr / s : Number.isInteger(v.dpr) ? 1 : null;
    if (zoom === null || Math.abs(zoom - 1) > 0.01) {
        zoomBad++;
        say("fail", `${x.name}: zoom is ${zoom ? `${Math.round(zoom * 100)}%` : `not 100% (devicePixelRatio ${v.dpr})`}, so ghosts land off target`,
            "set zoom to 100% (⌘0 in that tab; Chrome remembers zoom per site)");
    } else zoomOk++;
    if (Math.abs((v.pinch || 1) - 1) > 0.01) say("fail", `${x.name}: pinch-zoomed to ${Math.round(v.pinch * 100)}%`, "pinch back out on the trackpad");
    const win = `${v.sx},${v.sy},${v.ow},${v.oh}`;
    if (zoom === 1 && v.ow - v.iw > 24 && !panelSeen.has(win)) {
        panelSeen.add(win);
        say("warn", `${x.name}: the page is ${v.ow - v.iw} pt narrower than its window (side panel or docked DevTools); on the left it shifts every ghost`,
            "close the side panel / DevTools in that window");
    }
}
if (zoomOk && !zoomBad) say("ok", `zoom 100% in ${zoomOk === 1 ? "the demo/GitHub tab" : zoomOk === 2 ? "both demo/GitHub tabs" : `all ${zoomOk} demo/GitHub tabs`}`);

// GitHub: logged in, and light (the ghost text's white field cover shows as a white box on GitHub dark).
const gh = results.filter((x) => x.gh);
if (!gh.length) say("warn", "no github.com tab open: GitHub login and appearance not checked", "open the tab-demo release page in the debug Chrome");
else {
    let loginPage = false, loggedOut = false, user = "", dark = "", read = 0;
    for (const x of gh) {
        if (/^\/(login|session)/.test(x.u.pathname)) loginPage = true;
        if (x.r.error) continue;
        read++;
        const v = x.r.v;
        if (v.login === "") loggedOut = true;
        else if (v.login) user = v.login;
        if (v.mode) {
            const which = v.mode === "auto" ? (v.prefersDark ? "dark" : "light") : v.mode;
            const theme = (which === "dark" ? v.darkTheme : v.lightTheme) || which;
            if (!/^light/.test(theme)) dark = `theme ${theme}${v.mode === "auto" ? ", following macOS" : ""}`;
        }
    }
    if (loginPage || loggedOut) say("warn", "the debug Chrome isn't logged into GitHub (flow 2 opens a PR)", "log into GitHub in the debug Chrome");
    else if (user) say("ok", `GitHub: logged in as ${user}`);
    if (dark)
        say("warn", `GitHub renders dark (${dark}): Tab's ghost text brings a white field cover; on GitHub dark it shows as a white box`,
            "set GitHub → Settings → Appearance → Light for the demo");
    else if (read) say("ok", "GitHub renders light");
}
JS

HOST="$(scutil --get ComputerName 2>/dev/null || hostname)"
HEAD_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
printf '%sTab preflight%s · %s · %s · repo at %s\n' "$B" "$N" "$HOST" "$(date '+%a %H:%M')" "$HEAD_SHORT"

# =====================================================================================================
section "TabShell"
SRC=(shell/Sources shell/Package.swift) # what goes into the binary
TS_PID="" TS_START="" DUMP_BIN="$BIN"
if [ ! -x "$BIN" ]; then
    fail "TabShell.app isn't built" "shell/scripts/build-shell.sh --run"
else
    built_raw="$(/usr/libexec/PlistBuddy -c 'Print :TabGitCommit' "$APP/Contents/Info.plist" 2>/dev/null)"
    built="${built_raw%-dirty}"
    if [ -z "$built_raw" ]; then
        fail "TabShell.app doesn't record its commit (built before preflight existed)" "rebuild: shell/scripts/build-shell.sh --run"
    elif ! git cat-file -e "$built^{commit}" 2>/dev/null; then
        fail "TabShell.app was built from $built_raw, which this clone doesn't have" "rebuild: shell/scripts/build-shell.sh --run"
    else
        changed="$(git diff --name-only "$built" HEAD -- "${SRC[@]}" 2>/dev/null | wc -l | tr -d ' ')"
        newer="$(find "${SRC[@]}" -type f -newer "$BIN" 2>/dev/null | head -1)"
        dirty="$(git status --porcelain -- "${SRC[@]}" 2>/dev/null)"
        if [ "$changed" != 0 ]; then
            fail "TabShell.app is from $built_raw; HEAD $HEAD_SHORT changed $changed shell source file(s) since" "rebuild: shell/scripts/build-shell.sh --run"
        elif { [ -n "$dirty" ] || [ "$built" != "$built_raw" ]; } && [ -n "$newer" ]; then
            fail "TabShell.app is older than uncommitted shell edits (${newer#shell/})" "rebuild: shell/scripts/build-shell.sh --run"
        elif [ "$(git rev-parse "$built")" = "$(git rev-parse HEAD)" ]; then
            ok "TabShell.app built from $built_raw (HEAD)"
        else
            ok "TabShell.app built from $built_raw; HEAD $HEAD_SHORT has no shell source changes since"
        fi
    fi
    auth="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
    if ! codesign --verify --strict "$APP" >/dev/null 2>&1; then
        fail "TabShell.app's signature doesn't verify (changed after signing?)" "rebuild: shell/scripts/build-shell.sh --run"
    elif [ -z "$auth" ]; then
        fail "TabShell.app is ad-hoc signed: macOS drops its Accessibility grant on every build" "rebuild: shell/scripts/build-shell.sh --run"
    else
        ok "signed by \"$auth\", so the Accessibility grant survives rebuilds"
    fi
fi

pids="$(pgrep -x TabShell | tr '\n' ' ' | sed 's/ *$//')"
if [ -z "$pids" ]; then
    fail "TabShell isn't running" "shell/scripts/build-shell.sh --run"
else
    TS_PID="$(pgrep -n -x TabShell)"
    [ "$pids" != "$TS_PID" ] && fail "$(wc -w <<<"$pids" | tr -d ' ') TabShells are running (pids $pids): two overlays and two key taps" "shell/scripts/build-shell.sh --run (it quits the others first)"
    exe="$(ps -ww -o comm= -p "$TS_PID" 2>/dev/null)"
    TS_START="$(proc_start "$TS_PID")"
    [ -x "$exe" ] && DUMP_BIN="$exe"
    if [ "$exe" != "$BIN" ]; then
        warn "TabShell runs from $(rel "$exe"), not this repo's build" "shell/scripts/build-shell.sh --run"
    elif [ -n "$TS_START" ] && [ "$(stat -f %m "$BIN")" -gt "$TS_START" ]; then
        fail "TabShell started $(hms "$TS_START") but the app was rebuilt $(hms "$(stat -f %m "$BIN")"): it still runs the old binary" "shell/scripts/build-shell.sh --run"
    else
        ok "TabShell running (pid $TS_PID${TS_START:+, since $(hms "$TS_START")}), on the current build"
    fi
    if conns_of "$TS_PID" | talks_to "$HUB_PORT"; then
        ok "TabShell is connected to the hub"
    else
        fail "TabShell isn't connected to the hub on :$HUB_PORT" "start the hub (cd brain && npm start); TabShell reconnects within 2 s"
    fi
fi

# Accessibility. Best evidence: the running app's own log says whether its key tap started (build-shell.sh --run
# logs to ~/.tab/shell.log). Otherwise TabShell --dump's axTrusted, run from the same bundle so TCC applies.
dump=""
[ -x "$DUMP_BIN" ] && dump="$(tmo 5 "$DUMP_BIN" --dump 2>/dev/null)"
dump_field() { sed -nE -e 's/,$//' -e "s/^  \"$1\" *: *\"?([^\"]*)\"?$/\1/p" <<<"$dump" | head -1; }
dump_ax="$(dump_field axTrusted)"
tap=""
LOG="$HOME/.tab/shell.log"
if [ -n "$TS_START" ] && [ -f "$LOG" ] && [ "$(stat -f %m "$LOG")" -ge "$TS_START" ]; then
    L="$(grep -n 'TabShell running' "$LOG" | tail -1 | cut -d: -f1)"
    lts="$([ -n "$L" ] && sed -n "${L}p" "$LOG" | cut -c1-8)"
    if [[ $lts =~ ^[0-9][0-9]:[0-9][0-9]:[0-9][0-9]$ ]]; then
        delta=$(($(sod "$lts") - $(sod "$(hms "$TS_START")")))
        delta=${delta#-}
        if [ "$delta" -le 3 ] || [ "$delta" -ge 86397 ]; then # this log block belongs to the running process
            from=$((L > 3 ? L - 3 : 1))
            if sed -n "${from},\$p" "$LOG" | grep -q 'tap: running'; then
                tap=running
            elif sed -n "${from},${L}p" "$LOG" | grep -q 'ax: not trusted'; then tap=untrusted; fi
        fi
    fi
fi
ax_bad=0
if [ "$tap" = running ]; then
    ok "Accessibility granted: TabShell's key tap is running"
elif [ "$tap" = untrusted ]; then
    ax_bad=1
    fail "TabShell has no Accessibility: its key tap never started, so Tab and Esc do nothing (--dump axTrusted: ${dump_ax:-?})" "$AX_FIX"
elif [ "$dump_ax" = true ]; then
    ok "Accessibility granted (TabShell --dump: axTrusted true)"
elif [ "$dump_ax" = false ]; then
    ax_bad=1
    fail "TabShell has no Accessibility (TabShell --dump: axTrusted false)" "$AX_FIX"
elif [ -x "$DUMP_BIN" ]; then
    warn "couldn't tell whether TabShell has Accessibility (--dump gave no answer)" "$AX_FIX, if Tab does nothing"
fi

# Terminal reading (flow 2), from the same --dump.
if [ -n "$dump" ]; then
    err="$(dump_field error)"
    if [ "$(dump_field ok)" = true ]; then
        ok "TabShell reads $(dump_field app | sed 's/com.apple.Terminal/Terminal/; s/com.googlecode.iterm2/iTerm2/') text ($(dump_field path))"
    elif [[ $err == *"neither Terminal nor iTerm2"* ]]; then
        warn "Terminal isn't running (flow 2 types git push there)" "open Terminal and cd $(rel "$HOME/Projects/tab-demo")"
    elif [[ $err == *Accessibility* ]] && [ "$ax_bad" = 1 ]; then
        : # same cause as the Accessibility ✗ above
    else
        [ "${#err}" -gt 110 ] && err="${err:0:110}…"
        warn "TabShell can't read Terminal: ${err:-unknown error}" "bring a Terminal window to the front and rerun; Terminal is read through Accessibility (TAB_TERM_READER=1 for the old reader)"
    fi
fi

hidden="$(defaults read dev.tab.shell hudHidden 2>/dev/null)"
origin="$(defaults read dev.tab.shell hudOrigin 2>/dev/null | tr -d ' \n()')"
if [ "$hidden" = 1 ]; then
    warn "the HUD is hidden (its counters are revealed at the end)" "menu bar ⇥ → Show HUD"
elif [ -n "$origin" ]; then
    ok "HUD at a saved position (${origin/,/, }); menu bar ⇥ → Reset HUD Position puts it back top right"
else
    ok "HUD at its default spot, top right"
fi

# =====================================================================================================
section "Hub · web · demo sites"
hub_pid="$(listen_pid "$HUB_PORT")"
if [ -z "$hub_pid" ]; then
    fail "hub isn't listening on 127.0.0.1:$HUB_PORT" "cd brain && npm start"
else
    d="$(cwd_of "$hub_pid")"
    if [ "$d" = "$REPO/brain" ]; then
        ok "hub listening on 127.0.0.1:$HUB_PORT (pid $hub_pid)"
    else
        warn "the process on :$HUB_PORT (pid $hub_pid) runs from $(rel "${d:-?}"), not this repo's brain/" "stop it, then cd brain && npm start"
    fi
fi

web_pids=""
for p in $(pgrep -f "tsx.* src/main\.ts"); do
    [ "$(cwd_of "$p")" = "$REPO/web" ] && web_pids="$web_pids${web_pids:+,}$p"
done
if [ -z "$web_pids" ]; then
    fail "web (the Chrome ↔ hub bridge) isn't running from web/" "cd web && npm start"
else
    c="$(conns_of "$web_pids")"
    if ! talks_to "$HUB_PORT" <<<"$c"; then
        fail "web runs but isn't connected to the hub (it retries every second)" "start the hub: cd brain && npm start"
    elif ! talks_to "$CDP_PORT" <<<"$c"; then
        fail "web runs but isn't connected to the debug Chrome" "start the debug Chrome, then restart web (cd web && npm start)"
    else
        ok "web running, connected to the hub and to the debug Chrome"
    fi
fi

up="" down=""
for s in "tickets 4001 /e/night-owls" "resale 4002 /e/night-owls" "tracker 4003 /" "inbox 4004 /" "pharmacy 4005 /refill"; do
    read -r name port path <<<"$s"
    code="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 2 -H "Host: $name.localhost:$port" "http://127.0.0.1:$port$path" 2>/dev/null)"
    if [ "$code" = 200 ]; then up="$up${up:+, }$name"; else down="$down${down:+, }$name :$port (HTTP ${code:-000})"; fi
done
if [ -z "$up" ]; then
    fail "demo sites aren't running (none of :4001–4005 answer)" "cd web && npm run demo"
else
    [ -n "$down" ] && fail "demo sites not answering: $down" "restart them: cd web && npm run demo"
    ok "demo sites answer: $up"
    d="$(cwd_of "$(listen_pid 4001)")"
    [ -n "$d" ] && [ "$d" != "$REPO/web" ] && warn "the demo sites run from $(rel "$d"), not this repo's web/" "stop them, then cd web && npm run demo"
fi

# =====================================================================================================
# Displays first: the Chrome zoom check needs each display's backing scale.
DOUT="" TAB_DISPLAYS="[]"
if have node; then
    DOUT="$(tmo 5 system_profiler -json SPDisplaysDataType 2>/dev/null | tmo 5 node --input-type=module -e "$DISPLAYS_JS" 2>/dev/null)"
    TAB_DISPLAYS="$(grep '^DISPLAYS' <<<"$DOUT" | cut -f2-)"
fi

section "Chrome"
dbg="" normal="" dbg_port=""
for p in $(pgrep -f "Google Chrome\.app/Contents/MacOS/Google Chrome"); do
    cmd="$(ps -ww -o command= -p "$p" 2>/dev/null)"
    case "$cmd" in *"Google Chrome.app/Contents/MacOS/Google Chrome"*) ;; *) continue ;; esac
    case "$cmd" in *" --type="*) continue ;; esac # helpers
    if [[ $cmd == *--remote-debugging-port=* ]]; then
        dbg="$dbg${dbg:+ }$p"
        dbg_port="${cmd#*--remote-debugging-port=}"
        dbg_port="${dbg_port%% *}"
    else
        normal="$normal${normal:+ }$p"
    fi
done
if [ -n "$normal" ]; then
    fail "your normal Chrome is running too (pid $normal, no --remote-debugging-port)" "quit your normal Chrome: it shares the bundle id, and Tab may raise the wrong one"
fi
if [ -z "$dbg" ]; then
    fail "the debug Chrome isn't running" "$CHROME_CMD"
elif [ "$(wc -w <<<"$dbg" | tr -d ' ')" -gt 1 ]; then
    warn "$(wc -w <<<"$dbg" | tr -d ' ') debug Chromes are running (pids $dbg)" "keep one: the one on port $CDP_PORT with /tmp/tab-chrome"
fi
[ -n "$dbg_port" ] && [ "$dbg_port" != "$CDP_PORT" ] && warn "the debug Chrome listens on port $dbg_port, not $CDP_PORT" "$CHROME_CMD"
ver="$(curl -s --noproxy '*' --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null)"
if [[ $ver == *webSocketDebuggerUrl* ]]; then
    ok "debug Chrome answers on 127.0.0.1:$CDP_PORT ($(sed -n 's/.*"Browser": *"\([^"]*\)".*/\1/p' <<<"$ver"))"
    if have node; then
        cout="$(CDP_PORT="$CDP_PORT" TAB_DISPLAYS="${TAB_DISPLAYS:-[]}" tmo 8 node --input-type=module -e "$CDP_JS" 2>/dev/null)"
        rc=$?
        emit <<<"$cout"
        [ "$rc" != 0 ] && [ -z "$cout" ] && warn "Chrome tab checks failed (node exit $rc)" "check zoom (⌘0) and GitHub login/appearance by eye"
    else
        warn "node isn't on PATH: zoom and GitHub checks skipped" "install Node 22+ (the project needs it anyway)"
    fi
else
    fail "nothing answers on 127.0.0.1:$CDP_PORT/json/version" "$CHROME_CMD"
fi

# =====================================================================================================
section "This Mac"
if [ -n "$DOUT" ]; then
    emit <<<"$(grep -v '^DISPLAYS' <<<"$DOUT")"
else
    warn "couldn't read the displays (needs node + system_profiler)" "check System Settings → Displays by eye: one display at the demo resolution"
fi

console="$(ioreg -n Root -d1 -l -w0 2>/dev/null | grep IOConsoleUsers)"
locked=0
grep -q '"CGSSessionScreenIsLocked"=Yes' <<<"$console" && locked=1
[ "$locked" = 1 ] && warn "the screen is locked: ghosts and the HUD can't be seen until it's unlocked" "unlock it; turn off sleep and the screen saver for the demo"
sip="$(grep -oE '"kCGSSessionSecureInputPID"=[0-9]+' <<<"$console" | head -1 | cut -d= -f2)"
if [ -n "$sip" ] && [ "$sip" != 0 ]; then
    holder="$(ps -o comm= -p "$sip" 2>/dev/null)"
    holder="${holder##*/}"
    if [ "$locked" = 1 ] && [ "$holder" = loginwindow ]; then
        warn "secure keyboard input is on (the lock screen holds it); recheck after unlocking" "unlock and rerun"
    else
        fail "secure keyboard input is on (held by ${holder:-pid $sip}): TabShell can't see Tab presses" "leave the password field, or turn off that app's Secure Keyboard Entry"
    fi
else
    ok "no app holds secure keyboard input"
fi

if [ "$(defaults read com.apple.Terminal SecureKeyboardEntry 2>/dev/null)" = 1 ]; then
    fail "Terminal → Secure Keyboard Entry is on: Tab can't see keys in Terminal (flow 2)" "Terminal menu → untick Secure Keyboard Entry"
else
    ok "Terminal: Secure Keyboard Entry off"
fi
if [ -d /Applications/iTerm.app ] || [ -f "$HOME/Library/Preferences/com.googlecode.iterm2.plist" ]; then
    [ "$(defaults read com.googlecode.iterm2 'Secure Input' 2>/dev/null)" = 1 ] &&
        warn "iTerm2 → Secure Keyboard Entry is on: Tab can't see keys while iTerm2 is in front" "iTerm2 menu → untick Secure Keyboard Entry"
fi

if [ "$(defaults read com.apple.universalaccess reduceMotion 2>/dev/null)" = 1 ]; then
    warn "Reduce motion is on: ghost animations are alpha-only" "fine as is; turn it off (Accessibility → Display) for the full motion"
else
    ok "Reduce motion off: ghosts animate in full"
fi
warn "Focus can't be read without extra permissions" "turn on Do Not Disturb so notifications don't cover ghosts"

# =====================================================================================================
section "Flows"
ENV="$REPO/.env"
CLONE="${GITHUB_DEMO_CLONE:-$(env_get "$ENV" GITHUB_DEMO_CLONE)}" # same lookup as web/scripts/reset-demo.ts
CLONE="${CLONE:-$HOME/Projects/tab-demo}"
CLONE="${CLONE/#\~/$HOME}"
if git -C "$CLONE" rev-parse --git-dir >/dev/null 2>&1; then
    cur="$(git -C "$CLONE" symbolic-ref -q --short HEAD 2>/dev/null)"
    if [ "$cur" != "$DEMO_BRANCH" ]; then
        fail "flow 2: $(rel "$CLONE") is on ${cur:-a detached HEAD}, not $DEMO_BRANCH" "cd web && npm run reset-demo"
    elif git -C "$CLONE" show-ref -q --verify "refs/remotes/origin/$DEMO_BRANCH"; then
        fail "flow 2: $DEMO_BRANCH was already pushed (origin/$DEMO_BRANCH exists), so git push won't print the PR link" "cd web && npm run reset-demo"
    else
        if git -C "$CLONE" rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
            base="$(git -C "$CLONE" rev-parse --abbrev-ref '@{u}' 2>/dev/null)"
            n="$(git -C "$CLONE" rev-list --count '@{u}..HEAD' 2>/dev/null)"
        else
            base="origin/main"
            n="$(git -C "$CLONE" rev-list --count origin/main..HEAD 2>/dev/null)"
        fi
        if [ "$n" = 2 ]; then
            ok "flow 2: $(rel "$CLONE") on $DEMO_BRANCH, 2 commits ahead of $base, not pushed"
        else
            fail "flow 2: $DEMO_BRANCH is ${n:-?} commits ahead of $base (the demo wants 2 unpushed)" "cd web && npm run reset-demo"
        fi
    fi
    [ -n "$(git -C "$CLONE" status --porcelain --untracked-files=no 2>/dev/null)" ] &&
        warn "flow 2: $(rel "$CLONE") has uncommitted changes" "git -C $(rel "$CLONE") status"
else
    warn "flow 2: no demo repo at $(rel "$CLONE")" "clone alaramartin/tab-demo there (or set GITHUB_DEMO_CLONE in .env), then cd web && npm run reset-demo"
fi

tj="$(curl -s --noproxy '*' --max-time 2 -H "Host: tracker.localhost:4003" http://127.0.0.1:4003/api/tickets 2>/dev/null)"
if [[ $tj == \[* ]]; then
    total="$(grep -o '"status":"[^"]*"' <<<"$tj" | wc -l | tr -d ' ')"
    review="$(grep -o '"status":"In review"' <<<"$tj" | wc -l | tr -d ' ')"
    linked="$(grep -o '"pr":"[^"]' <<<"$tj" | wc -l | tr -d ' ')"
    if [ "$total" -gt 0 ] && [ "$review" = "$total" ] && [ "$linked" = 0 ]; then
        ok "flow 3: all $total tracker tickets are In review"
    else
        fail "flow 3: $((total - review)) of $total tracker tickets are already moved (left over from a rehearsal)" "cd web && npm run reset-demo"
    fi
fi

if [ ! -f "$ENV" ]; then
    if [ -n "$(env_get "$REPO/web/.env" PAYER_PRIVATE_KEY)$(env_get "$REPO/web/.env" TEMPO_PAYER_PRIVATE_KEY)" ]; then
        fail "the keys are in web/.env, but web, brain and the demo server read the repo-root .env" "mv web/.env .env"
    else
        fail "no .env at the repo root: flows 1 and 4 can't pay, and the model has no key" "cp .env.example .env and fill it in (PAY_RAIL, the funded payer's key, …)"
    fi
else
    missing=""
    [ -z "$(env_get "$ENV" GITHUB_DEMO_REPO)" ] && missing="$missing GITHUB_DEMO_REPO"
    [ -f "$HOME/.tab/models/Qwen3-1.7B-Q4_K_M.gguf" ] || missing="$missing (local model ~/.tab/models/Qwen3-1.7B-Q4_K_M.gguf, see README)"
    if [ -n "$missing" ]; then
        fail ".env lacks:$missing" "fill them in (see .env.example), then restart the hub and web"
    else
        ok ".env has the demo repo, and the local model is downloaded"
    fi
fi

# =====================================================================================================
# PLAN "Change (10:45 PT Wed)": PAY_RAIL=mpp pays on Tempo testnet (the demo), PAY_RAIL=x402 on Base Sepolia (fallback).
section "Payments"
RAIL="$(env_get "$ENV" PAY_RAIL)"
RAIL_OK=0
case "$RAIL" in
    mpp)
        ok "PAY_RAIL=mpp: pays on Tempo testnet (MPP), the demo rail"
        PKEY=TEMPO_PAYER_PRIVATE_KEY ADDRS="TEMPO_PAYEE_ADDRESS TEMPO_ATTACKER_ADDRESS" SECRETS="MPP_SECRET_KEY" RAIL_OK=1 ;;
    x402)
        warn "PAY_RAIL=x402: pays on Base Sepolia, the fallback (the demo rail is mpp unless the 12:00 checkpoint fell back)" "set PAY_RAIL=mpp in .env, then restart the demo sites and web"
        PKEY=PAYER_PRIVATE_KEY ADDRS="PAYEE_ADDRESS ATTACKER_ADDRESS" SECRETS="" RAIL_OK=1 ;;
    "")
        if [ -f "$ENV" ]; then
            fail "PAY_RAIL isn't set in .env, so the demo sites and web may each pick a different default" "add PAY_RAIL=mpp (demo) or PAY_RAIL=x402 (fallback) to .env, then restart the demo sites and web"
        else
            warn "rail, keys and balance not checked: no .env (the ✗ above)"
        fi ;;
    *)
        fail "PAY_RAIL=$RAIL in .env is neither mpp nor x402" "set PAY_RAIL=mpp (demo) or PAY_RAIL=x402 (fallback)" ;;
esac

KEY_OK=0
if [ "$RAIL_OK" = 1 ]; then
    # Values are checked for shape only and never printed.
    bad="" missing=""
    v="$(env_get "$ENV" "$PKEY")"
    if [ -z "$v" ]; then missing="$missing $PKEY"; elif [[ $v =~ ^0x[0-9a-fA-F]{64}$ ]]; then KEY_OK=1; else bad="$bad $PKEY (not 0x + 64 hex)"; fi
    for k in $ADDRS; do
        v="$(env_get "$ENV" "$k")"
        if [ -z "$v" ]; then missing="$missing $k"; elif ! [[ $v =~ ^0x[0-9a-fA-F]{40}$ ]]; then bad="$bad $k (not 0x + 40 hex)"; fi
    done
    for k in $SECRETS; do [ -z "$(env_get "$ENV" "$k")" ] && missing="$missing $k"; done
    unset v
    [ -n "$missing" ] && fail "$RAIL rail: .env lacks$missing" "$([ "$RAIL" = mpp ] && echo "cd web && npm run tempo-wallets, paste its lines into .env" || echo "see .env.example"), then restart the demo sites and web"
    [ -n "$bad" ] && fail "$RAIL rail: malformed in .env:$bad" "fix them in .env"
    [ -z "$missing$bad" ] && ok "$RAIL rail: payer key, payee and attacker$([ -n "$SECRETS" ] && echo ", $SECRETS") set in .env"
fi

# The demo sites and web read .env once at startup: a rail switch or a new key needs a restart.
if [ -f "$ENV" ]; then
    env_m="$(stat -f %m "$ENV" 2>/dev/null)"
    stale=""
    demo_pid="$(listen_pid 4001)"
    [ -n "$demo_pid" ] && started_before "$demo_pid" "$env_m" && stale="$stale${stale:+, }the demo sites (npm run demo)"
    for p in ${web_pids//,/ }; do
        started_before "$p" "$env_m" && { stale="$stale${stale:+, }web (npm start)"; break; }
    done
    [ -n "$stale" ] && fail ".env changed at $(hms "$env_m"), after $stale started, so they still use the old rail or keys" "restart them"
    [ -n "$hub_pid" ] && started_before "$hub_pid" "$env_m" &&
        warn ".env changed at $(hms "$env_m"), after the hub started (it reads the model key once)" "restart it if you changed the model key: cd brain && npm start"
fi

# Payer balance, on the chosen rail. One demo run pays $0.35 (flow 1 $0.30, flow 4 $0.05); resale is blocked.
RUN_COST=0.35 RUNS_WANTED=6
if [ "$OFFLINE" = 1 ]; then
    warn "payer balance not checked (--offline)" "cd web && npm run balance"
elif [ "$KEY_OK" = 1 ] && [ -d "$REPO/web/node_modules" ]; then
    bout="$(cd "$REPO/web" && tmo_group 25 npm run -s balance 2>&1)"
    rc=$?
    # The payer's line on this rail's chain (else any payer line, else the first line with a number), then its first
    # "<amount> <token>", e.g. "payer 0x4A86…: 1.25 USDC (Base Sepolia)".
    nums="$(grep -E '[0-9]' <<<"$bout" | grep -viE 'error|warn|^[[:space:]]+at ')"
    chain="$([ "$RAIL" = mpp ] && echo 'tempo|moderato' || echo 'base')"
    line="$( (grep -i 'payer' <<<"$nums" | grep -iE "$chain"; grep -i 'payer' <<<"$nums"; echo "$nums") | grep . | head -1 | cut -c1-160)"
    amt="$(grep -oE '(^|[[:space:]:])[0-9][0-9,]*(\.[0-9]+)?[[:space:]]+[A-Za-z][A-Za-z0-9.]*' <<<"$line" | head -1 | sed 's/^[[:space:]:]*//')"
    num="$(sed -E 's/,//g; s/(\.[0-9]*[1-9])0+$/\1/; s/\.0+$//' <<<"${amt%%[[:space:]]*}")" tok="${amt##*[[:space:]]}"
    # balance.ts may not follow PAY_RAIL yet (C's half of the MPP change): a balance from the other rail's chain says
    # nothing about this one.
    other=""
    [ "$RAIL" = mpp ] && grep -qi 'base sepolia' <<<"$line" && other="Base Sepolia (x402)"
    [ "$RAIL" = x402 ] && grep -qiE 'tempo|moderato' <<<"$line" && other="Tempo (mpp)"
    if [ "$rc" = 0 ] && [ -n "$other" ]; then
        warn "npm run balance reported $other, not the $RAIL rail: ${line:-?}" "pull C's rail-aware web/scripts/balance.ts, or check the $RAIL payer by hand"
    elif [ "$rc" != 0 ]; then
        fail "npm run balance failed ($( [ "$rc" = 142 ] && echo "no answer in 25 s" || grep -iE 'error' <<<"$bout" | head -1 | cut -c1-140))" "check the network, then cd web && npm run balance"
    elif [ -z "$num" ]; then
        warn "couldn't read an amount from npm run balance: $(grep -v '^[[:space:]]*$' <<<"$bout" | tail -1 | cut -c1-140 | grep . || echo "no output")" "cd web && npm run balance"
    elif awk -v n="$num" -v c="$RUN_COST" 'BEGIN { exit !(n < c) }'; then
        fail "payer has $num $tok on the $RAIL rail: one demo run needs $RUN_COST (flow 1 \$0.30 + flow 4 \$0.05)" "$([ "$RAIL" = mpp ] && echo "cd web && npm run tempo-wallets (tops up the payer in .env)" || echo "fund it at https://faucet.circle.com (Base Sepolia USDC)")"
    else
        runs="$(awk -v n="$num" -v c="$RUN_COST" 'BEGIN { printf "%d", n / c }')"
        if [ "$runs" -lt "$RUNS_WANTED" ]; then
            warn "payer has $num $tok on the $RAIL rail: enough for $runs run(s), the demo and rehearsals want ~$RUNS_WANTED" "top it up"
        else
            ok "payer has $num $tok on the $RAIL rail (≈ $runs runs at \$$RUN_COST)"
        fi
    fi
elif [ "$RAIL_OK" = 1 ] && [ ! -d "$REPO/web/node_modules" ]; then
    fail "payer balance not checked: web/ has no node_modules" "cd web && npm i"
fi

# =====================================================================================================
printf '\n%s✓ %d%s  %s! %d%s  %s✗ %d%s  ' "$G" "$NOK" "$N" "$Y" "$NWARN" "$N" "$R" "$NFAIL" "$N"
if [ "$NFAIL" -gt 0 ]; then
    printf '%snot ready: fix the ✗ lines, then rerun%s\n' "$B" "$N"
    exit 1
fi
printf '%sready%s (read the ! lines once)\n' "$B" "$N"
exit 0
