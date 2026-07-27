# Cut

Cut (publicly "Donkey Cut") is a standalone, free video editor. Its product domain is `donkeycut.com` — a marketing landing at `/` and the editor at `/app/…`; old `cut.donkeyuse.com` links are redirected there at the edge (Cloudflare). The host serves only the client bundle — every page is client-rendered — and the page does all real work against the Cut engine: a local server the Donkey Mac app ships and supervises on the user's own Mac. The engine uses local disk, the app's bundled ffmpeg, on-device speech, and the user's own Claude/Codex CLI logins. Using the app requires a Donkey sign-in, and every engine request carries the signed-in account id: each account's projects and library live in that account's own folder on the Mac, so accounts sharing a machine don't see each other's work. AI generation — images, video, and voiceovers — and the assistant's Gemini models additionally spend credits: the page posts to Donkey's hosted inference routes with the user's session and credits. `donkeycut.com` owns sign-in directly — the auth pages and the Google callback serve on that host — so the session is a plain host-only cookie. Generated media lands back in the project through the engine like any other file; Gemini chat turns, including their editor tool calls, run entirely in the page.

**The engine rule:** the engine API surface (`/api/cut/*`) runs only on the user's Mac. On a hosted deploy every one of those routes answers 404 before any handler runs, so the unauthenticated routes are unreachable there and nothing can execute off-Mac — the engine has no path to Donkey's production models; the page reaches them only through Donkey's own authenticated inference APIs. Don't wrap the engine's routes in the Donkey auth helper, reach for Prisma from them, or bill them against credits; local-only is the design for everything the engine does.

Web mode adds a second surface with the opposite rules on purpose: `/api/cut-cloud/*` is the engine's hosted twin — the same route shapes, but session-authenticated, storing docs in Postgres and media in R2, and metering model calls through credits. A project lives in exactly one place (this Mac or the cloud), and the client picks the surface per project; the two surfaces never proxy to each other. See [Web mode](#web-mode).

## How it works

The hosted domain and the local engine split the work: the page comes from wherever is convenient, the work always happens on the Mac.

```
page from donkeycut.com (hosted)          page from localhost/cut (local dev)
  │  client bundle only;                    │  one local server:
  │  every Cut API 404s there               │  pages + APIs, same origin
  ▼                                         ▼
browser ── API calls ──▶ Cut engine on 127.0.0.1 (spawned by the Donkey app)
                           │
                           ▼
             local disk · bundled ffmpeg · on-device speech
             · the user's own claude/codex CLI logins
```

**What loads is cached locally.** Every visit re-reads the same three things: the projects listing, the library, and a project's document. The browser keeps the last answer to each in IndexedDB, scoped to the account and the backend that served it, and paints it on arrival while the real request runs behind it. So returning to a project draws on the next frame instead of after a round trip, and a project you just created opens on a document the client already knows is empty. A snapshot is a head start and the live answer always replaces it; where the two disagree the server wins. The one exception is an edit made on top of a snapshot — that is kept rather than overwritten, saves like any other edit, and a cloud project whose stored copy really has moved on answers that save with the version conflict it already had.

The client probes the engine's health endpoint (dedicated port first, dev server second) and remembers the winner. Browsers permission-gate a hosted page's calls to the local machine, so the first hosted visit holds on a connect screen and fires the browser's permission prompt from the user's own click; a denied permission gets its own recovery screen. The engine grants the hosted origin cross-origin access, and only that origin. Without a running engine the page shows a "get Donkey / open Donkey" state that connects by itself as soon as the engine appears — unless web mode is on, in which case the page passes straight into cloud-only editing instead of walling. Engine updates ride the Donkey app's own auto-updater, so the client never prompts to update.

## Web mode

Web mode makes Cut usable in any browser on any OS with nothing installed. It ships behind the `cut-web-mode` flag — a per-browser toggle in the account menu that takes effect live. With the flag off, everything above is the whole story and behavior is unchanged.

Every client call goes through a backend seam (`site/src/cut/lib/backend/`): the local driver is the engine transport unchanged, and the cloud driver rewrites the same paths to `/api/cut-cloud/*` with the session cookie. Residency is per project — the home screen lists "On this Mac" and "Cloud" sections, each served by its own driver, and opening a project binds the editor to that project's backend. Capability flags on the driver hide what a backend can't do, so components never feature-detect.

The library is the exception, because it is a shelf rather than a place: it lists every residency the browser can reach at once — the Mac's when an engine has answered, the cloud's when web mode is on — as one listing, newest first, with a badge saying which shelf each item is on. So a cloud project can pull a clip off this Mac, and a local project can pull one out of the cloud. Each item's own shelf answers for it: previews, renames, and deletes go to the backend it came from, and folders belong to one shelf, so items file only into folders beside them. Adding to a project is the one crossing: on the project's own shelf the server copies the file without the bytes leaving it, and off it the browser carries them down and back up.

Cloud projects store their doc in Postgres (versioned; a stale autosave 409s and the editor reloads the newer copy) and media in R2: uploads go direct from the browser on presigned URLs (the hosted functions never see the bytes), playback streams on signed range URLs, and a flat per-user quota is enforced at presign time. That quota is visible rather than implicit: a free account editing a cloud project sees what it has used in the editor's top bar, and a presign rejected for space opens an upgrade offer wherever it happened instead of a bare error. The same slot carries the countdown when a subscription is set to cancel, and clicking it opens the billing portal.

A dropped file does not wait for that upload. Because a presign claims the stored name before any bytes move, and the browser can read the file it was handed, an import is measured, named, and placed on the timeline in the same moment it is dropped — playing from the local copy, filmstrip and all — while the bytes go out behind the editor. The saved document is what keeps this honest: an import still uploading is left out of it, along with the clips that use it, so a tab closed mid-upload leaves nothing to reopen broken, and the asset and its clips join the document the moment the upload lands. Export waits on the same line, since a render reads the saved document.

Storage a subscription paid for outlives the subscription for a while: when Pro ends and the account still holds more than the free tier, it keeps everything for thirty days, warned in the editor and on the projects home. After that the daily sweep brings it back under the cap — least-recently-updated projects first, then the oldest library assets, stopping the moment it fits — so what survives is the recent work, and an account already under the cap is never touched.

A cloud project can be shared read-only, Google-Docs style: the editor's Share dialog invites specific emails (viewers sign in) or opens the link to anyone (no sign-in), and switches opt extra surfaces in — chat, media, AI generations, subtitles, details — on top of the always-shared preview and timeline. The share row's id is the link token, so revoking deletes the link. Viewers ride a third backend driver against `/api/cut-shared/<token>/*`, a deliberately public API surface (the one exception to session auth on the cloud side): the server resolves access per request, filters the doc to the shared surfaces before it leaves, and refuses media outside that filter, so hiding is enforced by the backend rather than the client. A public share's reads are cached at the edge for a lifetime that tracks how long the owner has been idle — a doc saved seconds ago is served near-live, one untouched for an hour is served from cache for minutes — and the same number is handed back as the viewer's poll interval, so a link a crowd opens costs a handful of origin requests rather than one per viewer per tick. A restricted share's reads depend on the viewer's session, so they are never cached. A shared project's media is served from Cloudflare's edge rather than presigned against R2's S3 endpoint, which nothing caches: a Worker holding a private bucket binding checks a short token the hosted API mints, then answers from cache keyed on the object alone. Dropping the token from the cache key is what makes the token affordable to keep short — every viewer and every re-mint share one cached copy — and a short token is what makes unsharing mean something, since a presigned URL is a bearer credential nothing can withdraw before it expires. Owner-side editing still presigns R2 directly, where the URLs are minted on fixed windows so a browser can reuse bytes across reloads. A shared link unfurls with the project's own card: the render worker derives a first-frame still and a five-second animation from the opening of the cut, the page's metadata points at them through a URL carrying the doc version, and a project with no card yet gets a drawn one. Viewers poll the doc version on an interval the server picks — shared views trail live edits, they don't stream them — and a "Copy project" action duplicates everything the share exposes — the filtered doc, its media, and the chat threads when chat is shared — server-side into the viewer's own account and quota. Copies queue rather than run in the request: each request writes a job row and publishes it to a Cloudflare Queue whose serial consumer executes one copy at a time, so a burst of copy requests can't stampede storage; the client polls the job for the outcome. An owner duplicating their own cloud project from the dashboard rides the same queue. Exports, hover-preview proxies, share cards, and URL imports run on the render worker — a container (`site/src/cut/worker/`) that claims job rows from Postgres, reuses the engine's exact ffmpeg pipeline against R2, and reports progress back through the rows the client polls. Transcription and mic dictation call a hosted, credit-metered route that has Gemini produce cue-level timestamps from browser-rendered audio chunks; word timings are interpolated within each cue. The assistant offers its Gemini models (which already run entirely in the page); the Claude/Codex CLI providers stay app-only because they are the user's local logins.

## One API surface, one router

Every Cut API route is a framework-free handler (web-standard request in, response out) registered once in a route table (`matchCutRoute`), namespaced under `/api/cut/*` to keep it clear of Donkey's own APIs. Both surfaces dispatch through that one table: the packaged engine mounts it directly, and the Next dev server reaches it through a single optional-catch-all route (`/api/cut/[[...slug]]`). They are the same router — static-over-dynamic precedence, HEAD, and 405s behave identically, and there is nowhere for the two to drift. The hosted 404 is applied once, in that shared dispatch.

The shared dispatch also binds each request to the account id the page sends, and every project and library path builds on that account's folder — only the health probe runs outside a scope. A request without an id is refused before any handler runs. The engine has no way to verify the id (it never talks to the hosted backend), so this separates accounts that share a Mac; it is not protection against a hostile local user, who owns the disk anyway. Data written before scoping existed is adopted by the first account that connects.

## The engine

The engine is a single compiled binary built from the site's Cut code and version-locked to the app: the app's dev run script and release packaging build and bundle it automatically (no separate step), and the app stamps its own release version into the engine's environment, so updates ride app releases. The Donkey app spawns it at launch — regardless of sign-in, since Cut is free and standalone — restarts it with backoff if it dies, and stops it on quit. The engine's lifetime is tied to the app process: the engine watches the pid that spawned it and exits when that process is gone, and at launch the app replaces an engine on the port stamped with a different version, so engine fixes always ship with the app update. An engine matching the app's version (another instance) or a developer-run "dev" engine is left alone. Its data lives under the user's Application Support, one folder per Donkey account; its logs under the user's Logs folder.

Because a GUI-spawned process inherits a bare PATH, the engine rebuilds it: tools shipped beside the engine binary first (they version with the app), then the app's bundled tools (bundled tool always wins), then the user's login-shell PATH and common install dirs. That is how it finds the speech tool, ffmpeg, and the user's `claude` and `codex`.

## Boundary with Donkey

| Concern | Donkey | Cut |
| --- | --- | --- |
| Sign-in | Required account | Required account; local data is per-account on the Mac |
| Billing | Credits | Free; AI generation, Gemini chat, and cloud transcription spend credits |
| Storage | Database | Local disk; cloud projects use Postgres + R2 behind a per-user quota |
| Model access | Hosted routes | CLI logins; AI generation, Gemini chat, and cloud transcription use Donkey's hosted routes (signed in) |
| Distribution | The Mac app | Rides the same app; web mode needs no install |

The only shared code runs one way: Cut uses a few site UI utilities and the Donkey auth/credits helpers on its cloud surface, and the engine rides the app's process-environment helpers. Nothing in the Donkey product imports Cut. Cut's database models live in their own schema file (`site/prisma/Cut.prisma`) and carry plain user ids.

## Local resources

Missing tools disable the matching feature; they never affect the rest of the site or app.

| Feature | Needs |
| --- | --- |
| Encode, probe, thumbnails | the app's bundled `ffmpeg`/`ffprobe` |
| Transcription, subtitles, and voice dictation in prompt inputs (assistant, image/video/audio generation) | prebuilt `cut-stt` shipped beside the engine binary (the plain dev server falls back to compiling it); dictation streams live mic audio through its `--live` mode |
| AI assistant | the user's own `claude` and `codex` CLI logins; its Gemini models use a Donkey sign-in and credits instead |
| AI generation (image / video / voiceover) | a Donkey sign-in and credits |
| Projects, library, exports | writable local disk (Application Support when run as the engine) |

## The assistant's knowledge

The AI assistant knows the editor through three surfaces: the catalog — tool definitions, the skills library, and the system prompt, shared by every provider — the browser-side tool implementations that run those tools against the live editor store, and the per-turn context snapshot sent with each message. The catalog lives with the engine's AI code; the implementations and snapshot live with the editor client code. How a chat turn actually runs — providers, the tool bridge, context budgets — is its own guide: [Cut's AI Assistant](ai-assistant.md).

**Teach the assistant in the same change.** When an editor feature lands, changes, or goes away, update those surfaces with it — usually by adding, updating, or deleting the matching tools and skills, and by extending the context snapshot when the feature adds user-visible state. A feature the catalog omits is invisible to the assistant, and a stale tool or skill is worse: the assistant confidently acts on behavior that no longer exists.

## Where it lives

The editor, its handlers, and the engine entry sit under the site app's Cut folder; host routing, the hosted API shut-off, and the CORS grant live in the site's proxy file (`src/proxy.ts`, the Next 16 successor to middleware). The app-side supervisor lives with the Donkey runtime code, and the packaging scripts stage the engine binary into the app bundle.
