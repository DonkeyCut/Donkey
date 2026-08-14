# Fast Donkey: tool-first Command Layer + always-on Gemini Live

> **Status: implemented end to end.** Command Layer (Phase 1) and the always-on Gemini Live
> session (Phase 2) are built, unit-tested, and wired into the overlay. The backend mints
> short-lived Vertex AI OAuth tokens (`POST /api/inference/live-token/`), the client connects
> directly to the Vertex Live websocket with a Bearer token, text/audio route through the session,
> tool calls execute against the Command Layer, and the mic can stream continuously. Gemini Live is **enabled by default** and takes over once it
> connects; if it can't authenticate it stays disconnected and the existing pipeline runs
> unchanged. The text path is verified end-to-end against real Vertex credentials by
> `GeminiLiveCommandSessionLiveSmokeTests` (mint token → websocket → `setupComplete` → text turn
> → tool call → Command Layer → result). Remaining work is live verification of the optional
> microphone/audio input.

## Context

Donkey is text-first, but slow to *act*. Historically it could only act two ways: generate
AppleScript (a second model round-trip) or fall into a vision loop that screenshots and
re-prompts every turn with a fixed 1.2s sleep (`UserQueryCommandHandler.swift:727`, `:805`).
There was no fast "just do it" substrate — no `open`, no native command.

The goal: **tool-first, screen-last.** Give the model a set of fast, deterministic native tools,
and let an always-on Gemini Live session drive them from text (audio optional), only looking at
the screen when a task genuinely needs visible state.

```
text  (always)  ─┐
audio (optional) ─┤→  Gemini Live session  ──tool call──▶  Command Layer  ──result──▶  back to Live
screenshot (only when needed) ─┘     (fast, native, in-process; no screenshot/AX)
```

## Phase 1 — Command Layer

Fast native, in-process tools the model calls directly. Under ~500ms, no screenshot, no AX tree.
A deliberately small set:

| Tool | Implementation |
|---|---|
| `shell_exec` | runs a safe, single-line shell command via `/bin/zsh -c` and returns its output — the primary, general-purpose tool |
| `apps_list` | reuses `MacLocalAppAvailabilityProvider.installedApplications()` (Spotlight-backed, names + bundle ids, includes Apple native apps) + running apps so the model targets exact names instead of guessing; the installed list is paginated (`filter`/`offset`/`limit`, with `hasMore`/`nextOffset` in the result) so the full catalog survives the response cap |
| `app_skill` | looks up the installed operating playbook (skill pack) for a specific app — discovered by the skill's `apps:` frontmatter, never a hardcoded list — and advertises the skill's validated scripts |
| `skill_run` | executes a validated script an installed skill ships (by the `skillID`/`scriptID` that `app_skill` advertised) — the generic native fast path for any skill-covered multi-step workflow a one-liner can't reproduce (e.g. the `music-media` search→play script) |

`shell_exec` is the **primary, general-purpose tool** (the same capability the competitor's
Realtime setup exposes) — listed first and prioritized in the system instruction. It handles most
requests directly: opening/quitting/controlling apps (`open -a Spotify`, `osascript -e '…'`),
changing settings, opening URLs (`open https://…`), and reading system state. Earlier dedicated
tools (`app.open`, `app.quit`, `browser.open_url`, `system.set_volume`) were **removed** as
redundant once `shell_exec` could do them reliably; what remains is generic — `apps_list`
(discovery is awkward via raw shell) and the `app_skill`/`skill_run` pair (skill discovery and
validated-script execution; the earlier hardcoded `music_play` tool became the `music-media`
skill's script, reachable through them). The
model is told to send only safe single-line commands; a backstop guardrail in
`DonkeyCommandBackends` enforces single-line input, a length cap, and a hard ~12s timeout
(SIGTERM→SIGKILL). Unsafe commands are caught by a **command-word** check on each pipeline/segment
leading executable (so bare `rm`, `/bin/rm`, or a denied command inside `$(…)` is caught) plus a
short list of dangerous substrings (`do shell script`, `| sh`, redirects to `/dev`/`/system`/…) —
chosen over the earlier substring denylist, which both missed bare destructive commands and
false-positived on benign redirects.

Tool results are returned to the Live model in full — `status`, `summary`, the execution metadata
(`stdout`, `stderr`, `exitCode`, `reason`), and any clarification `question` — so it can read
output and self-correct, or ask the user when a tool needs input.

**Where it lives / how it's wired.** `DonkeyHarness` only depends on `DonkeyContracts` and can't
import AppKit, so it follows the codebase's existing injected-closure pattern (like
`appleScriptExecutor`):

- `DonkeyHarness/DonkeyCommandLayer.swift` — tool descriptors + the shared `Command` enum
  (single source of truth for the command names).
- `DonkeyRuntime/DonkeyCommandBackends.swift` — the native side effects.
- Injected via a new `HarnessBuiltInToolServices.commandExecutor` closure, wired in
  `LocalAppUserQueryHarnessServices.builtInSkillBackedServices()`.
- Dispatched from the `default` branch of `BuiltInHarnessToolExecutors.execute` (before
  `unknownTool`), and merged into `BuiltInHarnessToolCatalog.descriptors` so the tools surface to
  the model automatically (they're `.reversible`/`.guardedInput`, so the planner's tool-name
  filter keeps them).

This removes the AppleScript-generation hop and the vision loop for common commands.

## Phase 2 — Always-on Gemini Live session

A single Live session is the command brain. **Text input is always available; audio is an
optional second input** (the existing `MicrophoneWaveformMeter` gained an additive
`onAudioFrames` hook). Tool calls map to the Command Layer; screenshots are sent in-band only
when a task needs visible state.

Files (`DonkeyAI/` unless noted):

- `AIRealtimeSession.swift` — transport-agnostic protocol + event model (parallel to the
  request/response `AIHTTPClient`; this one is a persistent socket).
- `GeminiLiveSession.swift` — `URLSessionWebSocketTask` actor: setup advertising the Command
  Layer tools, context-window compression, session resumption, and transparent `goAway`/drop
  reconnect.
- `GeminiLiveProtocol.swift` — `JSONSerialization`-based message builders + tolerant event parser
  for the `BidiGenerateContent` wire format.
- `CommandLayerFunctionDeclarations.swift` — maps `HarnessToolDescriptor` → Gemini function
  declarations.
- `GeminiLivePCM.swift` — mono float32 → raw 16kHz PCM16 LE (Live's input format).
- `GeminiLiveConfiguration.swift` — env config (below).
- `Donkey/GeminiLiveVoiceController.swift` — owns the session, runs the tool-call loop against a
  Command Layer `HarnessToolRegistry`, and routes anything the model didn't tool-call back to the
  normal pipeline via `onComplexRequest`.

### Routing decision — no string matching

Per requirement, the execution path is **always the model's decision**. There is no phrase table
or deterministic prefilter: the Live model chooses a tool call (act now) vs. asking for the screen
(visual task) vs. a plain reply. The speedup comes from the model *preferring* a fast tool, not
from bypassing it.

### Authentication — two paths (`GeminiLiveConnectionFactory`)

`GeminiLiveConnectionFactory.makeProvider` picks the connection path from config:

- **Developer API** (`GEMINI_API_KEY` set): connect directly to
  `wss://generativelanguage.googleapis.com/ws/...BidiGenerateContent?key=<KEY>` with the hardcoded
  `GeminiLiveConfiguration.defaultModel`. No backend round-trip. **Dev-only** — a client-held key;
  not for production. That model is **audio-output only**: the session requests `AUDIO` response
  modality (`GeminiLiveConnection.audioOutput`, on by default in code); tool calls and output
  transcription still flow, which is all the Command Layer needs.
- **Vertex AI** (no key — production): the backend authenticates with Google Cloud OAuth
  (service-account) credentials. `DonkeyBackendInferenceClient.mintLiveConnection()` →
  `POST /api/inference/live-token/` (`site/src/app/api/inference/live-token/route.ts` +
  `site/src/lib/inference/vertex-live.ts`, `cloud-platform` scope) mints a short-lived access token
  and returns the Vertex Live websocket URL (`{location}-aiplatform.googleapis.com`, or
  `aiplatform.googleapis.com` for `global`) + fully-qualified model path. The client connects with
  `Authorization: Bearer <token>`; the long-lived credential never leaves the backend, and the token
  is re-minted on every (re)connect. TEXT response modality.

Both produce a single `GeminiLiveConnection` (url + optional bearer + model + audioOutput).

### Configuration

Everything about the Live session — always-on, mic audio off, audio-output on, model ids, and the
Vertex `global` location — is fixed in code. Only two secrets are read from the environment; both are
optional depending on the auth path.

| Variable | Where | Meaning |
|---|---|---|
| `GEMINI_API_KEY` | client | **Dev-only secret.** When set, route the Live session through the Developer-API key path instead of Vertex. Default/production is keyless Vertex. |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | backend | Vertex service-account JSON used to mint tokens. |

### Two models: realtime command vs vision

The realtime Live session (`gemini-live-2.5-flash`) is the **command brain** — fast, tool-calling, screen-last. When a task genuinely needs the screen, the **vision** path uses a stronger turn-based model (`gemini-3.7-flash`) via `GeminiVertexVisionPlanner`: it calls Vertex `generateContent` with the window screenshot and returns the single next click/type/key (coordinates in Gemini's 0–1000 space, mapped to the window). `gemini-3.7-flash` isn't a Live/bidi model, so vision is per-turn `generateContent`, not the socket — slower per turn (~7s) but markedly better grounding than the realtime model. Both run on Vertex with backend-minted tokens.

## How the overlay is wired

`UserQueryOverlayModel` owns a `GeminiLiveVoiceController`, started on init (gated by
`isEnabled`). `submitCommand` routes through the session whenever `liveController.isConnected`:
text goes to `sendText`; the model's tool calls run against the Command Layer and report a short
status back via `onActed`; anything not satisfied by a tool call comes back through
`onComplexRequest` → the full local pipeline (`runLocalCommand`, never re-entering Live). When the
session isn't connected, `submitCommand` runs the local pipeline exactly as before.
`UserQueryOverlayController` streams the mic's `onAudioFrames` into the session via
`streamLiveAudioFrames` (no-op unless audio is enabled and connected); a batch voice transcript is
dropped while audio is streaming to avoid double-handling.

## Continuous audio

Mic-audio streaming is off in code today. When it is on and the session connects, the model fires
`onLiveAudioStreamingChanged(true)`; `UserQueryOverlayController` calls
`MicrophoneWaveformMeter.startContinuousListening()`, which keeps the engine running (and ignores
UI-driven `stop()`s) so audio streams beyond the voice-capture window. Tear down via
`stopContinuousListening()`.

## Configuration recap

Live runs against Vertex AI using backend-minted OAuth tokens (no client-held API key). It is always
on, at the `global` Vertex location, all fixed in code. The backend route needs
`GOOGLE_APPLICATION_CREDENTIALS_JSON`.

## Testing

This environment needs the full Xcode toolchain and a suite filter:

```
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --filter GeminiLiveTests
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --filter GenericHarnessTests
```

(A no-filter full run hangs on a GUI-dependent suite.) Covered today: Command Layer descriptors
surface + input validation (`GenericHarnessTests`), and Gemini Live config parsing, function
declarations, PCM packing, frame parsing, and the function-name identifier guard (`GeminiLiveTests`).
`GenericHarnessTests` has 8 failures that pre-date this work (confirmed via a clean-tree
`git stash -u` re-run).

For the real round trip, `GeminiLiveCommandSessionLiveSmokeTests` drives the whole text path
against a live backend + Vertex. It is gated behind `DONKEY_LIVE_SMOKE=1` and no-ops otherwise:

```
env DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  DONKEY_LIVE_SMOKE=1 DONKEY_WEB_BASE_URL=http://localhost:3000 DONKEY_DEV_AUTH_BYPASS=1 \
  swift test --filter GeminiLiveCommandSessionLiveSmokeTests
```

It mints a token, opens the Vertex Live websocket, waits for `setupComplete`, sends a text turn,
and asserts the model's tool call executes against the Command Layer without a harness-side
failure. This is what caught two real bugs the unit tests couldn't: the default model id had to be
a model that exists on Vertex (`gemini-live-2.5-flash`), and tool names must be valid function-call
identifiers — Gemini normalizes dots, so `apps.list`/`music.play` became unreachable and were
renamed to `apps_list`/`music_play`.
