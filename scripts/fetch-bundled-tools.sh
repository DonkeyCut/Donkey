#!/usr/bin/env bash
#
# Vendors the arm64 command-line tools the Donkey Cut video editor runs into
# vendor/donkey-tools/, making each binary self-contained (its Homebrew dylibs are
# copied alongside and the install names are rewritten to @loader_path). The
# packaging step (scripts/package-donkey-app.sh -> stage_bundled_tools) then copies
# this directory into Donkey.app/Contents/Resources/donkey-tools/.
#
# The vendored binaries are large and are NOT committed to git — run this
# on the build machine before packaging. Re-runnable; each tool is independent, so
# one failure does not abort the rest.
#
# Requires: Homebrew, dylibbundler (installed automatically), network access.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/donkey-tools"
BREW_LIB="$(brew --prefix 2>/dev/null)/lib"

mkdir -p "$VENDOR_DIR"
STATUS=()

log() { printf '\n==> %s\n' "$*"; }
ok()  { STATUS+=("OK    $1"); }
fail(){ STATUS+=("FAIL  $1 ($2)"); echo "  ! $1: $2" >&2; }

# Extra dylib search dirs (besides Homebrew's lib) for the next bundle() call.
EXTRA_SEARCH=()

# Copy a binary into the vendor dir and bundle its dylibs flat (so @loader_path,
# which is relative to each file's own directory, resolves for binary->lib and
# lib->lib alike).
bundle() {
  # $1 = absolute source binary, $2 = vendored name
  local src="$1" name="$2"
  [ -f "$src" ] || { fail "$name" "source not found: $src"; return 1; }
  cp -f "$src" "$VENDOR_DIR/$name"
  chmod +x "$VENDOR_DIR/$name"
  local search=(--search-path "$BREW_LIB")
  local dir
  for dir in "${EXTRA_SEARCH[@]:-}"; do [ -n "$dir" ] && search+=(--search-path "$dir"); done
  if dylibbundler --overwrite-files --bundle-deps --fix-file "$VENDOR_DIR/$name" \
    --dest-dir "$VENDOR_DIR" --install-path "@loader_path/" "${search[@]}" \
    >/dev/null 2>&1; then
    ok "$name"
  else
    fail "$name" "dylibbundler failed; binary would have unresolved libraries"
    return 1
  fi
}

# Install prefix of the from-source libass, set by build_libass for build_lgpl_ffmpeg.
ASS_PREFIX=""

# Build libass from source so ffmpeg's `subtitles` filter (subtitle burn-in) works in the bundled
# binary. We build it with the CoreText font provider (--disable-fontconfig): CoreText uses macOS's
# own installed fonts, so there are NO fontconfig config files or font cache to relocate into the
# bundle — the relocation trap that keeps fontconfig-based tools from shipping. harfbuzz is left off
# (--disable-harfbuzz) to avoid pulling in the glib dependency tree; Latin/CJK subtitles render fine,
# only complex-script (Arabic/Indic) shaping is given up. libass (ISC), freetype (FTL), and fribidi
# (LGPL) are all LGPL-compatible, so enabling it keeps ffmpeg --disable-gpl.
build_libass() {
  local ver="0.17.3"
  local work="/tmp/libass-build"
  local brew_prefix; brew_prefix="$(brew --prefix)"
  local dep
  for dep in freetype fribidi; do
    brew list "$dep" >/dev/null 2>&1 || brew install "$dep" >/dev/null 2>&1
  done
  rm -rf "$work"; mkdir -p "$work"
  curl -fsSL -o "$work/libass.tar.xz" \
    "https://github.com/libass/libass/releases/download/${ver}/libass-${ver}.tar.xz" \
    || { echo "FATAL: libass source download failed" >&2; exit 1; }
  tar -xJf "$work/libass.tar.xz" -C "$work" --strip-components=1
  ( cd "$work" \
    && PKG_CONFIG_PATH="$brew_prefix/lib/pkgconfig:$brew_prefix/share/pkgconfig" \
       ./configure --prefix="$work/out" --disable-static --enable-shared \
         --disable-fontconfig --disable-harfbuzz \
    && make -j"$(sysctl -n hw.ncpu)" \
    && make install ) >"$work/build.log" 2>&1
  if [ ! -f "$work/out/lib/libass.dylib" ]; then
    echo "FATAL: libass build failed; tail of $work/build.log:" >&2
    tail -25 "$work/build.log" >&2
    exit 1
  fi
  ASS_PREFIX="$work/out"
}

# Build a TRUE LGPL ffmpeg from source — no --enable-gpl, no x264/x265. H.264/HEVC
# encode comes from Apple VideoToolbox; decode is built in; mp3 via LGPL libmp3lame,
# opus via BSD libopus, AV1 decode via BSD dav1d, subtitle burn-in via libass (built
# above). Built shared, then dylibbundled. ffmpeg is MANDATORY: any failure here aborts
# the whole vendoring run, because a bundle without ffmpeg is not shippable.
build_lgpl_ffmpeg() {
  if [ -x "$VENDOR_DIR/ffmpeg" ] && [ -x "$VENDOR_DIR/ffprobe" ]; then
    ok "ffmpeg (cached)"; ok "ffprobe (cached)"; return 0
  fi
  local ver="7.1.1"
  local work="/tmp/ffmpeg-lgpl-build"
  local brew_prefix; brew_prefix="$(brew --prefix)"
  command -v nasm >/dev/null 2>&1 || brew install nasm >/dev/null 2>&1
  command -v pkg-config >/dev/null 2>&1 || brew install pkg-config >/dev/null 2>&1
  local dep
  for dep in lame opus dav1d; do
    brew list "$dep" >/dev/null 2>&1 || brew install "$dep" >/dev/null 2>&1
  done
  build_libass
  rm -rf "$work"; mkdir -p "$work"
  curl -fsSL -o "$work/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-${ver}.tar.xz" \
    || { echo "FATAL: ffmpeg source download failed" >&2; exit 1; }
  tar -xJf "$work/ffmpeg.tar.xz" -C "$work" --strip-components=1
  ( cd "$work" \
    && PKG_CONFIG_PATH="$ASS_PREFIX/lib/pkgconfig:$brew_prefix/lib/pkgconfig:$brew_prefix/share/pkgconfig" \
       ./configure --prefix="$work/out" \
         --disable-gpl --disable-nonfree --disable-doc --disable-static --enable-shared \
         --enable-videotoolbox --enable-audiotoolbox \
         --enable-libmp3lame --enable-libopus --enable-libdav1d --enable-libass \
         --extra-cflags="-I$brew_prefix/include -I$ASS_PREFIX/include" \
         --extra-ldflags="-L$brew_prefix/lib -L$ASS_PREFIX/lib" \
    && make -j"$(sysctl -n hw.ncpu)" \
    && make install ) >"$work/build.log" 2>&1
  if [ ! -x "$work/out/bin/ffmpeg" ] || [ ! -x "$work/out/bin/ffprobe" ]; then
    echo "FATAL: LGPL ffmpeg build failed; tail of $work/build.log:" >&2
    tail -25 "$work/build.log" >&2
    exit 1
  fi
  # Search both ffmpeg's own out/lib and libass's out/lib so dylibbundler vendors libass (and, via
  # the Homebrew lib default search, its freetype/fribidi/libpng deps) flat with @loader_path.
  EXTRA_SEARCH=("$work/out/lib" "$ASS_PREFIX/lib")
  bundle "$work/out/bin/ffmpeg" ffmpeg
  bundle "$work/out/bin/ffprobe" ffprobe
  EXTRA_SEARCH=()
}

log "Ensuring dylibbundler"
command -v dylibbundler >/dev/null 2>&1 || brew install dylibbundler >/dev/null 2>&1

# --- ffmpeg + ffprobe: mandatory, built LGPL from source (see build_lgpl_ffmpeg) ---
build_lgpl_ffmpeg

# --- yt-dlp: official self-contained macOS build (bundles its own Python) ---
if [ -x "$VENDOR_DIR/yt-dlp" ]; then
  ok "yt-dlp (cached)"
else
  log "Downloading yt-dlp"
  if curl -fsSL -o "$VENDOR_DIR/yt-dlp" \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"; then
    chmod +x "$VENDOR_DIR/yt-dlp"
    ok "yt-dlp"
  else
    fail "yt-dlp" "download failed"
  fi
fi

# dylibbundler invalidated each binary's signature when it rewrote install names, and an
# unsigned Mach-O is killed on exec on Apple Silicon — so (re)sign before the tools are used.
# Ad-hoc by default; publish-bundled-tools.sh sets a Developer ID identity for releases.
log "Signing"
"$SCRIPT_DIR/sign-bundled-tools.sh" "$VENDOR_DIR"

# Guard: the bundled ffmpeg MUST carry the libass `subtitles` filter (subtitle burn-in), in
# every channel — dev, nightly, release all install this same vendored bundle. A future edit
# that drops --enable-libass (or a libass build break) would silently cripple every caption
# workflow, so verify the now-signed binary and fail the whole run loudly rather than ship it.
if [ -x "$VENDOR_DIR/ffmpeg" ]; then
  out=$(mktemp)
  err=$(mktemp)
  if "$VENDOR_DIR/ffmpeg" -hide_banner -filters > "$out" 2> "$err"; then
    if grep -qw subtitles "$out"; then
      ok "ffmpeg libass(subtitles) verified"
    else
      echo "FATAL: bundled ffmpeg lacks the libass 'subtitles' filter (subtitle burn-in)." >&2
      echo "       It must be built with --enable-libass; see build_libass/build_lgpl_ffmpeg." >&2
      rm -f "$out" "$err"
      exit 1
    fi
  else
    exit_code=$?
    echo "FATAL: bundled ffmpeg failed to execute (exit code: $exit_code)." >&2
    echo "       Stderr output:" >&2
    cat "$err" >&2
    rm -f "$out" "$err"
    exit 1
  fi
  rm -f "$out" "$err"
fi

log "Summary"
printf '%s\n' "${STATUS[@]}"
echo
echo "Vendored into: $VENDOR_DIR"
