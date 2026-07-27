# Releasing Donkey

Donkey production releases are distributed through GitHub Releases, built by
the `Release Donkey` GitHub Actions workflow from the latest default-branch
code. Releases are automatic: every push to the default branch that changes
code shipping inside the Mac app cuts the next patch version. A separate
`Nightly Donkey Build` workflow publishes a smoke-test prerelease on a
schedule. The Supabase Storage `/release` bucket is not part of the release
path.

**The one rule:** user-facing links use the immutable numeric tag. The website
download URL and the appcast enclosure URL point at
`/releases/download/vMAJOR.MINOR.PATCH/Donkey.dmg`, never a moving `latest` or
`-latest` URL. Alias tags exist only for maintainer convenience.

## Workflows

| | `Release Donkey` | `Nightly Donkey Build` |
|---|---|---|
| Trigger | push to the default branch touching app code, or a bundled-tools republish — both always patch; plus manual: choose `patch`, `minor`, or `major` | nightly at 09:00 UTC, plus manual |
| Tag | numeric SemVer `vMAJOR.MINOR.PATCH` (starts at `0.1.0`) | moving `nightly` tag |
| Release | numeric GitHub Release, marked GitHub's latest | `Donkey Nightly Build` prerelease |
| Assets | `Donkey.dmg` + `Donkey.dmg.sha256` | `Donkey.dmg` + `Donkey.dmg.sha256` |
| Appcast / website | updates `site/public/appcast.xml` and the website download constant, commits both | untouched |
| Alias tags | moves `vMAJOR`, `vMAJOR.MINOR`, `latest` | untouched |
| Retention | keeps the latest 10 numeric releases; deletes older release records (never tags or the nightly prerelease) | n/a |
| Skip condition | a pushed commit that already carries a numeric release tag | skips when the `nightly` tag already points at the default-branch commit |

Use nightly builds to smoke-test the latest default-branch app package. Use
`Release Donkey` to publish a user-facing release.

## What Triggers a Release

A push releases when it touches the Swift app, the Cut engine sources compiled
into the bundled binary, or the packaging scripts. Hosted site changes leave
the release alone. That path list is the same boundary as the ` [rebuild]`
commit-subject rule: a commit that needs a new Mac app build cuts a release.

The bundled tools take the long way round, because their recipe and the bundle
the app actually stages move at different times. A push to the tools recipe
runs `Publish Bundled Tools`, which builds and notarizes the new bundle and
commits the manifest pinning it — and only then asks for a release. Releasing
straight off the recipe push would package a build that still stages the
previous bundle.

Only the bump size stays manual: pushes are always patches, so minor and major
come from a manual run.

Three guards keep automatic releases from tripping over each other:

1. **One release at a time.** All runs share a concurrency group and are never
   cancelled mid-flight, so version numbers are derived from a settled set of
   tags and a run can't die between tagging a release and updating the appcast.
   Pushes arriving during a build queue up, and only the newest queued run
   survives.
2. **The gate picks the commit; the build honors it.** A short first job on a
   Linux runner decides whether to release, resolves the version, and pins the
   commit. The macOS build checks out that exact commit, so a push landing
   mid-run neither sneaks into this release nor gets built twice.
3. **A released commit is never released again.** A queued run lands on the
   branch tip, which may already be the commit the previous run shipped. If a
   numeric tag points at it, the run stops. A manual run bypasses this so a
   release that failed after tagging can be retried.

Retention keeps the latest ten numeric releases, so automatic patches retire
older release records faster than manual releases did. The tags stay, and the
appcast always names exactly one version.

## Release Runbook

Merging app changes into the default branch is the runbook. For a minor or
major bump:

1. Open GitHub Actions for the repository.
2. Select `Release Donkey`.
3. Click `Run workflow`.
4. Choose `patch`, `minor`, or `major`.
5. Run the workflow.

The workflow checks out the release commit, derives the next version
from existing numeric release tags and the selected bump, builds and packages
`dist/Donkey.dmg`, Developer ID-signs and notarizes the app and disk image and
signs the DMG with the Sparkle private key, creates or updates the numeric
GitHub Release with the DMG and checksum, updates `site/public/appcast.xml` and
the website download constant and commits those changes, marks the release as
GitHub's latest, moves the alias tags, and prunes releases beyond the latest 10.

The app's Developer ID signing + notarization reuses the same secrets as the
bundled tools (see below); without them the release falls back to an ad-hoc
signed app that is not distributable. The app is signed with the hardened
runtime. It carries no entitlements of its own — screen recording and the
microphone are governed by TCC and the Info.plist usage strings.

## Bundled Tools

The Cut engine runs CLI tools — `ffmpeg` and `ffprobe` behind every export, probe,
and frame extract, and `yt-dlp` behind URL import — by bare name off PATH. Those tools ship **inside** the app, at
`Donkey.app/Contents/Resources/donkey-tools`. Being part of the app is what makes
them dependable: they are present the moment the app is, so an export or a download
cannot fail on a machine that never had ffmpeg, there is no setup step to race, and
nothing has to work offline that can't.

Staging copies only the required tools and the dylibs they actually load, so a
published bundle holding more than the current set can't put extra binaries into
the app.

Packaging stages them without a separate step. `ensure-bundled-tools.sh` puts the
tools in `vendor/donkey-tools` — downloading the prebuilt bundle named in
`bundled-tools.json` when one is published, otherwise building from source — and
`package-donkey-app.sh` copies that directory into the app and re-signs it. Point
`DONKEY_TOOLS_DIR` at a prebuilt directory to bake that instead.

Every tool in the set is required, and packaging verifies the copy that actually
landed in the app before signing it. There is no optional tier: a tool that ships
sometimes is a capability that fails for whoever didn't get it, so a build that
can't stage one fails instead. `REQUIRED_TOOLS` in `ensure-bundled-tools.sh` is
the list, and a unit test holds `BundledTools.executableNames` to it so the two
can't drift.

The `Publish Bundled Tools` workflow is what produces the prebuilt bundle: it
builds the tools from source on an arm64 runner, signs and notarizes them,
uploads the result as a GitHub release asset, and commits the refreshed
`bundled-tools.json`. That manifest is a build-time input only — the shipped app
never reads it. It runs on demand and whenever the tools recipe changes.

When the manifest moves, the workflow asks `Release Donkey` for a patch release
so the new tools reach users. It has to ask explicitly: a git push authored by
the Actions token never starts a workflow, while a dispatch from that same token
does. A rebuild that lands on the same bundle commits nothing and asks for
nothing.

Each manifest pins one bundle version by sha256, and that pairing is permanent.
Published assets are immutable to match: re-publishing a version that already has
an asset auto-bumps to `<version>.1` instead of overwriting it, so a checkout that
pins a version keeps fetching the bytes it verified against. (The bug this
prevents: a date-named version was once re-uploaded with different bytes, and
every build pinning the original sha could no longer stage its tools.)

Every tool is re-signed during the build: relocating their bundled libraries
invalidates the original signature, and macOS will not run an unsigned binary on
Apple Silicon. Without the secrets below the tools are only ad-hoc signed — fine
for local development, not for distribution. `yt-dlp` additionally gets the
library-validation exception (`com.apple.security.cs.disable-library-validation`):
it self-extracts and loads its own Python framework at launch, which the hardened
runtime would otherwise reject for not sharing our Team ID. The other tools don't
get it — they load only the sibling libraries we re-sign, so they stay fully
hardened.

Standalone CLI binaries cannot be stapled (only app/dmg/pkg bundles can), so
notarization of the published bundle is the online proof that its Developer ID
signature is good; the signature itself is what lets the tools run. Baking them
into the app re-signs each one with the app's own identity, and the app's
notarization then covers them.

### Obtaining the signing secrets

Everything comes from two things created in your Apple Developer account (paid
program required; the certificate can only be created by the account
Holder/Admin). An **Apple Development** certificate is the wrong kind — Gatekeeper
and notarytool reject it; you need **Developer ID Application**.

1. **Developer ID Application certificate.** Create it in Xcode: Settings →
   Accounts → your team → Manage Certificates → `+` → Developer ID Application. It
   installs into your login keychain (it is not downloaded as a file). In Keychain
   Access, expand it to reveal its private key, select **both**, and export a
   `.p12` (you choose the password). `security find-identity -v -p codesigning`
   prints the identity string.
   - `DONKEY_DEVELOPER_ID_CERT_P12` = `base64 -i cert.p12`
   - `DONKEY_DEVELOPER_ID_CERT_PASSWORD` = the export password
   - `DONKEY_TOOLS_SIGN_IDENTITY` = the identity, e.g. `Developer ID Application: Name (TEAMID)`
2. **App Store Connect API key** (notarization), from App Store Connect → Users
   and Access → Integrations → App Store Connect API. Download the `.p8` (offered
   once) and read the Key ID and Issuer ID off the page.
   - `DONKEY_NOTARY_KEY_P8` = `base64 -i AuthKey_XXXX.p8`
   - `DONKEY_NOTARY_KEY_ID` = the key's Key ID
   - `DONKEY_NOTARY_ISSUER_ID` = the Issuer ID

Before adding the secrets, confirm you have the right certificate:
`security find-identity -v -p codesigning` should list a `Developer ID
Application` line — an Apple Development cert will not work.

## One-Time Sparkle Setup

Generate one Sparkle EdDSA signing keypair on a trusted Mac:

```bash
apps/Donkey/.build/artifacts/sparkle/Sparkle/bin/generate_keys --account donkey
```

Copy the printed `SUPublicEDKey` value into the GitHub repository secret
`DONKEY_SPARKLE_PUBLIC_ED_KEY`. Then export the matching private key:

```bash
apps/Donkey/.build/artifacts/sparkle/Sparkle/bin/generate_keys \
  --account donkey \
  -x /tmp/donkey-sparkle-private-key.txt
```

Copy the file contents into the GitHub repository secret
`DONKEY_SPARKLE_PRIVATE_ED_KEY`, then delete the exported file:

```bash
rm -f /tmp/donkey-sparkle-private-key.txt
```

Keep this keypair stable. Already-installed apps trust the public key embedded
at packaging time and reject future updates signed by a different private key.
Sparkle signs and validates update archives; do not add a Donkey-specific
updater or replacement installer.

## Verification

After the workflow finishes:

- The GitHub Release for `vMAJOR.MINOR.PATCH` contains `Donkey.dmg` and
  `Donkey.dmg.sha256`.
- The website source has `DONKEY_LATEST_VERSION` set to the numeric version.
- `site/public/appcast.xml` contains one item for that version and an
  enclosure URL under `/releases/download/vMAJOR.MINOR.PATCH/Donkey.dmg`.
- The GitHub Releases page keeps no more than 10 numeric production releases,
  plus the separate nightly prerelease when present.
- `https://donkeyuse.com/appcast.xml` updates after the site deploy completes.

If Sparkle cannot validate an update, first check that the app was packaged
with the `DONKEY_SPARKLE_PUBLIC_ED_KEY` that matches the private key stored in
GitHub Actions.
