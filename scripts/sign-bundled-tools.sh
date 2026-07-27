#!/usr/bin/env bash
#
# Code-signs every Mach-O in a bundled-tools directory (the binaries + their @loader_path dylibs).
# REQUIRED, not cosmetic: dylibbundler rewrites install names, which invalidates any existing signature,
# and the Apple Silicon kernel kills an unsigned/invalidly-signed Mach-O on exec. So the vendored tools
# must be (re)signed or they won't run on the user's Mac.
#
# Identity comes from DONKEY_TOOLS_SIGN_IDENTITY:
#   "-" (default)         ad-hoc — runs locally and on any arm64 Mac for non-quarantined files (dev).
#   "Developer ID ..."    real identity + hardened runtime + secure timestamp (production); pair with
#                         notarization (see publish-bundled-tools.sh) for distribution.
#
# Usage: scripts/sign-bundled-tools.sh [vendor-dir]   (default: vendor/donkey-tools)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="${1:-$ROOT_DIR/vendor/donkey-tools}"
IDENTITY="${DONKEY_TOOLS_SIGN_IDENTITY:--}"

if [ ! -d "$VENDOR_DIR" ]; then
  echo "sign-bundled-tools: $VENDOR_DIR does not exist" >&2
  exit 1
fi

sign_opts=(--force --sign "$IDENTITY")
real_identity=false
if [ "$IDENTITY" != "-" ]; then
  # Hardened runtime + secure timestamp are required for notarization to accept the binaries.
  sign_opts+=(--options runtime --timestamp)
  real_identity=true
fi
# Target the signing keychain explicitly when the caller points us at one: in CI the keychain is
# imported in a separate step and the search-list state doesn't dependably reach codesign here.
[ -n "${DONKEY_SIGN_KEYCHAIN:-}" ] && sign_opts+=(--keychain "$DONKEY_SIGN_KEYCHAIN")

# A PyInstaller onefile tool (yt-dlp) unpacks a private Python.framework to a temp dir at launch and
# dlopen()s it. Under the hardened runtime, library validation rejects that load ("mapping process and
# mapped file have different Team IDs") because the extracted framework isn't signed by our Team. The
# library-validation exception is the supported fix, scoped to exactly the executables that need it: every
# other bundled tool is self-contained or loads only the sibling dylibs we re-sign below (same Team ID, so
# validation passes), and keeps the hardened runtime fully enforced. Verified by signing each tool without
# the exception and launching it — only yt-dlp fails. Add a name here if a future bundled tool self-extracts
# a foreign-signed library. Entitlements belong on the executable that spawns the process, never on dylibs.
needs_library_validation_exception() {
  case "$(basename "$1")" in
    yt-dlp) return 0 ;;
    *) return 1 ;;
  esac
}
ENTITLEMENTS="$(mktemp -t donkey-tools-entitlements)"
trap 'rm -f "$ENTITLEMENTS"' EXIT
cat > "$ENTITLEMENTS" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
PLIST

is_macho() { file -b "$1" 2>/dev/null | grep -q "Mach-O"; }

# A signing failure under a real identity must abort (an unsigned prod binary is a broken release); under
# ad-hoc it's tolerated so a non-Mach-O file is simply skipped. Extra
# codesign args after the file (e.g. --entitlements for executables) are passed through.
sign_one() {
  local f="$1"; shift
  is_macho "$f" || return 0
  
  # To avoid the macOS kernel code-signing cache bug (Killed: 9 / transient verification failures
  # when running an in-place re-signed binary), we copy the file to a temporary location,
  # sign it there, and move it back. This guarantees a fresh inode and clears any stale kernel cache.
  local tmpf
  tmpf="$(mktemp "$(dirname "$f")/$(basename "$f").XXXXXX")"
  cp -p "$f" "$tmpf"
  if codesign "${sign_opts[@]}" "$@" "$tmpf" >/dev/null 2>&1; then
    mv -f "$tmpf" "$f"
    return 0
  else
    rm -f "$tmpf"
    if $real_identity; then
      echo "FATAL: failed to sign $f with '$IDENTITY'" >&2
      exit 1
    fi
  fi
}

# Inside-out: dylibs (the dependencies) before the executables that load them. Dylibs carry no
# entitlements; an executable gets the library-validation exception only if it self-extracts a
# foreign-signed library (see needs_library_validation_exception).
while IFS= read -r -d '' f; do sign_one "$f"; done \
  < <(find "$VENDOR_DIR" -type f -name "*.dylib" -print0)
while IFS= read -r -d '' f; do
  case "$f" in *.dylib) continue ;; esac
  if needs_library_validation_exception "$f"; then
    sign_one "$f" --entitlements "$ENTITLEMENTS"
  else
    sign_one "$f"
  fi
done < <(find "$VENDOR_DIR" -maxdepth 1 -type f -perm -u+x -print0)

if $real_identity; then
  echo "Signed bundled tools in $VENDOR_DIR with '$IDENTITY' (hardened runtime)."
else
  echo "Ad-hoc signed bundled tools in $VENDOR_DIR."
fi
