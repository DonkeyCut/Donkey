#!/usr/bin/env bash
# Ships the iOS app to TestFlight: archives apps/ios and uploads the build to
# App Store Connect. Requires Xcode 26+ with the team signed in (Xcode →
# Settings → Accounts). Signing stays automatic; Xcode manages the build
# number against App Store Connect so repeat uploads never collide.
#
# Auth uses the Apple ID session stored by Xcode. To run unattended (CI),
# provide an App Store Connect API key instead:
#   DONKEY_ASC_KEY_P8_PATH=/path/AuthKey_XXXX.p8
#   DONKEY_ASC_KEY_ID=XXXX
#   DONKEY_ASC_ISSUER_ID=uuid
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

ARCHIVE="$ROOT/dist/DonkeyIOS.xcarchive"
EXPORT_PLIST="$(mktemp -t donkey-ios-export.XXXXXX).plist"
trap 'rm -f "$EXPORT_PLIST"' EXIT

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
  -project "$ROOT/apps/ios/Donkey.xcodeproj" \
  -scheme Donkey \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"} \
  -quiet

echo "==> Uploading to App Store Connect"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates \
  ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}

echo "==> Uploaded. The build appears in App Store Connect → TestFlight after processing."
