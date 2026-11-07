#!/bin/zsh
# rec/kf.sh take t1 t2 ... → out/kf-<take>.jpg (frames in order, 4 per row)
cd ${0:A:h}/..; n=$1; shift; rm -rf out/kf; mkdir -p out/kf; i=0
for t in $@; do i=$((i+1)); ffmpeg -loglevel error -y -ss $t -i public/takes/$n.mp4 -frames:v 1 -vf scale=960:-2 out/kf/$(printf %02d $i).png; done
ffmpeg -loglevel error -y -pattern_type glob -i 'out/kf/*.png' -filter_complex "tile=4x$(( ($#+3)/4 )):padding=6" -frames:v 1 out/kf-$n.jpg
