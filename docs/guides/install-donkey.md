# Install Donkey Locally

Donkey packages into a local macOS app bundle and a drag-to-Applications disk
image for manual testing or site distribution. Production releases run the
same packaging through GitHub Actions — see `docs/guides/releasing-donkey.md`.

## Packaging

From the repo root:

```bash
./scripts/package-donkey-app.sh
```

The script builds the release executable, creates `dist/Donkey.app`, copies
bundled resources and embedded frameworks, ensures the executable can load
those frameworks from the app bundle, applies an ad-hoc signature when
`codesign` is available, and creates `dist/Donkey.dmg`. The drag-to-Applications
background is rendered from SVG, so local packaging requires ImageMagick's
`magick` command.

The app bundle version defaults to `0.1.0` build `1`. Override it for local
release testing:

```bash
DONKEY_APP_VERSION="0.1.1" \
DONKEY_APP_BUILD="2" \
./scripts/package-donkey-app.sh
```

The app has no account and makes no authenticated calls; the menu bar's "Go to
App" opens the site at the packaged base URL — `https://donkeyuse.com` by
default. Override it for local or staging testing:

```bash
DONKEY_WEB_BASE_URL="http://localhost:3000" ./scripts/package-donkey-app.sh
```

Launch the packaged app with `open dist/Donkey.app`; test the installer flow
with `open dist/Donkey.dmg`.

## The Disk Image

Opening `dist/Donkey.dmg` mounts a `Donkey` volume with a custom Finder
installer window: `Donkey.app` on the left, the `Applications` shortcut on the
right, and a background arrow pointing users through the drag-to-Applications
flow. The user installs Donkey by dragging the app onto the shortcut, which
copies it into `/Applications`.

The installer artwork lives in `scripts/assets/donkey-dmg-background.svg`. The
package script renders that SVG into the Finder background and writes the
Finder layout into the compressed disk image, so users see the install screen
immediately after opening `Donkey.dmg`.

## Sparkle Updates

Donkey uses Sparkle for app updates. Sparkle owns appcast parsing, update
validation, download, install, and relaunch; do not add a Donkey-specific
installer or replacement flow for those. Donkey drives Sparkle through a silent
user driver and surfaces the update itself in the menu bar, so Sparkle's standard
update windows are never shown.

The public Sparkle feed lives in `site/public/appcast.xml`, served as
`https://donkeyuse.com/appcast.xml`. Appcast enclosure URLs point to the
numeric GitHub Release asset URL, not a moving `latest` or `-latest` URL. Do
not use the Supabase Storage `/release` bucket for release binaries or appcast
hosting.

Configure Sparkle when packaging:

```bash
DONKEY_APP_VERSION="0.1.1" \
DONKEY_APP_BUILD="2" \
DONKEY_SPARKLE_FEED_URL="https://donkeyuse.com/appcast.xml" \
DONKEY_SPARKLE_PUBLIC_ED_KEY="..." \
./scripts/package-donkey-app.sh
```

For local update testing, use Sparkle's standard local appcast workflow:

1. Package the older app and install it in `/Applications`.
2. Package the newer app with a higher `DONKEY_APP_VERSION` /
   `DONKEY_APP_BUILD`.
3. Run Sparkle's `generate_appcast` tooling over the folder containing the
   newer update archive.
4. Package or launch the older app with `DONKEY_SPARKLE_FEED_URL` pointing to
   the local `file://` appcast (e.g.
   `file:///Users/me/donkey-updates/appcast.xml`) and
   `DONKEY_SPARKLE_PUBLIC_ED_KEY` set to the matching public EdDSA key.

When Sparkle finds a valid signed update, the menu bar menu shows an Install
Update item. Choosing it downloads, installs, and relaunches silently through
Sparkle, with no update window shown.

## Hosted Models

The packaged Mac app does not bundle, download, install, or configure local
model weights. Model-backed behavior routes through the authenticated Donkey
backend, which owns provider credentials, provider selection, and concrete
model selection. The Mac client sends typed requests to the backend and needs
no OpenAI, Gemini, or other provider API keys.

macOS permissions (Screen Recording, Microphone) are requested by the system the
first time a recording needs them. There are no supported release manifest URLs,
model weight override URLs, local LLM packages, or local model repair steps in
the hosted-model install path.

## Local Development

```bash
./scripts/run-donkey-dev.sh
```

The dev script starts the local site when `DONKEY_WEB_BASE_URL` points at
localhost, builds Donkey, wraps the debug executable in
`apps/Donkey/.build/debug/Donkey Dev.app`, and launches it. The debug wrapper
defaults to the `Donkey Dev` display name and the `com.donkeyuse.Donkey.dev`
bundle identifier, and runs the Cut engine on its own port, so it never collides
with a packaged `Donkey.app` over macOS privacy settings.

| Variable | Effect |
|---|---|
| `DONKEY_START_SITE=0` | skip starting the site |
| `DONKEY_LAUNCH_APP=0` | build and register the debug app without opening it |
| `DONKEY_WEB_BASE_URL` | point the app at a different site |
| `DONKEY_CODESIGN_IDENTITY` | sign with a local identity so macOS privacy grants stick to it; otherwise ad-hoc signing with a stable dev designated requirement |
| `DONKEY_KEEP_APP_ON_EXIT=1` | don't stop running `Donkey`, `Donkey Dev`, and sidecar processes when the script exits or receives `SIGINT`/`SIGTERM`/hangup |
| `DONKEY_STOP_APPS_BEFORE_BUILD=0` | don't stop running Donkey app processes before rebuilding (only when intentionally inspecting a running build) |
