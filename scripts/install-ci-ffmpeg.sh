#!/usr/bin/env bash
# Puts ffmpeg and ffprobe on a Linux CI runner's PATH for the media tests.
#
# The binaries are a pinned static 7.0.2 build from a GitHub release, checked
# against its SHA-256. A runner downloads them from GitHub's own network in
# seconds; the Ubuntu package mirror stalled whole deploys for 15 minutes.
set -euo pipefail

RELEASE="https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1"
DEST="/usr/local/bin"

# Each tool's release asset and the digest it must match.
declare -A SHA256=(
  [ffmpeg]="bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa"
  [ffprobe]="25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067"
)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Download, verify, unpack and install each tool. A stalled connection gives
# up after a minute and retries, so a slow download fails fast.
for tool in ffmpeg ffprobe; do
  gz="$work/$tool.gz"
  curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
    -o "$gz" "$RELEASE/$tool-linux-x64.gz"
  echo "${SHA256[$tool]}  $gz" | sha256sum -c --quiet -
  gunzip "$gz"
  sudo install -m 0755 "$work/$tool" "$DEST/$tool"
done

ffmpeg -hide_banner -version | head -n 1
ffprobe -hide_banner -version | head -n 1
