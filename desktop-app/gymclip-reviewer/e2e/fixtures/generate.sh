#!/usr/bin/env bash
# Synthesize e2e fixture videos for Playwright tests.
#
# Produces two H.264/MP4 files in this directory:
#   - sample-5s.mp4:  5 seconds, single SMPTE color bar pattern.
#                     Use for "import a single video" smoke tests.
#   - sample-10s.mp4: 10 seconds, two distinct color bar segments
#                     concatenated (color bars -> color test pattern at t=5s)
#                     so visual-diff detectors can find 2 segments.
#
# The MP4s themselves are git-ignored (large binary, regenerable). This
# script IS checked in so CI and other dev machines can reproduce identical
# fixtures by running `bash e2e/fixtures/generate.sh`.
#
# Requires: ffmpeg with libx264. Text overlays are intentionally omitted —
# Homebrew's default ffmpeg build does not include the drawtext filter (no
# freetype dep), and we don't actually need on-screen text to drive the
# import/review/export flow. Athlete-name labelling is exercised at the
# domain-logic layer instead (unit tests + manual reviewer notes).

set -euo pipefail
cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "Error: ffmpeg not found on PATH. Install via 'brew install ffmpeg'." >&2
  exit 1
fi

# --- Sample 1: 5s SMPTE color bars ---------------------------------------
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "smptebars=duration=5:size=1280x720:rate=30" \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline -movflags +faststart \
  sample-5s.mp4

# --- Sample 2: 10s two visually distinct halves --------------------------
# First 5s: SMPTE color bars. Second 5s: rgbtestsrc test pattern.
# The hard cut at t=5s gives detectors a clean segment boundary to find.
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "smptebars=duration=5:size=1280x720:rate=30" \
  -f lavfi -i "rgbtestsrc=duration=5:size=1280x720:rate=30" \
  -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" \
  -map "[v]" \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline -movflags +faststart \
  sample-10s.mp4

echo "Generated fixtures:"
ls -lh sample-*.mp4
