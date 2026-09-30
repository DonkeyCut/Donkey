# Donkey Cut cloud render worker. Build the bundle first (npm run worker:build),
# then build this image from site/:
#   docker build -f src/cut/worker/Dockerfile -t donkey-cut-worker .
#
# The Debian release picks the ffmpeg, so it is part of the contract: the
# export's final pass passes -display_rotation, which ffmpeg gained in 6.0.
# Bookworm's 5.1 encodes the entire file and then dies on that last command, at
# 98% progress, with "Unrecognized option". Trixie carries 7.1.
FROM node:24-trixie-slim

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
# HEVC exports a browser cannot encode itself land here; libx265 is their
# only encoder on this image.
RUN ffmpeg -hide_banner -encoders 2>&1 | grep -q '\blibx265\b' \
  || { echo "ffmpeg has no libx265: HEVC exports cannot encode." >&2; exit 1; }
# The color pipeline: every graded clip runs through lut3d in 16-bit RGB, and
# sharpen and clarity through gblur, guided and blend. A build missing one
# of them fails the graph at render time, so it fails here.
RUN for f in lut3d guided gblur blend split lutyuv; do \
      ffmpeg -hide_banner -filters 2>&1 | grep -q " $f " \
        || { echo "ffmpeg has no $f filter: the color pipeline cannot render." >&2; exit 1; }; \
    done
# Clarity's reduced copy comes back to the picture's size through scale's
# reference input (rw/rh), which ffmpeg gained in 7.1.
RUN ffmpeg -hide_banner -loglevel error -f lavfi -i color=s=8x8:d=0.1 -f lavfi -i color=s=4x4:d=0.1 \
      -filter_complex '[1:v][0:v]scale=rw:rh' -f null - \
  || { echo "ffmpeg's scale takes no reference input: the clarity pass cannot render." >&2; exit 1; }
# 10-bit input into libx265: the graded picture is sampled at 16 bits and
# handed to the encoder as 10-bit planes.
RUN ffmpeg -hide_banner -h encoder=libx265 2>&1 | grep -q 'yuv420p10le' \
  || { echo "libx265 takes no 10-bit input: HDR and 10-bit exports cannot encode." >&2; exit 1; }

WORKDIR /app
# The browser primitives a job draws and decodes with: the server canvas, the
# Node decoders behind mediabunny, and Web Audio. All native, so they are kept
# out of the bundle (worker:build marks them external) and installed for this
# platform here. mediabunny itself comes along because its server package
# registers into it — one registry instance, one copy.
RUN npm install --no-package-lock --omit=dev \
      skia-canvas@^3.0.8 \
      mediabunny@^1.51.0 \
      @mediabunny/server@^1.54.0 \
      node-web-audio-api@^2.2.0
COPY dist/cut-worker/main.js ./main.js
# The faces the editor shows, staged as files the canvas loads at startup so a
# title renders in its own font. Fetched here so the image carries them
# whatever state the build context is in; a family that will not come down
# leaves the rest staged and falls back at draw time.
COPY scripts/fetch-cut-fonts.mjs ./scripts/fetch-cut-fonts.mjs
RUN node scripts/fetch-cut-fonts.mjs

ENV NODE_ENV=production
ENTRYPOINT ["node", "main.js"]
