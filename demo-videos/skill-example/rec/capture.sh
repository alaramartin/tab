#!/bin/zsh
# rec/capture.sh <name>  — record the full screen (60 fps, cursor on) to rec/takes/<name>.mov until Ctrl-C / SIGINT / `q` on stdin.
# Writes rec/takes/<name>.t0 = wall-clock ms of frame 0, so logged events (Date.now()) can be mapped to video seconds.
# The terminal running this needs Screen Recording permission. If "Capture screen 0" isn't found: ffmpeg -f avfoundation -list_devices true -i ""
set -u
cd ${0:A:h}; mkdir -p takes; n=$1
ffmpeg -loglevel error -y -f avfoundation -capture_cursor 1 -pixel_format nv12 -framerate 60 -i "Capture screen 0:none" \
  -c:v h264_videotoolbox -b:v 60M -progress pipe:1 -stats_period 0.1 takes/$n.mov |
while read -r l; do
  if [[ ! -s takes/$n.t0 && $l == frame=* && ${l#frame=} -gt 0 ]]; then
    echo $(( $(python3 -c 'import time;print(int(time.time()*1000))') - ${l#frame=} * 1000 / 60 )) > takes/$n.t0
    echo "recording $n" >&2
  fi
done
