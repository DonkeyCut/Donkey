#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/dist/Donkey.app"
DMG_PATH="$ROOT_DIR/dist/Donkey.dmg"
DMG_RW_PATH="$ROOT_DIR/dist/Donkey-rw.dmg"
DMG_ROOT="$ROOT_DIR/dist/DonkeyInstaller"
RUNTIME_PACKAGE_DIR="$ROOT_DIR/dist/LocalRuntimePackages"
APP_VERSION="${DONKEY_APP_VERSION:-0.1.0}"
APP_BUILD="${DONKEY_APP_BUILD:-1}"
SPARKLE_FEED_URL="${DONKEY_SPARKLE_FEED_URL:-}"
SPARKLE_PUBLIC_ED_KEY="${DONKEY_SPARKLE_PUBLIC_ED_KEY:-}"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
BUILD_DIR="$ROOT_DIR/apps/Donkey"
EXECUTABLE="$BUILD_DIR/.build/release/Donkey"
CACHE_DIR="$BUILD_DIR/.build/package-cache"
APP_ICON_SOURCE="$BUILD_DIR/Sources/Donkey/Resources/Donkey.icns"
APP_ICONSET_SOURCE="$BUILD_DIR/Sources/Donkey/Resources/Donkey.iconset"
DMG_BACKGROUND_SOURCE="$ROOT_DIR/scripts/assets/donkey-dmg-background.svg"
DMG_BACKGROUND_RENDERED="$ROOT_DIR/dist/donkey-dmg-background.png"
DMG_WINDOW_WIDTH=760
DMG_WINDOW_HEIGHT=480
DMG_WINDOW_LEFT=160
DMG_WINDOW_TOP=120
DMG_WINDOW_RIGHT=$((DMG_WINDOW_LEFT + DMG_WINDOW_WIDTH))
DMG_WINDOW_BOTTOM=$((DMG_WINDOW_TOP + DMG_WINDOW_HEIGHT))
DMG_APP_ICON_X=220
DMG_APP_ICON_Y=225
DMG_APPLICATIONS_ICON_X=540
DMG_APPLICATIONS_ICON_Y=225

render_dmg_background() {
  if [ ! -f "$DMG_BACKGROUND_SOURCE" ]; then
    echo "Missing DMG background image: $DMG_BACKGROUND_SOURCE" >&2
    exit 1
  fi
  if ! command -v magick >/dev/null 2>&1; then
    echo "ImageMagick is required to render $DMG_BACKGROUND_SOURCE for the Finder installer background." >&2
    exit 1
  fi

  mkdir -p "$(dirname "$DMG_BACKGROUND_RENDERED")"
  magick "$DMG_BACKGROUND_SOURCE" "PNG24:$DMG_BACKGROUND_RENDERED"
}

set_dmg_volume_icon() {
  local volume_dir="$1"
  local volume_icon_source="$RESOURCES_DIR/Donkey.icns"

  if [ -f "$volume_icon_source" ]; then
    cp "$volume_icon_source" "$volume_dir/.VolumeIcon.icns"
    SetFile -t icns -c icnC "$volume_dir/.VolumeIcon.icns"
    SetFile -a V "$volume_dir/.VolumeIcon.icns"
    SetFile -a C "$volume_dir"
  fi
}

prepare_app_icon() {
  local destination="$RESOURCES_DIR/Donkey.icns"

  if [ -d "$APP_ICONSET_SOURCE" ]; then
    if ! command -v iconutil >/dev/null 2>&1; then
      echo "iconutil is required to package Donkey.app from $APP_ICONSET_SOURCE." >&2
      exit 1
    fi
    iconutil --convert icns --output "$destination" "$APP_ICONSET_SOURCE"
    return
  fi

  if [ -f "$APP_ICON_SOURCE" ]; then
    cp "$APP_ICON_SOURCE" "$destination"
    return
  fi

  echo "Missing app icon sources: $APP_ICONSET_SOURCE or $APP_ICON_SOURCE" >&2
  exit 1
}

configure_dmg_window() {
  local mount_dir="$1"

  SetFile -a V "$mount_dir/.background" >/dev/null 2>&1 || true

  osascript <<APPLESCRIPT
tell application "Finder"
  set mountedFolder to POSIX file "$mount_dir" as alias
  set backgroundFile to POSIX file "$mount_dir/.background/donkey-dmg-background.png" as alias
  open mountedFolder
  delay 0.2
  set installerWindow to front Finder window
  set current view of installerWindow to icon view
  try
    set toolbar visible of installerWindow to false
  end try
  try
    set statusbar visible of installerWindow to false
  end try
  set bounds of installerWindow to {$DMG_WINDOW_LEFT, $DMG_WINDOW_TOP, $DMG_WINDOW_RIGHT, $DMG_WINDOW_BOTTOM}
  set theViewOptions to icon view options of installerWindow
  set arrangement of theViewOptions to not arranged
  set icon size of theViewOptions to 144
  set background picture of theViewOptions to backgroundFile
  set position of item "Donkey.app" of installerWindow to {$DMG_APP_ICON_X, $DMG_APP_ICON_Y}
  set position of item "Applications" of installerWindow to {$DMG_APPLICATIONS_ICON_X, $DMG_APPLICATIONS_ICON_Y}
  update mountedFolder without registering applications
  delay 1
  close installerWindow
end tell
APPLESCRIPT

  set_dmg_volume_icon "$mount_dir"
}

create_drag_to_applications_dmg() {
  local mount_dir
  local mounted=0

  render_dmg_background

  mount_dir="$(mktemp -d "${TMPDIR:-/tmp}/donkey-dmg.XXXXXX")"
  detach_dmg_mount() {
    local detach_target="$1"
    local attempt

    sync
    for attempt in 1 2 3; do
      if hdiutil detach "$detach_target" >/dev/null 2>&1; then
        return 0
      fi
      sleep "$attempt"
      sync
    done

    hdiutil detach "$detach_target" -force >/dev/null
  }
  cleanup_dmg_mount() {
    trap - RETURN
    if [ "$mounted" = "1" ]; then
      detach_dmg_mount "$mount_dir" >/dev/null 2>&1 || true
    fi
    rm -rf "$mount_dir"
  }
  trap cleanup_dmg_mount RETURN

  rm -rf "$DMG_ROOT" "$DMG_PATH" "$DMG_RW_PATH"
  mkdir -p "$DMG_ROOT/.background"
  cp -R "$APP_DIR" "$DMG_ROOT/Donkey.app"
  ln -s /Applications "$DMG_ROOT/Applications"
  cp "$DMG_BACKGROUND_RENDERED" "$DMG_ROOT/.background/donkey-dmg-background.png"

  hdiutil create \
    -volname "Donkey" \
    -srcfolder "$DMG_ROOT" \
    -ov \
    -format UDRW \
    -fs HFS+ \
    "$DMG_RW_PATH" >/dev/null

  hdiutil attach "$DMG_RW_PATH" \
    -readwrite \
    -noverify \
    -noautoopen \
    -mountpoint "$mount_dir" >/dev/null
  mounted=1

  configure_dmg_window "$mount_dir"
  detach_dmg_mount "$mount_dir"
  mounted=0

  hdiutil convert "$DMG_RW_PATH" \
    -format UDZO \
    -imagekey zlib-level=9 \
    -o "$DMG_PATH" >/dev/null

  rm -rf "$DMG_ROOT" "$DMG_RW_PATH"
}

# --- Code signing + notarization ----------------------------------------------------------------
# DONKEY_APP_SIGN_IDENTITY selects how the app is signed:
#   "-" (default)        ad-hoc — runs locally, NOT distributable (the dev/local path).
#   "Developer ID ..."   real identity + hardened runtime + secure timestamp, then notarized + stapled
#                        (the release path; the release workflow imports the cert and sets this).
APP_SIGN_IDENTITY="${DONKEY_APP_SIGN_IDENTITY:--}"
APP_ENTITLEMENTS="${DONKEY_APP_ENTITLEMENTS:-$ROOT_DIR/scripts/assets/donkey.entitlements}"

# Submit an artifact (app zip or DMG) to Apple's notary service and wait for the verdict. notarytool
# exits non-zero if the bundle is rejected, so a bad signature fails the build here.
notarytool_submit() {
  local artifact="$1"
  if [ -f "${DONKEY_NOTARY_KEY_P8:-/nonexistent}" ] && [ -n "${DONKEY_NOTARY_KEY_ID:-}" ] && [ -n "${DONKEY_NOTARY_ISSUER_ID:-}" ]; then
    xcrun notarytool submit "$artifact" \
      --key "$DONKEY_NOTARY_KEY_P8" --key-id "$DONKEY_NOTARY_KEY_ID" --issuer "$DONKEY_NOTARY_ISSUER_ID" --wait
  elif [ -n "${DONKEY_NOTARY_APPLE_ID:-}" ] && [ -n "${DONKEY_NOTARY_TEAM_ID:-}" ] && [ -n "${DONKEY_NOTARY_PASSWORD:-}" ]; then
    xcrun notarytool submit "$artifact" \
      --apple-id "$DONKEY_NOTARY_APPLE_ID" --team-id "$DONKEY_NOTARY_TEAM_ID" --password "$DONKEY_NOTARY_PASSWORD" --wait
  else
    echo "FATAL: app signed with Developer ID but no notary credentials provided." >&2
    exit 1
  fi
}

# Sign the app bundle. Ad-hoc when no identity; otherwise Developer ID + hardened runtime, signed
# inside-out (Apple discourages --deep for notarization). Sparkle's nested XPC services and Updater.app
# are signed first, preserving their own (sandbox) entitlements, then the framework, then the app.
sign_app() {
  if [ "$APP_SIGN_IDENTITY" = "-" ]; then
    codesign --force --deep --sign - "$APP_DIR" >/dev/null
    echo "Ad-hoc signed $APP_DIR (not for distribution)."
    return 0
  fi
  local base=(--force --options runtime --timestamp --sign "$APP_SIGN_IDENTITY")
  # Target the signing keychain explicitly when the release workflow points us at one. Relying on the
  # user keychain search list is unreliable here: the keychain is imported in a separate CI step, and
  # that search-list state doesn't dependably reach codesign in this step (hence "no identity found"
  # even though the identity imported fine).
  [ -n "${DONKEY_SIGN_KEYCHAIN:-}" ] && base=(--keychain "$DONKEY_SIGN_KEYCHAIN" "${base[@]}")
  local sparkle="$FRAMEWORKS_DIR/Sparkle.framework"
  if [ -d "$sparkle" ]; then
    # Versions/Current keeps this agnostic to Sparkle's version letter.
    local cur="$sparkle/Versions/Current" item
    for item in \
      "$cur/XPCServices/Downloader.xpc" \
      "$cur/XPCServices/Installer.xpc" \
      "$cur/Autoupdate" \
      "$cur/Updater.app"; do
      [ -e "$item" ] && codesign "${base[@]}" --preserve-metadata=entitlements "$item"
    done
    codesign "${base[@]}" "$sparkle"
  fi
  local f
  while IFS= read -r -d '' f; do codesign "${base[@]}" "$f"; done \
    < <(find "$FRAMEWORKS_DIR" -type f -name "*.dylib" -print0 2>/dev/null)
  local ent=()
  [ -f "$APP_ENTITLEMENTS" ] && ent=(--entitlements "$APP_ENTITLEMENTS")
  codesign "${base[@]}" "${ent[@]}" "$APP_DIR"
  echo "Developer ID signed $APP_DIR with '$APP_SIGN_IDENTITY' (hardened runtime)."
}

# Notarize + staple the signed app so it launches cleanly (even offline) once dragged out of the DMG.
notarize_app() {
  [ "$APP_SIGN_IDENTITY" = "-" ] && return 0
  local zip="$ROOT_DIR/dist/Donkey-app-notarize.zip"
  rm -f "$zip"
  /usr/bin/ditto -c -k --keepParent "$APP_DIR" "$zip"
  echo "Notarizing the app ..."
  notarytool_submit "$zip"
  xcrun stapler staple "$APP_DIR"
  rm -f "$zip"
  echo "Notarized and stapled $APP_DIR."
}

# Sign, notarize, and staple the DMG itself (disk images can be stapled, unlike loose binaries), so it
# opens without a Gatekeeper prompt.
notarize_dmg() {
  [ "$APP_SIGN_IDENTITY" = "-" ] && return 0
  local dmg_sign=(--force --timestamp --sign "$APP_SIGN_IDENTITY")
  [ -n "${DONKEY_SIGN_KEYCHAIN:-}" ] && dmg_sign=(--keychain "$DONKEY_SIGN_KEYCHAIN" "${dmg_sign[@]}")
  codesign "${dmg_sign[@]}" "$DMG_PATH"
  echo "Notarizing the disk image ..."
  notarytool_submit "$DMG_PATH"
  xcrun stapler staple "$DMG_PATH"
  echo "Notarized and stapled $DMG_PATH."
}

mkdir -p "$CACHE_DIR/clang" "$CACHE_DIR/swiftpm" "$CACHE_DIR/home"
export CLANG_MODULE_CACHE_PATH="$CACHE_DIR/clang"
export SWIFTPM_CACHE_PATH="$CACHE_DIR/swiftpm"
export HOME="$CACHE_DIR/home"

# Overriding HOME (above) repoints the per-user keychain search list to $HOME/Library/Preferences, which
# hides the search list the release workflow configured under the runner's real HOME — so codesign would
# report "no identity found" even with --keychain and an unlocked keychain. Re-register the signing
# keychain under this HOME so codesign can resolve the Developer ID identity. Keychain unlock state is
# global to securityd, so no password is needed here; only the search list is HOME-scoped.
if [ -n "${DONKEY_SIGN_KEYCHAIN:-}" ]; then
  mkdir -p "$HOME/Library/Preferences"
  security list-keychains -d user -s "$DONKEY_SIGN_KEYCHAIN" $(security list-keychains -d user | sed -e 's/"//g')
  security default-keychain -d user -s "$DONKEY_SIGN_KEYCHAIN"
fi

cd "$BUILD_DIR"
echo "Compiling Donkey for Mac ..."
swift build -c release --product Donkey

# The bundled command-line tools (ffmpeg, ffprobe, yt-dlp) ship INSIDE the app.
# The Cut engine runs them by bare name off PATH, so a copy that
# travels with the binary is what makes an export or a download work on a machine that never
# had them — nothing to fetch on first run, nothing to race, nothing to retry offline.
#
# scripts/ensure-bundled-tools.sh produces the directory (downloading the prebuilt bundle named
# in bundled-tools.json, or building from source). Point DONKEY_TOOLS_DIR at a prebuilt set to
# use that instead.
# Bring along every dylib the staged tools load, transitively. fetch-bundled-tools.sh rewrites each
# binary's install names to @loader_path/<name> and lays the libraries flat beside it, so a dependency
# is normally just a file name in the source dir. Walking from the tools (rather than copying every
# dylib) drops the libraries that belonged only to tools this build no longer ships.
#
# @rpath and absolute paths are matched by base name too: a published bundle laid out differently, or a
# tool linked against an @rpath entry, would otherwise be skipped silently. Anything genuinely absent
# from the source dir (a system library under /usr/lib) has no basename match and is left alone, which
# is correct — the OS provides it. `verify_staged_tools` is the backstop for whatever this misses.
copy_tool_dylibs() {
  local source_dir="$1" dest_dir="$2" binary dep name added=1
  # A copied library can pull in more, so sweep to a fixed point. Iterative rather than recursive:
  # recursing per dependency overflows bash's stack on a dependency set the size of ffmpeg's.
  while [ "$added" -eq 1 ]; do
    added=0
    for binary in "$dest_dir"/*; do
      [ -f "$binary" ] || continue
      while IFS= read -r dep; do
        name="${dep##*/}"
        [ -n "$name" ] || continue
        [ -e "$dest_dir/$name" ] && continue
        [ -e "$source_dir/$name" ] || continue
        cp "$source_dir/$name" "$dest_dir/$name"
        added=1
      done < <(otool -L "$binary" 2>/dev/null | awk 'NR>1 {print $1}')
    done
  done
}

# Run each staged tool. The executable bit says nothing about whether its libraries came along, so a
# dependency the walk missed would otherwise sail through packaging, signing, and notarization and only
# fail on the user's Mac with a dyld error. Every bundled tool answers a version flag, so launching one
# is a cheap end-to-end proof that it and its dylibs are really there. ffmpeg/ffprobe take `-version`
# and yt-dlp takes `--version`, so accept either rather than keeping a per-tool flag table.
verify_staged_tools() {
  local dest_dir="$1" tool
  while IFS= read -r tool; do
    if "$dest_dir/$tool" -version >/dev/null 2>&1 || "$dest_dir/$tool" --version >/dev/null 2>&1; then
      continue
    fi
    echo "Staged tool '$tool' will not run from $dest_dir (missing dylib or bad signature)." >&2
    "$dest_dir/$tool" -version || true
    exit 1
  done < <(bash "$ROOT_DIR/scripts/ensure-bundled-tools.sh" --list)
}

stage_bundled_tools() {
  # ensure-bundled-tools.sh either populates vendor/donkey-tools or, with DONKEY_TOOLS_DIR
  # set, validates the caller-supplied set. Run it either way so the full required list is
  # checked before anything is copied — a build must not ship a half-populated tools dir.
  bash "$ROOT_DIR/scripts/ensure-bundled-tools.sh"
  local source_dir="${DONKEY_TOOLS_DIR:-$ROOT_DIR/vendor/donkey-tools}"
  local dest_dir="$RESOURCES_DIR/donkey-tools"
  rm -rf "$dest_dir"
  mkdir -p "$dest_dir"
  # Copy ONLY the required tools, then the dylibs they actually load. The source directory can hold
  # more than the required set — a published bundle predating a tool's removal, or a stale vendor dir —
  # and copying it wholesale would ship binaries the product has no use for.
  local tool
  while IFS= read -r tool; do
    [ -e "$source_dir/$tool" ] && cp "$source_dir/$tool" "$dest_dir/$tool"
  done < <(bash "$ROOT_DIR/scripts/ensure-bundled-tools.sh" --list)
  copy_tool_dylibs "$source_dir" "$dest_dir"
  # Verify what actually landed in the app, against the same list ensure-bundled-tools.sh
  # checks: the copy is what ships, so this is the assertion that matters.
  local missing=()
  while IFS= read -r tool; do
    [ -x "$dest_dir/$tool" ] || missing+=("$tool")
  done < <(bash "$ROOT_DIR/scripts/ensure-bundled-tools.sh" --list)
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Baked tools directory is missing: ${missing[*]}; refusing to package." >&2
    exit 1
  fi
  # Re-sign the baked copy with the app's identity (Developer ID + hardened runtime for a release,
  # ad-hoc otherwise): copying preserves the vendor signature, but a notarized build must carry our
  # own. sign-bundled-tools.sh is the one place that knows which tools need the library-validation
  # exception to launch at all, so signing goes through it rather than a second codesign loop here.
  DONKEY_TOOLS_SIGN_IDENTITY="$APP_SIGN_IDENTITY" \
    bash "$ROOT_DIR/scripts/sign-bundled-tools.sh" "$dest_dir"
  # After signing, not before: a re-signed binary that can't load its libraries fails here rather than
  # on the user's Mac.
  verify_staged_tools "$dest_dir"
  echo "Baked bundled tools from $source_dir into $dest_dir."
}

# The Donkey Cut engine — the local server behind donkeycut.com — is version-locked to the
# app and built here as part of packaging, so one command produces a complete app. Set
# DONKEY_CUT_ENGINE_BIN to reuse a prebuilt binary (e.g. a cross-arch or cached CI build) instead.
stage_cut_engine() {
  local arch
  arch="$(uname -m)"; [ "$arch" = "x86_64" ] && arch="x64"
  local source_bin="${DONKEY_CUT_ENGINE_BIN:-}"
  if [ -z "$source_bin" ]; then
    echo "Building the Donkey Cut engine..."
    bash "$ROOT_DIR/site/scripts/build-cut-engine.sh"
    source_bin="$ROOT_DIR/site/dist/cut-engine/donkey-cut-engine-$arch"
  fi
  if [ ! -f "$source_bin" ]; then
    echo "Donkey Cut engine binary not found at $source_bin." >&2
    exit 1
  fi
  local dest_dir="$RESOURCES_DIR/cut-engine"
  mkdir -p "$dest_dir"
  cp "$source_bin" "$dest_dir/donkey-cut-engine"
  chmod +x "$dest_dir/donkey-cut-engine"
  # Bun-compiled binaries JIT through JavaScriptCore; under the hardened runtime they need the
  # JIT entitlements or the engine crashes at launch on a notarized build.
  local ents
  ents="$(mktemp -t cut-engine-entitlements).plist"
  cat > "$ents" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST
  local sopts=(--force --sign "$APP_SIGN_IDENTITY")
  [ "$APP_SIGN_IDENTITY" != "-" ] && sopts+=(--options runtime --timestamp --entitlements "$ents")
  [ -n "${DONKEY_SIGN_KEYCHAIN:-}" ] && sopts+=(--keychain "$DONKEY_SIGN_KEYCHAIN")
  codesign "${sopts[@]}" "$dest_dir/donkey-cut-engine" >/dev/null 2>&1 || true
  rm -f "$ents"
  echo "Bundled the Donkey Cut engine from $source_bin."

  # The on-device speech tool ships beside the engine binary — the engine puts
  # its own directory on PATH — so transcription works out of the box and the
  # tool updates in lockstep with the app. Plain Swift binary: hardened runtime,
  # no JIT entitlements.
  local source_stt="${DONKEY_CUT_STT_BIN:-$(dirname "$source_bin")/cut-stt-$arch}"
  if [ ! -f "$source_stt" ]; then
    echo "Donkey Cut speech tool not found at $source_stt." >&2
    exit 1
  fi
  cp "$source_stt" "$dest_dir/cut-stt"
  chmod +x "$dest_dir/cut-stt"
  local topts=(--force --sign "$APP_SIGN_IDENTITY")
  [ "$APP_SIGN_IDENTITY" != "-" ] && topts+=(--options runtime --timestamp)
  [ -n "${DONKEY_SIGN_KEYCHAIN:-}" ] && topts+=(--keychain "$DONKEY_SIGN_KEYCHAIN")
  codesign "${topts[@]}" "$dest_dir/cut-stt" >/dev/null 2>&1 || true
  echo "Bundled the Donkey Cut speech tool from $source_stt."
}

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$FRAMEWORKS_DIR"
cp "$EXECUTABLE" "$MACOS_DIR/Donkey"
if ! otool -l "$MACOS_DIR/Donkey" | grep -q "@executable_path/../Frameworks"; then
  if ! command -v install_name_tool >/dev/null 2>&1; then
    echo "install_name_tool is required to package Donkey.app with embedded frameworks." >&2
    exit 1
  fi
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/Donkey"
fi

rm -rf "$RUNTIME_PACKAGE_DIR"

# Copy every SwiftPM-generated resource bundle, not just the executable target's.
# Each target with resources (Donkey, DonkeyRuntime, ...) produces its own
# Donkey_<Target>.bundle, and the generated Bundle.module accessor fatalErrors at
# launch if its bundle is missing. Missing Donkey_DonkeyRuntime.bundle is what made
# BundledToolsInstaller crash the app on first launch.
RELEASE_DIR="$(find "$BUILD_DIR/.build" -type d -path "*/release" -name release | head -n 1 || true)"
copied_any_bundle=0
if [ -n "$RELEASE_DIR" ]; then
  for resource_bundle in "$RELEASE_DIR"/Donkey_*.bundle; do
    [ -d "$resource_bundle" ] || continue
    cp -R "$resource_bundle" "$RESOURCES_DIR/"
    copied_any_bundle=1
  done
fi
if [ "$copied_any_bundle" -eq 0 ] && [ -d "$BUILD_DIR/.build/release/Donkey_Donkey.resources" ]; then
  cp -R "$BUILD_DIR/.build/release/Donkey_Donkey.resources/." "$RESOURCES_DIR/"
  copied_any_bundle=1
fi
if [ "$copied_any_bundle" -eq 0 ]; then
  echo "No SwiftPM resource bundles found to stage; the app will crash at launch." >&2
  exit 1
fi
prepare_app_icon

SPARKLE_FRAMEWORK="$(find "$BUILD_DIR/.build" -path "*/release/Sparkle.framework" -type d | head -n 1 || true)"
if [ -z "$SPARKLE_FRAMEWORK" ]; then
  SPARKLE_FRAMEWORK="$(find "$BUILD_DIR/.build" -path "*/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework" -type d | head -n 1 || true)"
fi
if [ -n "$SPARKLE_FRAMEWORK" ]; then
  cp -R "$SPARKLE_FRAMEWORK" "$FRAMEWORKS_DIR/"
fi

stage_bundled_tools
stage_cut_engine

SPARKLE_PLIST_KEYS=""
if [ -n "$SPARKLE_FEED_URL" ] && [ -n "$SPARKLE_PUBLIC_ED_KEY" ]; then
  SPARKLE_PLIST_KEYS="  <key>SUEnableInstallerLauncherService</key>
  <true/>
  <key>SUEnableDownloaderService</key>
  <true/>
  <key>SUFeedURL</key>
  <string>$SPARKLE_FEED_URL</string>
  <key>SUPublicEDKey</key>
  <string>$SPARKLE_PUBLIC_ED_KEY</string>"
fi

cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Donkey</string>
  <key>CFBundleIdentifier</key>
  <string>com.donkeyuse.Donkey</string>
  <key>CFBundleName</key>
  <string>Donkey</string>
  <key>CFBundleDisplayName</key>
  <string>Donkey</string>
  <key>CFBundleIconFile</key>
  <string>Donkey.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_BUILD</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Donkey records microphone audio when you record your screen.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Donkey transcribes your video's audio on-device to build subtitles.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Donkey records your screen when you start a screen recording.</string>
  <!-- Recordings are written to the Desktop (ScreenRecordingDestination.makeOutputURL), which is
       TCC-protected; without this string the write is denied and the app is killed. -->
  <key>NSDesktopFolderUsageDescription</key>
  <string>Donkey saves your screen recordings to the Desktop.</string>
$SPARKLE_PLIST_KEYS
</dict>
</plist>
PLIST

sign_app
notarize_app

create_drag_to_applications_dmg
notarize_dmg

echo "Packaged $APP_DIR"
echo "Created drag-to-Applications disk image: $DMG_PATH"
echo "Open it with: open \"$APP_DIR\""
echo "Test the install flow with: open \"$DMG_PATH\""
echo "For Sparkle updates, package with DONKEY_SPARKLE_FEED_URL and DONKEY_SPARKLE_PUBLIC_ED_KEY."
