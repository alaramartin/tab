#!/bin/bash
# Tab v2 setup: llama.cpp, the local models, the brain's packages, TabShell.app.
#   shell/scripts/setup.sh            install what's missing (models ~2.6 GB in ~/.tab/models)
#   shell/scripts/setup.sh --agent    also start the hub at login (a LaunchAgent, dev.tab.hub)
# Re-running is safe: only missing pieces are fetched. Then: grant TabShell Accessibility and Screen Recording.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
M="$HOME/.tab/models"
mkdir -p "$M"

command -v brew >/dev/null || { echo "Homebrew is needed: https://brew.sh"; exit 1; }
command -v llama-server >/dev/null || brew install llama.cpp
command -v node >/dev/null || brew install node

fetch() { # repo file
    if [ -f "$M/$2" ]; then echo "have $2"; return; fi
    echo "downloading $2"
    curl -fL --progress-bar -C - -o "$M/$2.part" "https://huggingface.co/$1/resolve/main/$2" && mv "$M/$2.part" "$M/$2"
}
fetch unsloth/Qwen3-1.7B-GGUF Qwen3-1.7B-Q4_K_M.gguf
fetch ggml-org/embeddinggemma-300M-GGUF embeddinggemma-300M-Q8_0.gguf
fetch LiquidAI/LFM2-VL-450M-GGUF LFM2-VL-450M-Q8_0.gguf
fetch LiquidAI/LFM2-VL-450M-GGUF mmproj-LFM2-VL-450M-Q8_0.gguf

(cd brain && npm install --no-audit --no-fund)
shell/scripts/build-shell.sh --run

if [ "${1:-}" = "--agent" ]; then
    PL="$HOME/Library/LaunchAgents/dev.tab.hub.plist"
    NODE="$(command -v node)"
    cat >"$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.tab.hub</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--no-warnings=ExperimentalWarning</string><string>--import</string><string>tsx</string><string>src/hub.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT/brain</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.tab/hub.log</string>
  <key>StandardErrorPath</key><string>$HOME/.tab/hub.log</string>
</dict></plist>
EOF
    launchctl unload "$PL" 2>/dev/null || true
    launchctl load "$PL"
    echo "hub runs at login (log ~/.tab/hub.log); remove with: launchctl unload $PL && rm $PL"
else
    echo "start the hub with: cd brain && npm start   (or re-run with --agent to start it at login)"
fi
echo "then grant TabShell Accessibility and Screen Recording (System Settings → Privacy & Security), and run shell/scripts/doctor.sh"
