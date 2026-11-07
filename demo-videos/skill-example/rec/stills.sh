#!/bin/zsh
# rec/stills.sh take t ... → public/takes/<take>-still-<t>.jpg (freeze-frames for Seg.hold), from the 30 fps edit copy
cd ${0:A:h}/..; n=$1; shift
for t in $@; do ffmpeg -loglevel error -y -ss $t -i public/takes/$n.mp4 -frames:v 1 -q:v 2 public/takes/$n-still-$(printf %.2f $t).jpg; done
