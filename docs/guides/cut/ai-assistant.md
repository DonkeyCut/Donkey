# Cut's AI Assistant

The assistant is the chat panel inside the Cut editor. It answers questions about the open project and edits it by calling typed tools against the live editor state, while the user watches the changes land. Three providers share one brain — the user's Claude Code login, the user's Codex login, and Gemini through Donkey's hosted inference — and all three get the same system prompt, tool catalog, and skills library; only the transport differs.

**The one rule: the model makes every decision.** No code inspects the user's words. A message goes to a model with the project state attached, and the harness acts only on the typed tool calls that come back. If you're tempted to write `if (text.includes("subtitles"))` anywhere in the chat path, that knowledge belongs in the system prompt, a tool description, or a skill.

## How a turn runs

The model decides *what* to change; the browser tab holding the project does the changing. Everything between them — the engine, the MCP proxy, the hosted route — is transport.

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
  └─ Gemini picked ──▶ hosted inference route (Donkey sign-in + credits)
          the page itself loops: model round → run the function calls
          on the editor store → send results back → next round,
          until a round returns no calls
```

On the engine path, the chat route holds one streaming response open per turn. The provider sees a single MCP server named `cut`: a small stdio proxy the provider harness spawns, which forwards every tool listing and call to the engine over HTTP. The engine writes each call into the open chat stream; the tab executes it on the editor store and posts the result back; the engine hands it to the waiting provider. A call the tab never answers times out after two minutes.

The Gemini path skips the engine entirely — the same carve-out as AI media generation. The page posts the conversation to Donkey's hosted responses route with the user's session, executes any function calls directly against the store, and repeats until the model settles on a reply (at most 24 rounds). Gemini's thought signatures are replayed exactly with each call, and an empty round surfaces as an error rather than a blank bubble. A turn that exhausts the round budget ends with one tools-off call that summarizes what landed and what's left, so a long edit hands off cleanly ("say keep going") instead of dead-ending on a raw error.

Which path runs is chosen by the model id alone. The picker lives in the page so a site deploy updates it for everyone; the engine only reports which CLIs are installed and signed in (probed and cached for a minute), and the page overlays Gemini availability from its own sign-in probe.

## What the model knows

Every knowledge surface is defined once — the catalog file ships in the engine and is bundled into the page, so all providers read identical text.

| Surface | Size today | When it enters context |
| --- | --- | --- |
| System prompt | ~4.6K chars (~1.1K tokens) | Claude: replaces the Agent SDK default. Codex: prepended to the first turn (a resumed session already has it). Gemini: the instructions field, every round. |
| Tool catalog (65 tools) | ~43K chars (~11K tokens) | Claude/Codex: the MCP tool listing. Gemini: function declarations on each request. |
| Skills library (10 docs) | ~21K chars (~5.2K tokens) total | On demand only, via the list-skills and read-skill tools. |
| Editor snapshot | Grows with the project; media list and subtitle cues capped at 60 each | Attached to the newest user message as `<editor_state>`, rebuilt fresh every turn. |
| Attachments | Metadata JSON per asset | `<attached_assets>` on the message that carried them; on the Gemini path the newest message also carries the actual payloads (frames, images, text contents). |
| Full state | Uncapped | The get-state tool — the model calls it when the snapshot is stale or truncated. |
| The rendered frame | One 640px JPEG | The capture-frame tool, for visual judgment at the playhead. |
| The footage itself | Up to four 3×3 contact sheets per call | The watch-video tool: the engine samples a source at scene changes plus a steady floor (ffmpeg), the page stamps each cell with its source time, and the result carries the scene-change times. Detect-silence reports dead air the same way, numbers only. |

The system prompt is deliberately small: the voice, the deliverable rule (below), id discipline, the undo-versus-credits asymmetry, and pointers into the skills. The skills carry the deep per-area documentation — editor overview, timeline editing, watching and cutting by content, transitions, titles, audio and subtitles, stock and generation, publish and export — so the always-on cost stays near 12K tokens and detail is pulled only when the model works in that area.

The snapshot is a compact JSON picture of everything user-visible: project meta, playhead, selection, every media asset with its origin tag, the video track with gaps and transitions, overlay video, soundtrack, titles, subtitle tracks with the first 60 cues, publish metadata, and view state. Numbers are rounded to two decimals and empty fields are omitted. When a list is truncated the snapshot says so, which is the model's cue to call get-state.

## The decision layer

Deciding what the user wants is prompt text, executed by the model. The prompt orders the calls it must make each turn:

1. **Deliverable first.** "Write me a caption / a script / a prompt" asks for words — the answer goes in chat and the project stays untouched until the user says "do it". A request to change the project gets acted on directly with tools.
2. **Doing beats asking.** Edits are free to reverse (unlimited undo), so the model acts on reasonable interpretations. Generation is the exception: undo removes the clip but credits stay spent, so it generates only when the user asked for the media itself.
3. **Free before paid.** Bundled stock is checked before spending generation credits when existing media could serve.

"This" resolves to the current selection, ids come verbatim from the state, and unfamiliar areas trigger a skill read first.

## Doing the work

Tool calls execute in the open tab against the same store the user is editing — same state, same selection, same undo history.

- **Readable failure, then retry.** Tools validate and clamp their inputs and throw human-readable errors ("No clip with that id — call get_state for current ids"), which return to the model as tool errors it can recover from. A dropped bridge is separate from a bad request: the idempotent tool listing retries on a momentary engine hiccup so the model never lands with an empty tool set, and an "unreachable" call is one the model quietly re-issues rather than a dead end that tells the user to reconnect.
- **One undo step per turn.** History batches while the assistant is busy, so ⌘Z reverts the whole turn rather than one call at a time.
- **Small results.** Tools return ids and rounded numbers, plus a short note when behavior surprised ("that spot was taken — slid right").
- **Frames become images.** A tool result's `image`/`images` data URLs leave the JSON and reach the model as real images on every path — the engine bridge emits MCP image blocks after the data text, and the Gemini loop rides the first on the function response and the rest as image parts. Watching happens in whatever model the user is chatting with; there is no side model.
- **Async when rendering.** Video generation outruns the two-minute tool window, so those tools start the job and return immediately; the clip files under the chat that asked — the owning thread is captured at call time — and lands on the timeline only when the user asked for that. Each render's card state (running, landed, failed) mirrors into the project doc as it changes, so the chat shows the same outcome on machines that never ran the job.
- **Chat owns what it makes.** Media created by chat tools is tagged with its thread and previews on a card in the conversation. Placing it on the timeline or filing it into Media or the Library transfers ownership; deleting the thread deletes whatever it still owns.
- **Chat media is the account's storage.** It is real project media: it counts toward the cloud quota and the project's size like an import, and the thread is the only place it can be seen or deleted from. So conversations travel wherever their media travels — a project moved between the Mac and the cloud, an owner's duplicate, and a share copy with chat shared all carry the threads with the files. A copy that took the files alone would hold media nobody can find, delete, or explain, and the user would still be paying for it.
- **Two tools stay server-side.** The skill list and skill reads are answered by the engine directly — no browser hop.

## Generating a whole video

Most generation tools make one asset — an image, a video clip, a voiceover, or an instrumental music bed (`generate_music`, scene-aware enough to score a whole video, and able to match a track to a reference the user attaches — an audio clip to emulate or a video whose tone it should carry, since the music model reads only text a multimodal pass turns the reference into the sound description it renders from). `generate_scene` makes a whole cut: it writes a script, breaks it into shots, and — once the user approves — renders each shot and lays them on the timeline. The video model speaks each shot's line, so the clips carry their own narration; a music bed sits under them. It is genre-agnostic; the look comes from the brief and any references. It can also animate audio the project already has (`from_audio_asset_id`), tiling shots over that spine instead of writing a script.

Because a scene renders many paid shots, the tool plans and then stops. `generate_scene` returns a shot list and waits; `approve_scene` starts the renders; `regenerate_shot` and `restyle_scene` revise afterward; `cancel_scene` kills the active run. The plan the user approves is the plan that renders: voicing runs after the gate and only rescales the approved shots to the real voice lengths (a line longer than one clip splits its shot). The run is browser-side like every generation here, held in a small store beside the panels (`lib/genScene.ts`) so switching tabs never orphans it; leaving the project pauses it, its persisted plan (`ProjectDoc.genvideo`) resumes on the next open, and a run that dies persists as failed so a reload never resumes it. Nothing runs behind the user's back: cancelling, dismissing an unrendered plan, or deleting the chat thread that asked all stop the run and clear its plan — clips already placed stay on the timeline. Progress shows on a card in the chat while the timeline fills on its own. The shots ride under one consistent AI voice with the video model's own audio off; this version has no talking-head lip-sync.

## Context across turns

Threads persist per project in the browser's local storage — the newest 30, titled by their first message. A cloud project also mirrors each thread to the hosted chat routes (Postgres, keyed to the account), merging the server copy back into local storage on open, so its history follows the account across devices. What a returning thread remembers depends on the provider:

- **Claude and Codex hold their own history.** Each turn sends only the newest message plus the fresh snapshot; prior turns live in the provider's native session, whose id is saved on the thread and resumed. The engine never replays conversation history itself.
- **Gemini is stateless.** The page replays the whole thread every turn — text only. Old turns are stripped to their words; tool traffic, old snapshots, and old attachment payloads stay out, and the fresh snapshot rides only the newest message.

A thread saves one session slot per provider, so switching models mid-thread keeps each provider's own context. The asymmetry to know: Gemini can pick up any thread because it replays the transcript, while a CLI provider joining a thread it hasn't chatted in starts from only the newest message.

## Limits

| Limit | Value |
| --- | --- |
| Provider turns per request (Claude) | 30 |
| Tool rounds per turn (Gemini) | 24 |
| Browser tool execution | 120s |
| One watch-video call | 600s of source, 4 sheets (36 frames); the result says where coverage stopped |
| Snapshot caps | 60 media items, 60 cues |
| Saved threads per project | 30 |
| CLI availability probe cache | 60s |

## One-shot helpers

Three narrow AI calls run beside the chat, each a single engine round-trip through the user's Claude login on a small model: the caption style rewrite, caption translation, and visual subtitles (sampled frames in, timed narration cues out). The panel buttons and the chat's subtitle tools reach them through the same store actions. The style rewrite falls back to the original lines on failure; translation fails loudly instead, because filling a track with the wrong language would be silent corruption.

A hidden hermetic test provider exercises the full engine bridge — context, tool round-trips, streaming — without spending tokens; end-to-end tests select it as their model.

## Where it lives

The shared catalog (system prompt, tools, skills), the chat route with its provider runners, the browser-tool bridge, and the stdio MCP proxy live with the engine's AI code under the site's Cut folder (`server/ai/`, `server/http/ai.ts`). The page side holds the snapshot builder (`lib/aiContext.ts`), the tool implementations (`lib/aiTools.ts`), the Gemini loop (`lib/geminiChat.ts`), the model catalog (`lib/aiModels.ts`), and the chat panel with threads and transport (`components/AiPanel.tsx`).

The brief-to-video pipeline is its own subsystem: the orchestrator, coverage invariant, and role interfaces in `lib/genvideo/`, its hosted-model adapters in `lib/genvideo/adapters/`, the browser controller in `lib/genScene.ts`, and the progress card in `components/SceneCard.tsx`. Its strategy — story planning, the identity ladder, where audio goes next — is the [Brief to Video](brief-to-video.md) guide.
