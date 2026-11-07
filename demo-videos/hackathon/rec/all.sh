#!/bin/zsh
# One full run: reset once, then every take in story order (HUD totals accumulate). Usage: rec/all.sh [take...]
cd ${0:A:h}/..
takes=($@); (( $#takes )) || takes=(tickets resale push release)
(cd ../web && npm run reset-demo 2>&1 | tail -1)
# close leftover GitHub tabs, clear Terminal, hide Calendar + Terminal
for id in $(curl -s 127.0.0.1:9222/json | python3 -c 'import json,sys;[print(t["id"]) for t in json.load(sys.stdin) if t["type"]=="page" and "github.com" in t["url"]]'); do curl -s 127.0.0.1:9222/json/close/$id >/dev/null; done
osascript -e 'tell application "System Events" to set visible of (every process whose name is "Calendar" or name is "Terminal") to false' 2>/dev/null
for t in $takes; do
  npx tsx rec/take.mts $t 2>&1 | grep -v NSKVO | tail -1
  node rec/events.mjs $t | grep -E "ERROR|video start"
  osascript -e 'tell application "System Events" to set visible of (every process whose name is "Calendar" or name is "Terminal") to false' 2>/dev/null
  sleep 1
done
