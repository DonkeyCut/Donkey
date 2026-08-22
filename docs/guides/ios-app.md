# The iOS App

Donkey's iOS app lives at `apps/ios/`. It is the phone end of Donkey Cut:
record clips with a teleprompter, jot notes and collect inspiration, and let
everything flow to the desktop editor through the cloud shelf. Sign-in is
Google or Apple, exchanged for a Donkey Cut session on donkeycut.com; the same
bearer session authenticates every cloud call.

## Sync

One engine (`SyncEngine` in `DonkeyKitModels`) owns every queue: recordings
up, inspiration up, notes both ways, deletes replayed. It works off a journal
kept in the app's SwiftData store, so nothing depends on the app staying open
— whatever was mid-flight when the app died is picked up on the next launch,
foreground, network change, or edit.

**The one rule on data:** a transfer moves whenever the phone is online. Who
gets to spend cellular data is the system's call — iOS Settings carries the
per-app Cellular Data switch, and a request it forbids fails on its own — so
the app keeps no network preference of its own.

Every byte moves at most once. Uploads go straight to storage on presigned
URLs; an interrupted upload re-presigns under the name it already claimed, and
a retried completion lands on the asset it already made. Recordings arrive in
the desktop library marked as camera clips (the Camera Roll tab), inspiration
media lands in the Inspiration folder, and a saved inspiration link queues a
cloud-side import: the worker fetches the source, the phone follows the job,
and the media comes back down onto the phone, so the card that was a link
plays the video the link pointed at. A source that turns out to be only words
stays a link. Notes merge both ways by last-writer-wins on the edit stamp,
with tombstones so a delete made offline on either side still lands on the
other. The folders notes file into travel with them, under ids whichever
device made them chose; a folder carries no tombstone, so a folder the cloud
listing no longer names was deleted elsewhere and its notes come back to the
top level.

Deletes on the shelf run both ways. A synced recording deleted on the phone
takes the cloud copy with it, and a clip deleted at the desk — from the Camera
Roll or the Library — leaves a tombstone the phone reads on its next pass and
deletes the local movie for. What the shelf simply stops listing is a different
thing: an asset the storage sweep reclaimed carries no tombstone, so the phone
keeps the clip it shot, forgets the cloud copy, and sends it back up once there
is room.

Notes are written at the desk as well as here, so the phone pulls on a clock
of its own while it is on screen, and pull to refresh runs the same pass at
once.

A pass that ends with work still queued — a request that timed out, a 5xx —
books its own next try and backs off, up to five minutes between attempts, so
a clip stranded by a bad moment on the network moves as soon as the network
does.

When the account is out of cloud storage, uploads pause and the Library shows
a slim banner pinned over the notch; clips stay on the phone and the banner
clears once space frees up.

Projects sync down as thumbnails only: the Projects tab lists cloud projects
with cached poster images, and a tap streams the latest export — or the
composited preview when none exists — straight from the CDN.

The phone exports the whole cut. A control under the player's own sound
button, on screen exactly when that button is, opens a sheet of the sizes the
editor's export dialog offers. Picking one queues a cloud render of the
project's timeline: the worker opens the stored document and builds the render
spec itself, so what comes back is the file the editor's own export produces —
overlays, captions, soundtrack and all — rather than whatever happened to be
streaming. The phone follows the job, shows how far along it is on the button,
downloads the finished file, and adds it to the photo library, which is the
route to anywhere a video gets posted. The render belongs to the account
rather than to the screen, so leaving the player and coming back finds it
where it was, and a project that already carries a render offers it as a
choice that saves right away without spending another.

Every request carries an `x-donkey-cut-client: ios` header. The server
remembers accounts it has seen it from, and the desktop shows its phone
surfaces (Camera Roll and Notes tabs) only to those accounts.

## Camera

A finished take flies from the stage down into a well in the bottom-left
corner, the way a screenshot shrinks to the edge of the screen. Tapping it
plays the clip, with a "< Library" control in the player that carries on into
the Library tab. The well holds one take and retires it once it has been
watched or thirty seconds pass, so the viewfinder goes back to being a
viewfinder.

## Teleprompter

The teleprompter paces raw notes by itself. Reading speed is words per
minute; the scroll rate is derived from the script's word count and the
rendered height, so however the words are spaced they pass the reader at the
set pace. Runs of spaces collapse, the writer's own line breaks hold as
paragraph breaks, and long unbroken paragraphs wrap into short lines at
clause boundaries. Speed and text size persist across sessions — set once,
kept forever.

A note is read for what is written in it — its body, or its title when that is
all it has. The script is laid out whole and scrolled past the screen, so
length is never a reason for a note to arrive half-read.

Closing the card hands the screen to the prompter. The script runs on a loop
the same way in a preview as in a take: the screen draws it twice, so the next
pass rises as the last one leaves and the loop never runs through an empty
screen. The card's test button starts a run from the top, which is how a speed
and a size get watched before anyone commits to them.

The script starts halfway down the screen, and a drag moves it: the nudge
rides along with the pacing, so the words land where the reader wants them and
the pace carries on. Each run puts the script back where the pacing wants
it.

## How It Is Put Together

The app follows the Swift Guide's MVC split across two layers:

- `apps/ios/DonkeyKit/` is a local Swift package. `DonkeyKitModels` holds the
  observable models, the repositories (SwiftData metadata plus movie files
  under Application Support), and the pure capture math — format selection,
  zoom mapping, teleprompter scroll. `DonkeyKitUI` holds every screen and
  emits typed intents. UI never imports the controllers.
- `apps/ios/Donkey/` is the app target: the `@main` wiring, the AVFoundation
  camera controller (capture session confined to one serial queue), the auth
  controller (native Sign in with Apple, Google Sign-In, better-auth ID-token
  exchange, keychain session), and the capture preview view.

One adaptive layout serves iPhone and iPad: size-class-driven SwiftUI, a
sidebar-adaptable tab bar, all orientations, resizable iPad windows. The
capture path is `AVCaptureSession` with `AVCaptureMovieFileOutput` (HEVC, HLG
when HDR is on); the hardware record triggers ride
`AVCaptureEventInteraction`.

## Building and Testing

Xcode 26 or newer. Open `apps/ios/Donkey.xcodeproj`, or from the terminal:

```bash
cd apps/ios
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project Donkey.xcodeproj -scheme Donkey \
  -destination 'generic/platform=iOS Simulator' build
```

Model tests run headless without a simulator:

```bash
cd apps/ios/DonkeyKit
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
```

The camera shows its fallback state in the simulator; capture, torch, zoom,
and HDR need a device.

iOS commits never carry the ` [rebuild]` label — that label releases the Mac
app.

## Sign-In Configuration

The backend side is the site's better-auth config (`site/src/lib/auth.ts`):
the bearer plugin issues the app's session token, the Apple provider verifies
native tokens against the `com.donkeycut.donkeycut` bundle id, and the Google
provider accepts ID tokens from the iOS OAuth client. This is an open-source
tree, so deployment ids stay out of it:

- **App**: copy `apps/ios/Config/Donkey.local.xcconfig.example` to
  `Donkey.local.xcconfig` (gitignored) and fill in the iOS Google OAuth
  client id and its reversed form. The build injects them through
  `Info.plist`; without them the app still builds, and the Google button
  reports sign-in as not configured.
- **Site**: set `GOOGLE_IOS_CLIENT_ID` in the deployment environment beside
  the other Google OAuth values.

Native Apple sign-in needs no Services ID or key — the app's Sign in with
Apple entitlement plus the deployed provider config carry it. The
`com.donkeycut.signin` Services ID and an `APPLE_CLIENT_SECRET` become
relevant only if the website ever adds its own Apple sign-in button.

## TestFlight

One-time setup: pick the team in the target's Signing & Capabilities
(automatic signing registers the `com.donkeycut.donkeycut` App ID with the
Sign in with Apple capability), and create the App Store Connect app record
named Donkey Cut on that bundle id.

After that, shipping a build is one command:

```bash
scripts/ship-ios-testflight.sh
```

It archives the app and uploads it to App Store Connect; Xcode manages the
build number so repeat uploads never collide. Auth comes from the Apple ID
signed into Xcode. Once processing finishes, internal testers in App Store
Connect → TestFlight get the build without review.

External testers are served from App Store Connect: add the processed build to
the tester groups and submit it for beta review, which is the step external
testers wait on. Apple reviews one build of an app at a time, so shipping twice
in an afternoon leaves the second build waiting on the first.

A build that testers install has to be a build you can go back to, so the
archive is cut from a commit: the script checks the ref out into a worktree of
its own and builds there, and whatever else is uncommitted in the checkout
stays out of the upload. `--ref` picks the commit and `--working-tree`
archives the checkout as it stands, for trying a build before committing it.

Export compliance is answered in the project (`ITSAppUsesNonExemptEncryption`
is NO) and the privacy manifest ships in the app target, so uploads land
ready to test.
