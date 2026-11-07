#!/bin/zsh
# rec/proxy.sh <name>  — rec/takes/<name>.mov → public/takes/<name>.mp4: 30 fps, short GOP, so Remotion seeks fast.
cd ${0:A:h}/..; mkdir -p public/takes
ffmpeg -loglevel error -y -i rec/takes/$1.mov -r 30 -c:v libx264 -preset fast -crf 16 -g 15 -pix_fmt yuv420p -movflags +faststart public/takes/$1.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 public/takes/$1.mp4
