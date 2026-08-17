# Donkey Cut's AI Assistant

The assistant is the chat panel inside the Donkey Cut editor. It answers questions about the open project and edits it by calling typed tools against the live editor state, while the user watches the changes land. Three providers share one brain — the user's Claude Code login, the user's Codex login, and Gemini through Donkey's hosted inference — and all three get the same system prompt, tool catalog, and skills library; only the transport differs.

**The one rule: the model makes every decision.** No code inspects the user's words. A message goes to a model with the project state attached, and the harness acts only on the typed tool calls that come back. If you're tempted to write `if (text.includes("subtitles"))` anywhere in the chat path, that knowledge belongs in the system prompt, a tool description, or a skill.

## How a turn runs

The model decides *what* to change; whoever holds the project does the changing — usually the browser tab, and the engine or a worker container when no tab is there. Everything between them — the engine, the MCP proxy, the hosted route — is transport.

```
user message + @attachments + fresh <editor_state> snapshot
  │
  ├─ Claude or GPT model picked ──▶ local engine, /api/cut/ai/chat
  │       spawns the user's own CLI (Claude Agent SDK / codex exec),
  │       resumes that provider's session, streams the reply back
  │
  │       provider ──stdio MCP proxy──▶ engine ──chat stream──▶ browser tab
  │                                       ▲   runs the tool on the editor
  │                                       └── store, POSTs the result back
  │
  ├─ Gemini picked ──▶ hosted inference route (Donkey sign-in + credits)
  │       the page itself loops: model round → run the function calls
  │       on the editor store → send results back → next round,
  │       until a round returns no calls
  │
  └─ no tab ──▶ the same loop with the doc as its editor: the engine
          executes for a chat whose tab closed mid-turn, and a queued
          turn job runs the whole turn in the worker container
```

On the engine path, the chat route holds one streaming response open per turn. The provider sees a single MCP server named `cut`: a small stdio proxy the provider harness spawns, which forwards every tool listing and call to the engine over HTTP. The engine writes each call into the open chat stream; the tab executes it on the editor store and posts the result back; the engine hands it to the waiting provider. A call the tab never answers times out after two minutes.

A turn outlives its tab. The bridge remembers each session's project, so a call arriving after the editor stream closed runs in the engine itself: the doc on disk hydrates into the same editor store, the tool runs, and the result lands back on disk — re-read fresh each call, so a page save between turns survives. Tools that need the page's decoders or its hosted sign-in answer with a typed refusal, and the mapping drops when the provider run settles so a reloaded tab never races a leftover executor.

The Gemini path skips the engine entirely — the same carve-out as AI media generation. The loop runs on the pi agent harness (the `@earendil-works` packages) in the browser: a custom transport speaks Donkey's hosted responses route with the user's session, tools execute directly against the store, and each thread's conversation persists as the harness's own structured history — past tool calls replay as real tool records, so no bookkeeping rides as prose the model could imitate. Gemini's quirks live in that transport: thought signatures replay exactly with each call, tool media returns as its own following turn, and an empty round retries before it surfaces as an error.

The turn's route is decided by an intent gate while the turn is already running. A light-model call judges the newest message three ways — a turn that requests nothing, one self-contained ask, a composed job — and the first round goes out immediately on the light chat model with the full catalog while that call is in flight. Tool execution waits on the verdict and the round's output buffers: a simple verdict (the common case) releases the buffer and keeps the run, so the gate costs no wall time, while a chat or complex verdict discards the speculative run with nothing shown and nothing executed and restarts the turn routed — every tool declaration withheld for chat, the full model for a composed job or any classifier doubt. A message carrying attachments is complex on sight and runs routed from the start.

The same loop code runs with no browser at all. A headless session opens a project doc into the editor store, binds both transports at an explicit origin with auth headers, and runs the production chat loop against it — which is how a chat turn becomes a durable job. The page or an API caller posts a thread's messages to the cloud project's turns route; the row is the project's agent write lease (one turn at a time per project); the worker container claims it, runs the turn under a runner grant that spends that user's credits and writes that user's project, pushes the doc back through the versioned PUT, and appends the finished exchange to the stored thread.

A job can do everything a tab can, because the same tool code runs over swapped primitives. The library draws, decodes and measures through narrow seams — a canvas factory, a frame sink, a font installer — which the page fills with the browser's own and the container fills at startup with a native canvas, native decoders, a Web Audio graph, and the editor's font files staged in the image. So watching footage, cutting on silence, freezing a frame, matting a sticker, writing captions and capturing the composited frame all behave in a job the way they behave in the tab, and parity holds by construction: there is one implementation. Two things stay page-only — on-device MediaPipe matting, which falls through to the hosted vision path, and Lottie stickers, which need a DOM.

Two mechanisms keep a turn honest. A mutation ledger, computed in code from the tool results, rides every model call as an ephemeral context note: what ran, what failed, and what debris the edits left (a parked transition bar, an item stranded past the video's end) — the model must fix or plainly report each entry before its reply lands, and the note is never stored or rendered. And the round budget extends itself: a build that outgrows its 24 rounds gets fresh budget automatically (up to three extensions, so 96 rounds in all), so the user never types "keep going". At the ceiling tool calls stop and the model gets one round to say where it landed; a turn still reaching for tools ends with a line offering "keep going".

The composer stays open while a turn runs. A message sent mid-turn waits in a small tray on the composer's top edge and goes out when the running turn settles — one turn at a time, each with a fresh editor snapshot, so a queued ask always sees the edits made before it. The tray is the review surface: waiting rows can be reordered, rewritten, or removed, and the queue pauses and resumes from its header. While a row is being rewritten the list holds still — the row under edit waits, the others keep draining and cross out in place as they finish. Stopping a turn or hitting an error pauses the queue automatically, so the remaining asks hold for review. Waiting rows are saved with the thread on the machine: a reload or a trip to another project brings them back paused, ready to resume.

Which path runs is chosen by the model id alone. The picker lives in the page so a site deploy updates it for everyone; the engine only reports which CLIs are installed and signed in (probed and cached for a minute), and the page overlays Gemini availability from its own sign-in probe.

## What the model knows

Every knowledge surface is defined once — the catalog file ships in the engine and is bundled into the page, so all providers read identical text.

| Surface | Size today | When it enters context |
| --- | --- | --- |
| System prompt | ~10K chars (~2.5K tokens) | Claude: replaces the Agent SDK default. Codex: prepended to the first turn (a resumed session already has it). Gemini: the instructions field, every round. |
| Tool catalog (87 tools) | ~75K chars (~19K tokens) | Claude/Codex: the MCP tool listing. Gemini: function declarations on each request. |
| Skills library (11 docs) | ~40K chars (~10K tokens) total | On demand only, via the list-skills and read-skill tools. |
| Editor snapshot | Grows with the project; media list and subtitle cues capped at 60 each | Attached to the newest user message as `<editor_state>`, rebuilt fresh every turn. |
| Attachments | Metadata JSON per asset | `<attached_assets>` on the message that carried them; on the Gemini path the newest message also carries the actual payloads (frames, images, text contents). |
| Full state | Uncapped | The get-state tool — the model calls it when the snapshot is stale or truncated. |
| The rendered frame | One 640px JPEG | The capture-frame tool: the composite an export would write at that time — footage, transitions, effects, elements, captions — at the playhead or any time asked for. |
| The footage itself | Up to four 3×3 contact sheets per call | The watch-video tool: the browser decodes candidates on a dense steady floor, keeps only the frames that differ, tiles them into sheets stamped with their source times, and reports refined hard-cut times. Any captions or transcript fuse in as one clock, so each kept frame sits inside the speech it belongs to. Detect-silence reports dead air the same way, numbers only. |

The system prompt carries the voice, the deliverable rule (below), id discipline, the undo-versus-credits asymmetry, and pointers into the skills. The skills carry the deep per-area documentation — editor overview, timeline editing, watching and cutting by content, transitions and fades, graphics (titles, shapes, stickers, composite builds), audio and subtitles, stock and generation, scene productions, editing taste, media and library, publish and export — so the always-on cost stays near 21K tokens and detail is pulled only when the model works in that area.

The snapshot is a compact JSON picture of everything user-visible: project meta, playhead, selection, every media asset with its origin tag, the video track with gaps and transitions, overlay video, soundtrack, titles, subtitle tracks with the first 60 cues, publish metadata, and view state. Numbers are rounded to two decimals and empty fields are omitted. When a list is truncated the snapshot says so, which is the model's cue to call get-state.

## The decision layer

Deciding what the user wants is prompt text, executed by the model. The prompt orders the calls it must make each turn:

1. **Deliverable first.** "Write me a caption / a script / a prompt" asks for words — the answer goes in chat and the project stays untouched until the user says "do it". A request to change the project gets acted on directly with tools.
2. **Doing beats asking.** Edits are free to reverse (unlimited undo), so the model acts on reasonable interpretations. Generation is the exception: undo removes the clip but credits stay spent, so it generates only when the user asked for the media itself.
3. **Free before paid.** Bundled stock is checked before spending generation credits when existing media could serve.

"This" resolves to the current selection, ids come verbatim from the state, and unfamiliar areas trigger a skill read first.

## Doing the work

With a tab attached, tool calls execute in it against the same store the user is editing — same state, same selection, same undo history.

- **Readable failure, then retry.** Tools validate and clamp their inputs and throw human-readable errors ("No clip with that id — call get_state for current ids"), which return to the model as tool errors it can recover from. A dropped bridge is separate from a bad request: the idempotent tool listing retries on a momentary engine hiccup so the model never lands with an empty tool set, and an "unreachable" call is one the model quietly re-issues, keeping talk of reconnecting out of the reply.
- **One undo step per turn.** History batches while the assistant is busy, so ⌘Z reverts the whole turn in one step.
- **Small results.** Tools return ids and rounded numbers, plus a short note when behavior surprised ("that spot was taken — slid right").
- **Frames become images.** A tool result's `image`/`images` data URLs leave the JSON and reach the model as real images on every path — the engine bridge emits MCP image blocks after the data text, and the Gemini loop rides the first on the function response and the rest as image parts. Watching happens in whatever model the user is chatting with; there is no side model.
- **Watching leaves a map.** A watch records which moments and cut candidates a source holds, persisted on the asset so it survives the thread, and the first watch of a source starts a quiet background sweep that maps the rest. The map aims later watches; only sheets returned in the conversation count as footage the model has seen.
- **Media rides a byte budget.** Contact sheets, audio, and attachment payloads all replay inline, so before each call the session is trimmed to a 16MB media budget — oldest parts leave first, with a note naming the tools that fetch them again. Text, tool calls, tool results, and thought signatures always survive, and the trim runs on a copy so the stored session keeps everything.
- **A link comes back as whatever it holds.** The chat's URL import works down a ladder: the bundled downloader for anything with a stream, X's own endpoints for a post's photos or Article, and otherwise the page itself — a content extractor (Defuddle over a parsed DOM) lifts the article out as markdown and the pictures it kept come along as assets. Words with no media are a successful import, so a link the user pasted to explain something reads fine, and that text is quoted for the user beside whatever media came with it.
- **Async when rendering.** Video generation outruns the two-minute tool window, so those tools start the job and return immediately; the clip files under the chat that asked — the owning thread is captured at call time — and lands on the timeline only when the user asked for that. Each render's card state (running, landed, failed) mirrors into the project doc as it changes, so the chat shows the same outcome on machines that never ran the job.
- **Chat owns what it makes.** Media created by chat tools is tagged with its thread and previews on a card in the conversation. Placing it on the timeline or filing it into Media or the Library transfers ownership; deleting the thread deletes whatever it still owns.
- **Chat media is the account's storage.** It is real project media: it counts toward the cloud quota and the project's size like an import, and the thread is the only place it can be seen or deleted from. So conversations travel wherever their media travels — a project moved between the Mac and the cloud, an owner's duplicate, and a share copy with chat shared all carry the threads with the files. A copy that took the files alone would hold media nobody can find, delete, or explain, and the user would still be paying for it.
- **Two tools stay server-side.** The skill list and skill reads are answered by the engine directly — no browser hop.

## Generating a whole video

Most generation tools make one asset — an image, a video clip, a voiceover, or a music track (`generate_music`, a vocal-free bed by default and a full sung song on request, scene-aware enough to score a whole video, and able to match a track to a reference the user attaches — an audio clip to emulate or a video whose tone it should carry, since the music model reads only text a multimodal pass turns the reference into the sound description it renders from). `generate_scene` makes a whole cut: it writes a script, breaks it into shots, and — once the user approves — renders each shot and lays them on the timeline. The video model speaks each shot's line, so the clips carry their own narration; a music bed sits under them. It is genre-agnostic; the look comes from the brief and any references. It can also animate audio the project already has (`from_audio_asset_id`), tiling shots over that spine with no script written.

Because a scene renders many paid shots, the tool plans and then stops. `generate_scene` returns a shot list and waits; `approve_scene` starts the renders; `regenerate_shot`, `recut_scene`, and `restyle_scene` revise afterward; `cancel_scene` kills the active run. A plan created this turn cannot be approved in the same turn — the harness blocks that call whatever the model decides, so the money gate is structural. The plan the user approves is the plan that renders: voicing runs after the gate and only rescales the approved shots to the real voice lengths (a line longer than one clip splits its shot). The run is browser-side like every generation here, held in a small store beside the panels (`lib/genScene.ts`) so switching tabs never orphans it; leaving the project pauses it, its persisted plan (`ProjectDoc.genvideo`) resumes on the next open, and a run that dies persists as failed so a reload never resumes it. Nothing runs behind the user's back: cancelling, dismissing an unrendered plan, or deleting the chat thread that asked all stop the run and clear its plan — clips already placed stay on the timeline. Progress shows on a card in the chat while the timeline fills on its own. The shots ride under one consistent AI voice with the video model's own audio off; this version has no talking-head lip-sync.

## Context across turns

Threads persist per project in the browser's local storage — the newest 30, titled by their first message. A cloud project also mirrors each thread to the hosted chat routes (Postgres, keyed to the account), merging the server copy back into local storage on open, so its history follows the account across devices. What a returning thread remembers depends on the provider:

- **Claude and Codex hold their own history.** Each turn sends only the newest message plus the fresh snapshot; prior turns live in the provider's native session, whose id is saved on the thread and resumed. The engine never replays conversation history itself.
- **Gemini replays its own session.** The pi harness keeps the thread's conversation as structured history — real tool calls and their results — and saves it with the thread, so a reload picks it back up. Every call is replayed from that history with only the newest snapshot kept and media trimmed to budget; a thread with no saved session falls back to a text-only replay of what the panel shows.

A thread saves one session slot per provider, so switching models mid-thread keeps each provider's own context. The asymmetry to know: Gemini can pick up any thread because it replays the transcript, while a CLI provider joining a thread it hasn't chatted in starts from only the newest message.

## Limits

| Limit | Value |
| --- | --- |
| Provider turns per request (Claude) | 30 |
| Tool rounds per turn (Gemini) | 24, extending to a 96 ceiling |
| Inline media per model call | 16MB, trimmed oldest-first |
| Browser tool execution | 120s |
| One watch-video call | 600s of source, 4 sheets (36 frames), 150 decoded candidates, a 90s decode budget; the result says where coverage stopped |
| Snapshot caps | 60 media items, 60 cues |
| One queued turn job | 1MB of messages, one live turn per project |
| Saved threads per project | 30 |
| CLI availability probe cache | 60s |

## One-shot helpers

Three narrow AI calls run beside the chat, each a single engine round-trip through the user's Claude login on a small model: the caption style rewrite, caption translation, and visual subtitles (sampled frames in, timed narration cues out). The panel buttons and the chat's subtitle tools reach them through the same store actions. The style rewrite falls back to the original lines on failure; translation fails loudly instead, because filling a track with the wrong language would be silent corruption.

A hidden hermetic test provider exercises the full engine bridge — context, tool round-trips, streaming — without spending tokens; end-to-end tests select it as their model.

## Measuring the assistant

A live eval scores the chat brain's behavior and speed together. Each of its cases replays a real composer turn against the live model — through the same loop code production runs — and asserts what came back: the reply, the tools called, the gate verdict, tools that must stay sheathed, and the reply's shape (no leaked scaffolding, no trailing upsell), with a light-model judge leaving tone notes beside the pass/fail. All of it is timed: the gate call, time to first token, every round, every tool serve. Cases carry a bucket (chat turns, single-tool edits, multi-tool composed edits) so the numbers aggregate by the kind of turn a user feels.

The committed report at `evals/cut-chat.latest-report.json` is the baseline. The improvement loop: make one change — a model role, a prompt line, a tool description — run the eval, and keep the change only when pass rates hold and the medians improve; the new report commits with the change, so the baseline always describes what ships. This is how the complexity router and the batched-round cutting flow earned their way in. Run it with the dev server up: `npm run eval:cut-chat` (add `--matrix --runs 3` to compare model configs); the README beside the harness under the site's `scripts/lib/cut-eval/` folder covers the flags, the report schema, and how to add a case. The tab-less paths have their own end-to-end scripts, which drive a real turn against a seeded cloud project through the headless session and through the queued turn job.

## Where it lives

The shared catalog (system prompt, tools, skills), the chat route with its provider runners, the browser-tool bridge, its tab-less executor (`server/ai/headlessTools.ts`), and the stdio MCP proxy live with the engine's AI code under the site's `cut/` folder (`server/ai/`, `server/http/ai.ts`). The page side holds the snapshot builder (`lib/aiContext.ts`), the tool implementations (`lib/aiTools.ts`), the pi-based chat loop and its adapters (`lib/pi/`), the model catalog (`lib/aiModels.ts`), and the chat panel with threads and transport (`components/AiPanel.tsx`). Running the same loop with no browser is `lib/headless/`, the turns route in `server/cloud/turns.ts`, and the worker job in `worker/turnJob.ts`.

The brief-to-video pipeline is its own subsystem: the orchestrator, coverage invariant, and role interfaces in `lib/genvideo/`, its hosted-model adapters in `lib/genvideo/adapters/`, the browser controller in `lib/genScene.ts`, and the progress card in `components/SceneCard.tsx`. Its strategy — story planning, the identity ladder, where audio goes next — is the [Brief to Video](brief-to-video.md) guide.
