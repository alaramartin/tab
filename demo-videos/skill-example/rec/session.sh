#!/bin/zsh
# Stage the Mac for recording takes, and put it back afterwards.
#   rec/session.sh up     quit normal Chrome, plain wallpaper, no desktop icons, start hub + demo sites + web + debug Chrome + TabShell
#   rec/session.sh down   stop what `up` started, restore wallpaper and desktop icons, reopen normal Chrome
set -u
REPO=/Users/alara/Projects/paradigmhacks
HERE=${0:A:h}
STATE=$HERE/takes/.session
LOGS=$HERE/takes
mkdir -p $LOGS
case "$1" in
up)
  osascript -e 'tell application "System Events" to get picture of every desktop' > $STATE.wallpaper
  pgrep -xq "Google Chrome" && echo 1 > $STATE.chrome || echo 0 > $STATE.chrome
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null; sleep 3
  [ -f $HERE/wallpaper.png ] || ffmpeg -loglevel error -y -f lavfi -i color=c=0x3a3d46:s=2880x1800 -frames:v 1 $HERE/wallpaper.png
  defaults write com.apple.finder CreateDesktop false && killall Finder
  osascript -e "tell application \"System Events\" to set picture of every desktop to POSIX file \"$HERE/wallpaper.png\""
  (cd $REPO/brain && nohup npm start > $LOGS/hub.log 2>&1 < /dev/null &)
  (cd $REPO/web && nohup npm run demo > $LOGS/demo.log 2>&1 < /dev/null &)
  for i in {1..30}; do nc -z 127.0.0.1 7800 2>/dev/null && nc -z 127.0.0.1 4001 2>/dev/null && break; sleep 0.5; done
  open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/tab-chrome --no-first-run --hide-crash-restore-bubble
  for i in {1..30}; do curl -s 127.0.0.1:9222/json/version >/dev/null && break; sleep 0.5; done
  (cd $REPO/web && nohup npm start > $LOGS/web.log 2>&1 < /dev/null &)
  sleep 4
  pkill -f "TabShell.app/Contents/MacOS/TabShell"; sleep 1
  open $REPO/shell/build/TabShell.app
  sleep 3
  osascript -e 'tell application "System Events" to set visible of every process whose visible is true and name is not "Google Chrome" and name is not "TabShell" to false'
  ;;
down)
  pkill -f "TabShell.app/Contents/MacOS/TabShell"
  pkill -f "tsx src/hub.ts"; pkill -f "tsx demo/server.ts"; pkill -f "tsx src/main.ts"
  pkill -f "user-data-dir=/tmp/tab-chrome"
  W=$(sed 's/, .*//' $STATE.wallpaper)
  [ -n "$W" ] && osascript -e "tell application \"System Events\" to set picture of every desktop to POSIX file \"$W\""
  defaults write com.apple.finder CreateDesktop true && killall Finder
  [ "$(cat $STATE.chrome 2>/dev/null)" = 1 ] && { sleep 2; open -a "Google Chrome"; }
  ;;
esac
