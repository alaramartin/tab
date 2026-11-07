#!/bin/bash
# Build TabShell.app and sign it with a stable self-signed identity, so the Accessibility grant survives rebuilds.
#   shell/scripts/build-shell.sh            build + sign
#   shell/scripts/build-shell.sh --run [args]   build, sign, (re)launch; log in ~/.tab/shell.log
# The identity lives in its own keychain (~/Library/Keychains/tab-shell-signing.keychain-db, password "tab"),
# created once, so signing never prompts. It's a throwaway dev cert; nothing secret.
set -euo pipefail
cd "$(dirname "$0")/.."

IDENTITY="Tab Shell Dev"
KC="$HOME/Library/Keychains/tab-shell-signing.keychain-db"
KC_PW="tab"
APP="build/TabShell.app"

ensure_identity() {
    if [ ! -f "$KC" ]; then
        echo "creating signing keychain $KC"
        security create-keychain -p "$KC_PW" "$KC"
        security set-keychain-settings "$KC" # no auto-lock
    fi
    security unlock-keychain -p "$KC_PW" "$KC"
    # codesign only finds identities in keychains on the user search list.
    if ! security list-keychains -d user | grep -q "tab-shell-signing"; then
        # Keep every existing keychain as one array element, so paths with spaces stay whole.
        local list=() k
        while IFS= read -r k; do
            k="$(echo "$k" | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//')"
            [ -n "$k" ] && list+=("$k")
        done < <(security list-keychains -d user)
        security list-keychains -d user -s "${list[@]}" "$KC"
    fi
    if security find-certificate -c "$IDENTITY" "$KC" >/dev/null 2>&1; then return; fi
    echo "creating self-signed code-signing identity \"$IDENTITY\""
    local tmp
    tmp="$(mktemp -d)"
    cat >"$tmp/req.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF
    /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$tmp/req.cnf" \
        -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
    /usr/bin/openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout pass:tab 2>/dev/null
    security import "$tmp/id.p12" -k "$KC" -P tab -T /usr/bin/codesign >/dev/null
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PW" "$KC" >/dev/null
    rm -rf "$tmp"
}

swift build -c release
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp .build/release/TabShell "$APP/Contents/MacOS/TabShell"
# Record the commit (and -dirty if shell/ has uncommitted changes) in the app, so a log shows which build ran.
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git status --porcelain -- . 2>/dev/null)" ]; then COMMIT="$COMMIT-dirty"; fi
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key><string>dev.tab.shell</string>
    <key>CFBundleName</key><string>TabShell</string>
    <key>CFBundleDisplayName</key><string>Tab</string>
    <key>CFBundleExecutable</key><string>TabShell</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.1</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>TabGitCommit</key><string>$COMMIT</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

ensure_identity
codesign --force --keychain "$KC" --sign "$IDENTITY" --identifier dev.tab.shell "$APP"
echo "signed: $(codesign -dr - "$APP" 2>&1 | grep designated)"

if [ "${1:-}" = "--run" ]; then
    shift
    pkill -x TabShell 2>/dev/null || true
    mkdir -p "$HOME/.tab"
    sleep 0.3
    open -n "$APP" --stdout "$HOME/.tab/shell.log" --stderr "$HOME/.tab/shell.log" --args "$@"
    echo "launched; log: ~/.tab/shell.log"
fi
