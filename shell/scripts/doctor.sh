#!/bin/bash
# Tab v2 health check (read-only): models, permissions, processes, memory.
#   shell/scripts/doctor.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
M="${TAB_MODELS_DIR:-$HOME/.tab/models}"
bad=0
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n      %s\n" "$1" "$2"; }
fail() { printf "  \033[31m✗\033[0m %s\n      %s\n" "$1" "$2"; bad=1; }

echo "Local models"
if command -v llama-server >/dev/null; then ok "llama.cpp $(llama-server --version 2>&1 | head -1 | sed 's/version: //')"; else fail "llama-server not found" "brew install llama.cpp"; fi
check_model() { # file, what it's for, required?
    if [ -f "$M/$1" ]; then ok "$1 ($2, $(du -h "$M/$1" | cut -f1))"
    elif [ "$3" = req ]; then fail "$1 missing ($2)" "shell/scripts/setup.sh downloads it"
    else warn "$1 missing ($2)" "optional; shell/scripts/setup.sh downloads it"; fi
}
check_model Qwen3-1.7B-Q4_K_M.gguf "next-action model" req
check_model embeddinggemma-300M-Q8_0.gguf "field facts, search" req
check_model LFM2-VL-450M-Q8_0.gguf "icon names" opt
check_model mmproj-LFM2-VL-450M-Q8_0.gguf "icon names" opt

echo "TabShell"
if pgrep -f "TabShell.app/Contents/MacOS/TabShell" >/dev/null; then ok "running"; else fail "not running" "shell/scripts/build-shell.sh --run"; fi
LOG="$HOME/.tab/shell.log"
if [ -f "$LOG" ]; then
    if grep -q "tap: running" "$LOG"; then ok "Accessibility granted (the input tap runs)"; else fail "no input tap yet" "System Settings → Privacy & Security → Accessibility → TabShell"; fi
    last=$(grep "vision: screen recording" "$LOG" | tail -1)
    case "$last" in
        *"not granted"*|"") warn "Screen Recording not granted" "System Settings → Privacy & Security → Screen Recording → TabShell (then relaunch it)";;
        *) ok "Screen Recording granted (OCR fallback and icon names on)";;
    esac
    if grep -q "hub: connected" "$LOG"; then ok "has connected to the hub"; fi
fi

echo "Hub"
if lsof -nP -iTCP:"${HUB_PORT:-7800}" -sTCP:LISTEN >/dev/null 2>&1; then ok "listening on :${HUB_PORT:-7800}"; else fail "not running" "cd brain && npm start"; fi
for p in 7811 7812 7816; do
    if curl -sf "http://127.0.0.1:$p/health" >/dev/null 2>&1; then ok "model server :$p up"; fi
done

echo "Memory"
if [ -f "$HOME/.tab/memory.db" ]; then
    (cd brain && node --no-warnings=ExperimentalWarning --import tsx tools/memory.ts stats 2>/dev/null | sed -n '2,3p' | sed 's/^/  /')
else
    warn "no ~/.tab/memory.db yet" "it's created when the hub first runs"
fi
[ -f "$HOME/.tab/config.json" ] && ok "~/.tab/config.json present (denyApps)"

exit $bad
