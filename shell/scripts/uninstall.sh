#!/bin/bash
# Remove Tab from this Mac: only what Tab created.
#   shell/scripts/uninstall.sh                dry run: print what would be removed
#   shell/scripts/uninstall.sh --yes          do it
#   add --artifacts to also delete build output in the repo (shell/.build, shell/build, brain/node_modules)
#
# Stops TabShell, the hub and Tab's model servers, removes the hub's login item, the signing keychain (and its entry
# in the keychain search list), TabShell's privacy permissions and saved HUD settings, and ~/.tab (memory, models,
# payment ledger, settings). Homebrew's llama.cpp stays.
set -uo pipefail
cd "$(dirname "$0")/../.."

DO=0
ARTIFACTS=0
for a in "$@"; do
    case "$a" in
        --yes) DO=1 ;;
        --artifacts) ARTIFACTS=1 ;;
        *) echo "unknown flag $a" >&2; exit 2 ;;
    esac
done

run() {
    if [ "$DO" = 1 ]; then echo "+ $*"; "$@"; else echo "would: $*"; fi
}

REPO="$(pwd)"
KC="$HOME/Library/Keychains/tab-shell-signing.keychain-db"
AGENT="$HOME/Library/LaunchAgents/dev.tab.hub.plist"

# Processes, matched narrowly so nothing else is hit.
[ -f "$AGENT" ] && run launchctl unload "$AGENT"
pgrep -x TabShell >/dev/null && run pkill -x TabShell
for p in $(pgrep -f "src/hub.ts"); do # this repo's hub only (by working directory)
    [ "$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" = "$REPO/brain" ] && run kill "$p"
done
for p in $(pgrep -f "llama-server -m $HOME/.tab/models/"); do run kill "$p"; done # Tab's model servers

# The hub's login item.
[ -f "$AGENT" ] && run rm -f "$AGENT"

# Signing keychain and its search-list entry.
if security list-keychains -d user | grep -q "tab-shell-signing"; then
    keep=() # rebuild the list without ours, one element per keychain, so paths with spaces stay whole
    while IFS= read -r k; do
        k="$(echo "$k" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
        [ -n "$k" ] && [[ "$k" != *tab-shell-signing* ]] && keep+=("$k")
    done < <(security list-keychains -d user)
    run security list-keychains -d user -s "${keep[@]}"
fi
[ -f "$KC" ] && run security delete-keychain "$KC"

# TabShell's privacy permissions (harmless if there are none) and saved HUD settings.
run tccutil reset Accessibility dev.tab.shell
run tccutil reset ScreenCapture dev.tab.shell
run tccutil reset ListenEvent dev.tab.shell
defaults read dev.tab.shell >/dev/null 2>&1 && run defaults delete dev.tab.shell

# Tab's data.
[ -d "$HOME/.tab" ] && run rm -rf "$HOME/.tab"

if [ "$ARTIFACTS" = 1 ]; then
    for d in shell/.build shell/build brain/node_modules; do
        [ -e "$d" ] && run rm -rf "$d"
    done
fi

[ "$DO" = 1 ] && echo "done." || echo "dry run; pass --yes to do it."
