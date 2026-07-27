#!/usr/bin/env bash
#
# Builds the prebuilt CLI tools bundle (ffmpeg, yt-dlp, ...) from source and publishes it as a GitHub
# release asset, then rewrites bundled-tools.json (version, url, sha256) so the shipped app and the dev
# script fetch the new bundle. This is the ONE place the heavy source build runs — end users and dev
# machines only ever download the result.
#
# Run on an arm64 macOS build machine with Homebrew + Xcode and an authenticated `gh`. Usage:
#   scripts/publish-bundled-tools.sh [version]   # version defaults to today's date (YYYY.MM.DD)
#
# Published assets are IMMUTABLE: once a version's tarball exists on its release, that version is frozen,
# because a shipped app pins it by sha256 and could never re-verify different bytes. If the chosen version
# already has a published asset, this auto-bumps to <version>.1, .2, … rather than clobbering it — so a
# same-day re-publish becomes a new version. After it finishes, commit the updated bundled-tools.json so
# the app ships pointing at the new asset.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor/donkey-tools"
MANIFEST="$ROOT_DIR/apps/Donkey/Sources/DonkeyRuntime/Resources/bundled-tools.json"

REPO="${DONKEY_TOOLS_REPO:-DonkeyUseCorp/Donkey}"
ARCH="arm64"

# True when that release already carries that asset — i.e. the version is already published and frozen.
asset_published() { # tag asset-name
  gh release view "$1" --repo "$REPO" --json assets --jq '.assets[].name' 2>/dev/null | grep -qx "$2"
}

# Pick the first version at or after the requested one whose asset is not already published, so we never
# overwrite frozen bytes. Bumps <base> -> <base>.1 -> <base>.2 … (matching the existing .N convention).
choose_immutable_version() {
  local base="$1" v="$1" n=1
  while asset_published "bundled-tools-$v" "donkey-tools-$v-$ARCH.tar.gz"; do
    v="$base.$n"; n=$((n + 1))
  done
  [ "$v" = "$base" ] || echo "Version $base already published; using $v to keep bundles immutable." >&2
  printf '%s' "$v"
}

VERSION="$(choose_immutable_version "${1:-$(date +%Y.%m.%d)}")"
TAG="bundled-tools-$VERSION"
ASSET="donkey-tools-$VERSION-$ARCH.tar.gz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
OUT="/tmp/$ASSET"

MANDATORY_TOOLS=(ffmpeg ffprobe yt-dlp)

echo "==> Building tools from source (idempotent; skips already-built)"
"$SCRIPT_DIR/fetch-bundled-tools.sh"

for t in "${MANDATORY_TOOLS[@]}"; do
  [ -x "$VENDOR_DIR/$t" ] || { echo "FATAL: $t missing from $VENDOR_DIR after build" >&2; exit 1; }
done

# Developer ID signing happened inside the build (fetch-bundled-tools.sh runs sign-bundled-tools.sh with
# whatever DONKEY_TOOLS_SIGN_IDENTITY is set). Notarize those signed binaries so Apple validates them and
# Gatekeeper trusts them. Bare CLI binaries can't be stapled (only .app/.dmg/.pkg can), so Gatekeeper does
# an online check; for the app-downloaded, un-quarantined tools the Developer ID signature is what counts,
# and notarization is the proof that signature is good. Skipped (with a warning) when only ad-hoc signed.
notarize_bundle() {
  if [ "${DONKEY_TOOLS_SIGN_IDENTITY:--}" = "-" ]; then
    echo "Warning: tools are only ad-hoc signed (no DONKEY_TOOLS_SIGN_IDENTITY); NOT for public distribution." >&2
    return 0
  fi
  local zip="$RUNNER_TEMP_DIR/donkey-tools-notarize.zip"
  rm -f "$zip"
  /usr/bin/ditto -c -k --keepParent "$VENDOR_DIR" "$zip"
  if [ -f "${DONKEY_NOTARY_KEY_P8:-/nonexistent}" ] && [ -n "${DONKEY_NOTARY_KEY_ID:-}" ] && [ -n "${DONKEY_NOTARY_ISSUER_ID:-}" ]; then
    echo "==> Notarizing with App Store Connect API key"
    xcrun notarytool submit "$zip" \
      --key "$DONKEY_NOTARY_KEY_P8" --key-id "$DONKEY_NOTARY_KEY_ID" --issuer "$DONKEY_NOTARY_ISSUER_ID" --wait
  elif [ -n "${DONKEY_NOTARY_PROFILE:-}" ]; then
    echo "==> Notarizing with keychain profile $DONKEY_NOTARY_PROFILE"
    xcrun notarytool submit "$zip" --keychain-profile "$DONKEY_NOTARY_PROFILE" --wait
  elif [ -n "${DONKEY_NOTARY_APPLE_ID:-}" ] && [ -n "${DONKEY_NOTARY_TEAM_ID:-}" ] && [ -n "${DONKEY_NOTARY_PASSWORD:-}" ]; then
    echo "==> Notarizing with Apple ID $DONKEY_NOTARY_APPLE_ID"
    xcrun notarytool submit "$zip" \
      --apple-id "$DONKEY_NOTARY_APPLE_ID" --team-id "$DONKEY_NOTARY_TEAM_ID" --password "$DONKEY_NOTARY_PASSWORD" --wait
  else
    echo "FATAL: DONKEY_TOOLS_SIGN_IDENTITY is set but no notary credentials were provided." >&2
    exit 1
  fi
  rm -f "$zip"
}

RUNNER_TEMP_DIR="${RUNNER_TEMP:-/tmp}"
notarize_bundle

echo "==> Packaging $ASSET (bundle contents at archive root)"
rm -f "$OUT"
tar -czf "$OUT" -C "$VENDOR_DIR" .
SHA="$(shasum -a 256 "$OUT" | awk '{print $1}')"
echo "    size=$(du -h "$OUT" | awk '{print $1}')  sha256=$SHA"

echo "==> Updating $MANIFEST"
python3 - "$MANIFEST" "$VERSION" "$ARCH" "$URL" "$SHA" <<'PY'
import json, sys
path, version, arch, url, sha = sys.argv[1:6]
m = json.load(open(path))
m["version"] = version
m["arch"] = arch
m["url"] = url
m["sha256"] = sha
with open(path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
PY

echo "==> Publishing to GitHub release $TAG ($REPO)"
if ! gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release create "$TAG" --repo "$REPO" --title "$TAG" \
    --notes "Prebuilt Donkey CLI tools ($ARCH) — $VERSION."
fi
# No --clobber: choose_immutable_version guaranteed this asset isn't published yet, so this only ever
# uploads fresh bytes and never overwrites a version a shipped app already pinned.
gh release upload "$TAG" "$OUT" --repo "$REPO"

echo
echo "Published $ASSET → $URL"
echo "Now commit the updated $MANIFEST so the app ships pointing at this bundle."
