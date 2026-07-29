# Donkey Cut cloud render worker. Build the bundle first (npm run worker:build),
# then build this image from site/:
#   docker build -f src/cut/worker/Dockerfile -t donkey-cut-worker .
#
# The Debian release picks the ffmpeg, so it is part of the contract: the
# export's final pass passes -display_rotation, which ffmpeg gained in 6.0.
# Bookworm's 5.1 encodes the entire file and then dies on that last command, at
# 98% progress, with "Unrecognized option". Trixie carries 7.1.
FROM node:22-trixie-slim

# ffmpeg/ffprobe for the render pipeline; python3 runs the yt-dlp zipapp.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates curl \
  && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
       -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

# Hold the image to what the pipeline actually calls. A base bump that walks
# ffmpeg backwards fails here instead of at 98% of someone's export.
RUN ffmpeg -hide_banner -h full 2>&1 | grep -q -- '-display_rotation' \
  || { echo "ffmpeg is too old: the export re-mux needs -display_rotation (6.0+)." >&2; exit 1; }

# The share ladder encodes every rung with libx264 and tunes it through
# -x264-params. A build without it (an LGPL ffmpeg) would fail per rung at
# encode time, so it fails here instead.
RUN ffmpeg -hide_banner -encoders 2>&1 | grep -q '\blibx264\b' \
  || { echo "ffmpeg has no libx264: the share HLS ladder cannot encode." >&2; exit 1; }

WORKDIR /app
COPY dist/cut-worker/main.js ./main.js

ENV NODE_ENV=production
ENTRYPOINT ["node", "main.js"]
