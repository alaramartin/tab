#!/bin/zsh
# Stage the Mac for recording takes, and put it back afterwards.
#   rec/session.sh up     quit normal Chrome, clean desktop + wallpaper, start debug Chrome, web, TabShell, reset demo
#   rec/session.sh down   restore wallpaper and desktop icons (demo services keep running)
set -u
REPO=/Users/alara/Projects/paradigmhacks
HERE=${0:A:h}
STATE=$HERE/takes/.session
mkdir -p $HERE/takes
case "$1" in
up)
  osascript -e 'tell application "System Events" to get picture of every desktop' > $STATE.wallpaper
  osascript -e 'tell application "Google Chrome" to quit' 2>/dev/null; sleep 3
  defaults write com.apple.finder CreateDesktop false && killall Finder
  osascript -e "tell application \"System Events\" to set picture of every desktop to POSIX file \"$HERE/wallpaper.png\""
  open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/tab-chrome --no-first-run --hide-crash-restore-bubble
  for i in {1..30}; do curl -s 127.0.0.1:9222/json/version >/dev/null && break; sleep 0.5; done
  (cd $REPO/web && nohup npm start > $HERE/takes/web.log 2>&1 < /dev/null &)
  sleep 4
  (cd $REPO/web && npm run reset-demo 2>&1 | tail -4)
  pkill -f "TabShell.app/Contents/MacOS/TabShell"; sleep 1
  open $REPO/shell/build/TabShell.app
  sleep 3
  # hide everything except Chrome + TabShell
  osascript -e 'tell application "System Events" to set visible of every process whose visible is true and name is not "Google Chrome" and name is not "TabShell" to false'
  ;;
down)
  W=$(cat $STATE.wallpaper | sed 's/, .*//')
  [ -n "$W" ] && osascript -e "tell application \"System Events\" to set picture of every desktop to POSIX file \"$W\""
  defaults write com.apple.finder CreateDesktop true && killall Finder
  ;;
esac
