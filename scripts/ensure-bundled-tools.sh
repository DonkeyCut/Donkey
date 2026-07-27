#!/usr/bin/env bash
#
# Guarantees vendor/donkey-tools/ holds the command-line tools the Cut engine runs by
# bare name (ffmpeg, ffprobe, yt-dlp). The dev run script and app packaging both call
# this, so the tools are present without a manual step.
#
# Strategy: prefer the published prebuilt bundle named in bundled-tools.json (a fast
# download, the same artifact the shipped app carries). If nothing is
# published yet, or the download/checksum fails, fall back to building from source via
# fetch-bundled-tools.sh. Either way, fail loudly if any tool is still missing rather
# than letting a build ship an app without the media/pdf capabilities.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="${DONKEY_TOOLS_DIR:-$ROOT_DIR/vendor/donkey-tools}"
MANIFEST="$ROOT_DIR/apps/Donkey/Sources/DonkeyRuntime/Resources/bundled-tools.json"

# Every tool the app ships. All of them are required: they travel inside the app, so a
# build that can't stage one would ship a capability that silently doesn't work on a
# machine that happens not to have it. Scoped to the Donkey Cut video editor —
# ffmpeg/ffprobe (export, probe, frame extract) and yt-dlp (URL import). Keep in sync
# with fetch-bundled-tools.sh and BundledTools.swift — the Swift list is checked
# against this one by BundledToolsTests.
REQUIRED_TOOLS=(ffmpeg ffprobe yt-dlp)

# `--list` prints the required set, one per line, so packaging verifies the baked copy
# against this single source of truth instead of keeping its own list.
if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${REQUIRED_TOOLS[@]}"
  exit 0
fi

missing_of() {
  local t out=()
  for t in "$@"; do
    [ -x "$VENDOR_DIR/$t" ] || out+=("$t")
  done
  printf '%s\n' "${out[@]:-}"
}


manifest_value() {
  [ -f "$MANIFEST" ] || return 1
  python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],''))" "$MANIFEST" "$1" 2>/dev/null
}

# Download + verify + extract the published prebuilt bundle into VENDOR_DIR. Returns
# non-zero (so the caller falls back to a source build) when nothing is published yet.
download_prebuilt() {
  local url sha
  url="$(manifest_value url || true)"
  sha="$(manifest_value sha256 || true)"
  if [ -z "$sha" ] || [ -z "$url" ]; then
    echo "No published tools bundle yet (bundled-tools.json has no sha256)."
    return 1
  fi
  local tmp stage got root
  tmp="$(mktemp)"; stage="$(mktemp -d)"
  echo "Downloading prebuilt tools: $url"
  if ! curl -fsSL -o "$tmp" "$url"; then
    echo "Download failed." >&2; rm -rf "$tmp" "$stage"; return 1
  fi
  got="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  if [ "$got" != "$sha" ]; then
    echo "Checksum mismatch (expected $sha, got $got)." >&2; rm -rf "$tmp" "$stage"; return 1
  fi
  if ! tar -xzf "$tmp" -C "$stage"; then
    echo "Extract failed." >&2; rm -rf "$tmp" "$stage"; return 1
  fi
  # The tarball may be flat (ffmpeg at the root) or wrapped in a top-level dir.
  root="$stage"
  [ -x "$stage/ffmpeg" ] || root="$(find "$stage" -maxdepth 2 -name ffmpeg -type f -exec dirname {} \; | head -1)"
  if [ -z "$root" ] || [ ! -x "$root/ffmpeg" ]; then
    echo "Archive did not contain ffmpeg." >&2; rm -rf "$tmp" "$stage"; return 1
  fi
  rm -rf "$VENDOR_DIR"; mkdir -p "$(dirname "$VENDOR_DIR")"; mv "$root" "$VENDOR_DIR"
  rm -rf "$tmp" "$stage"
  echo "Installed prebuilt tools into $VENDOR_DIR."
}

# A custom DONKEY_TOOLS_DIR is a caller-supplied prebuilt set: validate what's present and NEVER build into
# it (nor rebuild for source-change reasons — the prebuilt binaries are authoritative). A complete set is
# done; only a genuinely missing tool fails, with the real list rather than an empty one.
if [ -n "${DONKEY_TOOLS_DIR:-}" ]; then
  missing="$(missing_of "${REQUIRED_TOOLS[@]}" | grep -v '^$' | tr '\n' ' ' | xargs)"
  if [ -n "$missing" ]; then
    echo "ERROR: DONKEY_TOOLS_DIR=$VENDOR_DIR is missing required tools: $missing" >&2
    exit 1
  fi
  echo "Bundled tools present in $VENDOR_DIR (DONKEY_TOOLS_DIR)"
  exit 0
fi

required_missing=$(missing_of "${REQUIRED_TOOLS[@]}" | grep -c .)
if [ "$required_missing" -eq 0 ]; then
  echo "Bundled tools present in $VENDOR_DIR"
  exit 0
fi

# Every bundled tool is now third-party and prebuilt, so the published bundle is always the right
# first move; a source build is the fallback for when nothing is published or the download fails.
if ! download_prebuilt; then
  echo "Building tools from source (one-time; ffmpeg builds from source and can take several minutes)..."
  "$SCRIPT_DIR/fetch-bundled-tools.sh" || true
fi


# A published prebuilt bundle can predate a newly added tool (e.g. a first-party CLI added to
# the scripts before the next republish). Rather than hard-fail, build just the missing ones
# from source — fetch-bundled-tools.sh skips anything already present in VENDOR_DIR.
still_missing=$(missing_of "${REQUIRED_TOOLS[@]}" | grep -v '^$' || true)
if [ -n "$still_missing" ]; then
  echo "Prebuilt bundle missing: $(echo "$still_missing" | tr '\n' ' ')— building those from source..."
  "$SCRIPT_DIR/fetch-bundled-tools.sh" || true
  still_missing=$(missing_of "${REQUIRED_TOOLS[@]}" | grep -v '^$' || true)
fi
if [ -n "$still_missing" ]; then
  echo "ERROR: bundled tools still missing after install: $(echo "$still_missing" | tr '\n' ' ')" >&2
  echo "       Source build needs Homebrew + network; fix that and re-run." >&2
  exit 1
fi
echo "Bundled tools ready in $VENDOR_DIR"
