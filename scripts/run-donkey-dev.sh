#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT_DIR/apps/Donkey"
LOG_SCRIPT="$ROOT_DIR/scripts/tail-donkey-logs.sh"
BUILD_PRODUCTS_DIR="$APP_DIR/.build/debug"
DONKEY_BIN="$BUILD_PRODUCTS_DIR/Donkey"
DEV_BUNDLE_IDENTIFIER="${DONKEY_DEV_BUNDLE_IDENTIFIER:-com.donkeyuse.Donkey.dev}"
DEV_DISPLAY_NAME="${DONKEY_DEV_DISPLAY_NAME:-Donkey Dev}"
DEV_EXECUTABLE_NAME="${DONKEY_DEV_EXECUTABLE_NAME:-$DEV_DISPLAY_NAME}"
DEV_APP_DIR="$BUILD_PRODUCTS_DIR/$DEV_DISPLAY_NAME.app"
CACHE_DIR="$APP_DIR/.build/dev-script-cache"
CACHE_CLANG_DIR="$CACHE_DIR/clang"
CACHE_SWIFTPM_DIR="$CACHE_DIR/swiftpm"
CACHE_HOME_DIR="$CACHE_DIR/home"
CONTENTS_DIR="$DEV_APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
FRAMEWORKS_DIR="$CONTENTS_DIR/Frameworks"
# The dev bundle wears the red icon (Donkey.icns hue-shifted, regenerate with
# `magick -modulate 100,100,178` per iconset PNG + iconutil) so it never gets
# mistaken for an installed release in the Dock.
APP_ICON_SOURCE="$APP_DIR/Sources/Donkey/Resources/Donkey-dev.icns"
APP_ICONSET_SOURCE="$APP_DIR/Sources/Donkey/Resources/Donkey.iconset"
# The dev engine binds its own loopback port (baked into the dev Info.plist below,
# read by DonkeyCutEngineSupervisor) so it coexists with an installed release's
# engine on 41417 instead of the two supervisors killing each other's engine.
DEV_CUT_ENGINE_PORT="${DONKEY_DEV_CUT_ENGINE_PORT:-41418}"
LAUNCH_APP="${DONKEY_LAUNCH_APP:-1}"
SITE_PID=""
SITE_LOG="${DONKEY_SITE_LOG:-${TMPDIR:-/tmp}/donkey-site-dev.log}"
LOG_PID=""

export DONKEY_WEB_BASE_URL="${DONKEY_WEB_BASE_URL:-http://localhost:3000}"

# Stop only a prior DEV build so a rebuild (or script exit) doesn't leave two dev
# instances running. Never touch an installed release: its process is "Donkey" from
# "Donkey.app", while the dev build runs as "$DEV_EXECUTABLE_NAME" from
# "$DEV_DISPLAY_NAME.app" with a separate bundle id and Cut engine port,
# so the two are meant to run side by side.
stop_running_dev_donkey_apps() {
  killall "$DEV_EXECUTABLE_NAME" >/dev/null 2>&1 || true
  if [ "$DEV_DISPLAY_NAME" != "$DEV_EXECUTABLE_NAME" ]; then
    killall "$DEV_DISPLAY_NAME" >/dev/null 2>&1 || true
  fi

  if command -v pkill >/dev/null 2>&1; then
    pkill -f "/$DEV_DISPLAY_NAME\.app/Contents/MacOS/" >/dev/null 2>&1 || true
  fi
}

cleanup_child_processes() {
  if [ "$LAUNCH_APP" != "0" ] && [ "${DONKEY_KEEP_APP_ON_EXIT:-0}" != "1" ]; then
    stop_running_dev_donkey_apps
  fi
  if [ -n "$LOG_PID" ] && kill -0 "$LOG_PID" >/dev/null 2>&1; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
    wait "$LOG_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$SITE_PID" ] && kill -0 "$SITE_PID" >/dev/null 2>&1; then
    kill "$SITE_PID" >/dev/null 2>&1 || true
    wait "$SITE_PID" >/dev/null 2>&1 || true
  fi
}

cleanup_on_exit() {
  local exit_code=$?
  trap - EXIT INT TERM HUP
  cleanup_child_processes
  exit "$exit_code"
}

cleanup_on_signal() {
  local exit_code="$1"
  trap - EXIT INT TERM HUP
  cleanup_child_processes
  exit "$exit_code"
}

start_logger() {
  if [ "${DONKEY_TAIL_LOGS:-1}" = "0" ]; then
    echo "Skipping Donkey log tail because DONKEY_TAIL_LOGS=0."
    return
  fi

  if [ ! -x "$LOG_SCRIPT" ]; then
    echo "Skipping Donkey log tail because $LOG_SCRIPT is not executable." >&2
    return
  fi

  local log_args=()
  log_args+=(--process "$DEV_EXECUTABLE_NAME")
  if [ "${DONKEY_LOG_ERRORS_ONLY:-0}" = "1" ]; then
    log_args+=(--errors)
  fi
  if [ "${DONKEY_LOG_DEBUG:-0}" = "1" ]; then
    log_args+=(--debug)
  fi
  if [ -n "${DONKEY_LOG_CONTAINS:-}" ]; then
    log_args+=(--contains "$DONKEY_LOG_CONTAINS")
  fi
  if [ "${DONKEY_LOG_ALL:-0}" != "1" ]; then
    log_args+=(--subsystem "${DONKEY_LOG_SUBSYSTEM:-com.donkey.app}")
  elif [ -n "${DONKEY_LOG_SUBSYSTEM:-}" ]; then
    log_args+=(--subsystem "$DONKEY_LOG_SUBSYSTEM")
  fi

  echo "Tailing Donkey logs..."
  if [ "${#log_args[@]}" -eq 0 ]; then
    "$LOG_SCRIPT" &
  else
    "$LOG_SCRIPT" "${log_args[@]}" &
  fi
  LOG_PID="$!"
}

is_local_web_base_url() {
  case "$DONKEY_WEB_BASE_URL" in
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*|http://[::1]|http://[::1]:*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

site_health_url() {
  printf '%s/api/health' "${DONKEY_WEB_BASE_URL%/}"
}

site_is_running() {
  command -v curl >/dev/null 2>&1 &&
    curl --silent --fail --max-time 1 "$(site_health_url)" >/dev/null 2>&1
}

ensure_site_server() {
  if [ "${DONKEY_START_SITE:-1}" = "0" ]; then
    echo "Skipping site dev server because DONKEY_START_SITE=0."
    return
  fi

  if ! is_local_web_base_url; then
    echo "Skipping site dev server because DONKEY_WEB_BASE_URL is not local: $DONKEY_WEB_BASE_URL"
    return
  fi

  if site_is_running; then
    echo "Site dev server is already running at $DONKEY_WEB_BASE_URL."
    return
  fi

  if [ ! -d "$ROOT_DIR/site" ]; then
    echo "Missing site directory at $ROOT_DIR/site." >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is required to start the local site dev server." >&2
    exit 1
  fi

  echo "Starting site dev server at $DONKEY_WEB_BASE_URL ..."
  (
    cd "$ROOT_DIR/site"
    npm run dev
  ) >"$SITE_LOG" 2>&1 &
  SITE_PID="$!"

  local wait_seconds="${DONKEY_SITE_WAIT_SECONDS:-30}"
  local elapsed=0
  while [ "$elapsed" -lt "$wait_seconds" ]; do
    if site_is_running; then
      echo "Site dev server is ready."
      return
    fi

    if ! kill -0 "$SITE_PID" >/dev/null 2>&1; then
      echo "Site dev server exited before becoming ready. Log: $SITE_LOG" >&2
      tail -n 60 "$SITE_LOG" >&2 || true
      exit 1
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  echo "Timed out waiting for the site dev server. Log: $SITE_LOG" >&2
  tail -n 60 "$SITE_LOG" >&2 || true
  exit 1
}

xml_escape() {
  printf '%s' "$1" |
    sed \
      -e 's/&/\&amp;/g' \
      -e 's/</\&lt;/g' \
      -e 's/>/\&gt;/g' \
      -e 's/"/\&quot;/g' \
      -e "s/'/\&apos;/g"
}

resolve_codesign_identity() {
  if [ -n "${DONKEY_CODESIGN_IDENTITY:-}" ]; then
    printf '%s\n' "$DONKEY_CODESIGN_IDENTITY"
    return
  fi

  if command -v security >/dev/null 2>&1; then
    local identity
    identity="$(
      security find-identity -v -p codesigning 2>/dev/null |
        awk -F '"' '/Apple Development/ { print $2; exit }'
    )"
    if [ -n "$identity" ]; then
      printf '%s\n' "$identity"
      return
    fi
  fi

  printf '%s\n' "-"
}

# Xcode-issued "Apple Development" certs chain through Apple's WWDR G3 intermediate. The old G3
# intermediate expired in Feb 2023; a keychain that holds only the expired copy makes codesign
# unable to build a chain, which silently drops signing to ad-hoc and breaks the TCC screen-
# recording grant across rebuilds. Make sure a current intermediate is present before we resolve
# an identity, since `find-identity -v` reports the cert as invalid until the chain is whole.
ensure_apple_wwdr_intermediate() {
  # Only relevant when a real Apple Development cert exists and ad-hoc isn't forced; pure ad-hoc
  # dev needs no chain.
  [ "${DONKEY_CODESIGN_IDENTITY:-}" = "-" ] && return
  command -v security >/dev/null 2>&1 || return
  security find-identity -p codesigning 2>/dev/null | grep -q "Apple Development" || return

  if wwdr_intermediate_is_current; then
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "Warning: missing the current Apple WWDR intermediate and curl is unavailable; signing may fall back to ad-hoc." >&2
    return
  fi

  echo "Installing the current Apple WWDR intermediate (the cached one is missing or expired)..."
  local tmp
  tmp="$(mktemp -t AppleWWDRCAG3.XXXXXX)" || return
  if curl -fsSL -o "$tmp" "https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer"; then
    security import "$tmp" -k "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || true
  else
    echo "Warning: could not download the Apple WWDR intermediate; signing may fall back to ad-hoc." >&2
  fi
  rm -f "$tmp"
}

# True when the keychain holds at least one non-expired WWDR intermediate.
wwdr_intermediate_is_current() {
  command -v openssl >/dev/null 2>&1 || return 1
  local dir cert result
  dir="$(mktemp -d)" || return 1
  security find-certificate -a -c "Worldwide Developer Relations" -p 2>/dev/null |
    awk -v d="$dir" '
      /BEGIN CERTIFICATE/ { n++; f = d "/c" n ".pem" }
      n { print > f }
    '
  result=1
  for cert in "$dir"/c*.pem; do
    [ -e "$cert" ] || continue
    if openssl x509 -in "$cert" -checkend 0 >/dev/null 2>&1; then
      result=0
      break
    fi
  done
  rm -rf "$dir"
  return $result
}

prepare_app_icon() {
  local destination="$RESOURCES_DIR/Donkey.icns"

  if [ -f "$APP_ICON_SOURCE" ]; then
    cp "$APP_ICON_SOURCE" "$destination"
    return
  fi

  if [ -d "$APP_ICONSET_SOURCE" ]; then
    if ! command -v iconutil >/dev/null 2>&1; then
      echo "iconutil is required to package Donkey.app from $APP_ICONSET_SOURCE." >&2
      exit 1
    fi
    iconutil --convert icns --output "$destination" "$APP_ICONSET_SOURCE"
    return
  fi

  echo "Missing app icon sources: $APP_ICON_SOURCE or $APP_ICONSET_SOURCE" >&2
  exit 1
}

write_info_plist() {
  local escaped_web_base_url
  local escaped_bundle_identifier
  local escaped_display_name
  local escaped_executable_name
  escaped_web_base_url="$(xml_escape "$DONKEY_WEB_BASE_URL")"
  escaped_bundle_identifier="$(xml_escape "$DEV_BUNDLE_IDENTIFIER")"
  escaped_display_name="$(xml_escape "$DEV_DISPLAY_NAME")"
  escaped_executable_name="$(xml_escape "$DEV_EXECUTABLE_NAME")"

  cat > "$CONTENTS_DIR/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$escaped_executable_name</string>
  <key>CFBundleIdentifier</key>
  <string>$escaped_bundle_identifier</string>
  <key>CFBundleName</key>
  <string>$escaped_display_name</string>
  <key>CFBundleDisplayName</key>
  <string>$escaped_display_name</string>
  <key>CFBundleIconFile</key>
  <string>Donkey.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0-dev</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSMultipleInstancesProhibited</key>
  <true/>
  <key>DonkeyWebBaseURL</key>
  <string>$escaped_web_base_url</string>
  <key>DonkeyCutEnginePort</key>
  <integer>$DEV_CUT_ENGINE_PORT</integer>
  <key>NSMicrophoneUsageDescription</key>
  <string>Donkey uses the microphone for user-requested voice input.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Donkey transcribes your voice input on-device to turn it into a command.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>Donkey captures bounded screenshots for user-requested app context.</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Donkey uses local app automation only for user-requested actions.</string>
  <key>NSDesktopFolderUsageDescription</key>
  <string>Donkey may search Desktop files only when you ask it to find or open a local item.</string>
  <key>NSDocumentsFolderUsageDescription</key>
  <string>Donkey may search Documents files only when you ask it to find or open a local item.</string>
  <key>NSDownloadsFolderUsageDescription</key>
  <string>Donkey may search Downloads files only when you ask it to find or open a local item.</string>
  <key>NSAppleMusicUsageDescription</key>
  <string>Donkey plays Apple Music natively when you ask for music.</string>
</dict>
</plist>
PLIST
}

create_debug_app_bundle() {
  local resource_bundle
  local sparkle_framework
  local codesign_identity

  rm -rf "$DEV_APP_DIR" "$BUILD_PRODUCTS_DIR/Donkey.app"
  mkdir -p "$MACOS_DIR" "$RESOURCES_DIR" "$FRAMEWORKS_DIR"

  cp "$DONKEY_BIN" "$MACOS_DIR/$DEV_EXECUTABLE_NAME"
  if ! otool -l "$MACOS_DIR/$DEV_EXECUTABLE_NAME" | grep -q "@executable_path/../Frameworks"; then
    if ! command -v install_name_tool >/dev/null 2>&1; then
      echo "install_name_tool is required to package the Donkey debug app." >&2
      exit 1
    fi
    install_name_tool -add_rpath "@executable_path/../Frameworks" "$MACOS_DIR/$DEV_EXECUTABLE_NAME"
  fi

  local copied_any_bundle=0
  local bundle
  while IFS= read -r bundle; do
    [ -z "$bundle" ] && continue
    cp -R "$bundle" "$RESOURCES_DIR/"
    copied_any_bundle=1
  done < <(find "$APP_DIR/.build" -name "Donkey_*.bundle" -type d -path "*/debug/*" | grep -v "Tests")

  if [ "$copied_any_bundle" -eq 0 ]; then
    echo "Missing SwiftPM resource bundles for Donkey." >&2
    exit 1
  fi

  # Stage the bundled CLI tools at Contents/Resources/donkey-tools so bundledToolsDirectory
  # resolves in dev exactly as in release. Symlinked to the repo's vendor dir rather than
  # copied: the bundle is rebuilt every run, and a ~250MB copy (+ re-sign) each time is
  # needless when ad-hoc dev signing has no hardened-runtime constraint on the target.
  if [ -d "$ROOT_DIR/vendor/donkey-tools" ]; then
    ln -sfn "$ROOT_DIR/vendor/donkey-tools" "$RESOURCES_DIR/donkey-tools"
  fi

  # Build and stage the Donkey Cut engine so the app supervises a current copy — no separate
  # manual build step. Non-fatal: a Cut build hiccup shouldn't block Donkey dev (the app just
  # runs without Cut).
  cut_engine_arch="$(uname -m)"
  [ "$cut_engine_arch" = "x86_64" ] && cut_engine_arch="x64"
  cut_engine="$ROOT_DIR/site/dist/cut-engine/donkey-cut-engine-$cut_engine_arch"
  if [ -d "$ROOT_DIR/site" ]; then
    echo "Building Donkey Cut engine..."
    bash "$ROOT_DIR/site/scripts/build-cut-engine.sh" ||
      echo "Warning: Cut engine build failed; running Donkey without Cut." >&2
  fi
  if [ -f "$cut_engine" ]; then
    mkdir -p "$RESOURCES_DIR/cut-engine"
    ln -sf "$cut_engine" "$RESOURCES_DIR/cut-engine/donkey-cut-engine"
  fi

  sparkle_framework="$(find "$APP_DIR/.build" -path "*/debug/Sparkle.framework" -type d | head -n 1 || true)"
  if [ -n "$sparkle_framework" ]; then
    cp -R "$sparkle_framework" "$FRAMEWORKS_DIR/"
  fi

  prepare_app_icon
  write_info_plist

  if command -v codesign >/dev/null 2>&1; then
    ensure_apple_wwdr_intermediate
    codesign_identity="$(resolve_codesign_identity)"
    if [ "$codesign_identity" = "-" ]; then
      echo "Signing debug app ad-hoc with a stable dev requirement."
      codesign \
        --force \
        --deep \
        --sign - \
        --identifier "$DEV_BUNDLE_IDENTIFIER" \
        --requirements "=designated => identifier \"$DEV_BUNDLE_IDENTIFIER\"" \
        "$DEV_APP_DIR" >/dev/null
    else
      echo "Signing debug app with $codesign_identity."
      codesign \
        --force \
        --deep \
        --sign "$codesign_identity" \
        --identifier "$DEV_BUNDLE_IDENTIFIER" \
        "$DEV_APP_DIR" >/dev/null
    fi
  fi

}

swift_build() {
  mkdir -p "$CACHE_CLANG_DIR" "$CACHE_SWIFTPM_DIR" "$CACHE_HOME_DIR"
  CLANG_MODULE_CACHE_PATH="$CACHE_CLANG_DIR" \
    SWIFTPM_CACHE_PATH="$CACHE_SWIFTPM_DIR" \
    HOME="$CACHE_HOME_DIR" \
    swift build --quiet
}

trap cleanup_on_exit EXIT
trap 'cleanup_on_signal 130' INT
trap 'cleanup_on_signal 143' TERM
trap 'cleanup_on_signal 129' HUP

ensure_site_server

if [ "${DONKEY_STOP_APPS_BEFORE_BUILD:-1}" = "1" ]; then
  echo "Stopping any running Donkey Dev app..."
  stop_running_dev_donkey_apps
fi

cd "$APP_DIR"

echo "Building Donkey..."
swift_build

if [ ! -x "$DONKEY_BIN" ]; then
  echo "Built Donkey executable was not found at $DONKEY_BIN." >&2
  exit 1
fi

# Make sure the bundled CLI tools (ffmpeg, yt-dlp, ...) are vendored before staging them
# into the app, so a dev build behaves like release: the Cut engine runs them by bare
# name instead of hunting for Homebrew. Cached after the first run.
echo "Ensuring bundled tools..."
"$ROOT_DIR/scripts/ensure-bundled-tools.sh"

echo "Creating debug app bundle..."
create_debug_app_bundle

echo "Prepared $DEV_APP_DIR"
if [ "$LAUNCH_APP" = "0" ]; then
  echo "Skipping Donkey launch because DONKEY_LAUNCH_APP=0."
  exit 0
fi

echo "Starting Donkey..."
start_logger
open -W -n "$DEV_APP_DIR"
