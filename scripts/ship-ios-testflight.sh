#!/usr/bin/env bash
# Ships the iOS app to TestFlight: archives apps/ios and uploads the build to
# App Store Connect. Requires Xcode 26+ with the team signed in (Xcode →
# Settings → Accounts). Signing stays automatic; Xcode manages the build
# number against App Store Connect so repeat uploads never collide.
#
#   scripts/ship-ios-testflight.sh [--ref <git-ref>] [--working-tree]
#
# A TestFlight build has to be reproducible, so the archive is cut from a
# committed tree: the script checks the ref out into its own worktree under
# dist/ and builds there, and uncommitted edits elsewhere in the repo stay out
# of it. --working-tree archives the checkout as it stands instead, for trying
# a build before committing it.
#
# The upload lands the build in App Store Connect → TestFlight. Internal
# testers get it once processing finishes; releasing it to external groups is
# done in App Store Connect.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

# Build inputs git does not carry. The archive needs them copied into the
# checkout it builds from, or the app builds without its deployment ids.
LOCAL_INPUTS=(apps/ios/Config/Donkey.local.xcconfig)

REF="HEAD"
WORKING_TREE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a git ref}"; shift 2 ;;
    --working-tree) WORKING_TREE=1; shift ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# The model tests hold the phone to the site's contracts (the analytics
# rollup fixture among them), so every build that ships reads what the
# server serves.
echo "==> Testing DonkeyKit"
swift test --package-path "$BUILD_ROOT/apps/ios/DonkeyKit" --scratch-path "$ROOT/dist/ios-kit-build" --quiet

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
  -quiet

echo "==> Uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates

echo "==> Uploaded. The build appears in App Store Connect → TestFlight after processing."
