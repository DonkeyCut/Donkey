#!/usr/bin/env bash
# Puts ffmpeg and ffprobe on a Linux CI runner's PATH for the media tests.
#
# The binaries are a static build of 9.0.2, the release the Mac app and the
# cloud worker run, from a GitHub release pinned by tag and SHA-256. A runner
# downloads it from GitHub's own network in seconds; the Ubuntu package
# mirror stalled whole deploys for 15 minutes.
set -euo pipefail

BUILD="ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0"
URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/$BUILD.tar.xz"
SHA256="68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269"
DEST="/usr/local/bin"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Download and verify. A stalled connection gives up after two minutes and
# retries, so a slow download fails fast.
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 120 \
  -o "$work/ffmpeg.tar.xz" "$URL"
echo "$SHA256  $work/ffmpeg.tar.xz" | sha256sum -c --quiet -

# Unpack only the two tools the tests call, and install them.
tar -xJf "$work/ffmpeg.tar.xz" -C "$work" "$BUILD/bin/ffmpeg" "$BUILD/bin/ffprobe"
sudo install -m 0755 "$work/$BUILD/bin/ffmpeg" "$work/$BUILD/bin/ffprobe" "$DEST/"

ffmpeg -hide_banner -version | head -n 1
ffprobe -hide_banner -version | head -n 1
