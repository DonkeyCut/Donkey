#!/usr/bin/env bash
# Ships the iOS app to TestFlight: archives apps/ios and uploads the build to
# App Store Connect. Requires Xcode 26+ with the team signed in (Xcode →
# Settings → Accounts). Signing stays automatic; Xcode manages the build
# number against App Store Connect so repeat uploads never collide.
#
#   scripts/ship-ios-testflight.sh [--ref <git-ref>] [--working-tree]
#                                  [--no-distribute]
#
# A TestFlight build has to be reproducible, so the archive is cut from a
# committed tree: the script checks the ref out into its own worktree under
# dist/ and builds there, and uncommitted edits elsewhere in the repo stay out
# of it. --working-tree archives the checkout as it stands instead, for trying
# a build before committing it.
#
# Auth uses the Apple ID session stored by Xcode. To run unattended (CI),
# provide an App Store Connect API key instead:
#   DONKEY_ASC_KEY_P8_PATH=/path/AuthKey_XXXX.p8
#   DONKEY_ASC_KEY_ID=XXXX
#   DONKEY_ASC_ISSUER_ID=uuid
#
# With that key present the ship also hands the build to the external testers:
# scripts/asc-distribute.mjs runs on after processing finishes, adds the build
# to every external group, and submits it for beta review. --no-distribute
# leaves the build for App Store Connect.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

# Build inputs git does not carry. The archive needs them copied into the
# checkout it builds from, or the app builds without its deployment ids.
LOCAL_INPUTS=(apps/ios/Config/Donkey.local.xcconfig)

REF="HEAD"
WORKING_TREE=0
DISTRIBUTE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a git ref}"; shift 2 ;;
    --working-tree) WORKING_TREE=1; shift ;;
    --no-distribute) DISTRIBUTE=0; shift ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

ARCHIVE="$ROOT/dist/DonkeyIOS.xcarchive"
# One path for every ship, so Xcode's derived data stays warm between them.
SOURCE="$ROOT/dist/ios-src"
DERIVED="$ROOT/dist/ios-derived"
EXPORT_PLIST="$(mktemp -t donkey-ios-export.XXXXXX).plist"
CHECKED_OUT=0

cleanup() {
  rm -f "$EXPORT_PLIST"
  if (( CHECKED_OUT )); then
    git -C "$ROOT" worktree remove --force "$SOURCE" >/dev/null 2>&1 || rm -rf "$SOURCE"
    git -C "$ROOT" worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if (( WORKING_TREE )); then
  BUILD_ROOT="$ROOT"
  echo "==> Building the working tree"
else
  SHA="$(git -C "$ROOT" rev-parse --verify "$REF^{commit}")"
  echo "==> Building $(git -C "$ROOT" log -1 --format='%h %s' "$SHA")"
  rm -rf "$SOURCE"
  git -C "$ROOT" worktree prune
  git -C "$ROOT" worktree add --detach --quiet "$SOURCE" "$SHA"
  CHECKED_OUT=1
  for input in "${LOCAL_INPUTS[@]}"; do
    [[ -f "$ROOT/$input" ]] && cp "$ROOT/$input" "$SOURCE/$input"
  done
  BUILD_ROOT="$SOURCE"
fi

cat > "$EXPORT_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<true/>
</dict>
</plist>
PLIST

AUTH_ARGS=()
if [[ -n "${DONKEY_ASC_KEY_P8_PATH:-}" ]]; then
  AUTH_ARGS=(
    -authenticationKeyPath "$DONKEY_ASC_KEY_P8_PATH"
    -authenticationKeyID "$DONKEY_ASC_KEY_ID"
    -authenticationKeyIssuerID "$DONKEY_ASC_ISSUER_ID"
  )
fi

echo "==> Archiving"
rm -rf "$ARCHIVE"
xcodebuild archive \
  -project "$BUILD_ROOT/apps/ios/Donkey.xcodeproj" \
  -scheme Donkey \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  -quiet

echo "==> Uploading to App Store Connect"
UPLOAD_START="$(date +%s)"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}

echo "==> Uploaded. The build appears in App Store Connect → TestFlight after processing."

# Processing runs for minutes after the upload returns, so handing the build to
# the testers happens on its own clock: the ship ends here and the distributor
# keeps polling in the background.
if (( DISTRIBUTE )); then
  if [[ -n "${DONKEY_ASC_KEY_P8_PATH:-}" ]] || compgen -G "$HOME/.appstoreconnect/private_keys/AuthKey_*.p8" >/dev/null; then
    DIST_LOG="$ROOT/dist/asc-distribute.log"
    nohup node "$ROOT/scripts/asc-distribute.mjs" \
      --uploaded-after "$UPLOAD_START" >"$DIST_LOG" 2>&1 &
    echo "==> Handing the build to the external testers in the background ($DIST_LOG)"
  else
    echo "==> No App Store Connect API key; the build waits for a manual release." >&2
    echo "    Add one (Users and Access → Integrations) to distribute every ship." >&2
  fi
fi
