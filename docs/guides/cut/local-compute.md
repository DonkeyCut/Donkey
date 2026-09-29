# Local Compute

A project the engine does not store — one in the cloud, or one in the browser's own origin-private storage — still uses the Mac when there is one. Speech is the case that matters today: transcription and dictation run on device whenever the Donkey app is running, even for media the engine has never seen. The user pays nothing for that work, gets it faster, and gets better timings out of it.

**The one rule:** compute never decides where data lands. Whoever does the work, the result goes back to the project's own backend — cues into the project's document, a render into the storage that project uses. A locally run job that finishes in a folder on the Mac and leaves the project none the wiser breaks the rule.

## How it works

Where a project's data lives and who does its work are two separate decisions. Residency is a fact about the project, fixed when it is created. Compute is decided per job, at the moment the user asks for it, and the Mac wins whenever it is there.

```
project the engine doesn't store, user asks for subtitles
  │
  browser renders the audible mix
  │
  ├─ the app answered ──▶ on-device speech on the Mac — free, real word timings
  │                          │
  └─ no app ────────────▶ hosted speech — credits, real word timings
                             │
                             ▼
                       cues into the project's own document
```

The project's backend decides *where the result lives*; the app's presence decides *who does the work*.

## Availability

Availability is the probe the client already runs — the app's engine answered on this machine, or the page is served by it. Nothing new is asked of the browser, which matters: a hosted page's calls to the local machine are permission-gated, so the client probes only where that raises no prompt. No app, no probe, or a browser blocking the connection all read the same way, and the work goes hosted.

## Speech

The engine transcribes a rendered mix, and that is what makes this work for a project it doesn't store. The browser renders the mix itself — the same trims, speeds, volumes, and crossfades the engine's ffmpeg graph applies — and posts the audio to the Mac, which runs on-device speech over it and answers with cues. The engine reads nothing from the project's storage and learns nothing about the project. Without the app, the same mix goes in short chunks to the hosted speech model, which answers with the words and their timings; the page stitches the chunks back into timeline time.

Whoever transcribes, the cue times are checked against that same mix before they become captions. Every transcriber mistimes a caption in its own way — the on-device model hands the silence in front of a sentence to that sentence's first word, so a caption can appear a second before anyone speaks — and the audio settles it: a speech envelope says where each stretch of talking starts and stops, and a cue edge moves onto the edge it belongs to. Only edges the audio can testify to move. A caption boundary in the middle of a sentence, or a mix playing music under the whole cut, keeps the time the transcriber gave it, so the pass is an improvement or nothing.

Dictation is the same trade in the other direction: with the app running, mic audio streams to the engine live and the transcript evolves as the user speaks; without it, the take is recorded, sent up in one piece, and arrives when it arrives.

The assistant's background sweep over a source takes the same fork under one extra constraint: it uses only a transcriber that costs the user nothing — this Mac's engine, or the hosted route held to the account's included allowance — and stops asking once that allowance is spent. Background work is unable to reach a metered path by construction.

## Export

Every project exports in the browser: a cloud project, a browser project, and a project resident on this Mac. The rule above still holds: the finished file lands in the project's own storage and is registered there, R2 for a cloud project, the origin-private `exports/` folder for a browser one, and the project folder's `exports/` on the Mac, where the engine holds the job row while the tab draws and takes the file in when it is done. What moved is who does the work, and the answer turned out to be the machine already in front of the user: the export is the preview, drawn by the compositor and mixed by the graph the user was watching and listening to.

That works because the editor composites the cut live to draw the preview. Rendering is the same drawing done on a clock the tab steps, so a browser and a container produce the same picture from the same document, and the browser needs nothing pulled out of storage that it is not already playing.

Two facts decide whether a tab can carry a render, both probed per export: origin-private scratch storage to stream the file to, and WebCodecs encoders for the codecs the user chose at the requested dimensions — the video one, and AAC when the cut has sound. The probe asks for exactly those codecs; nothing stands in for a missing one, because a file with a substitute codec inside is a file the user's player refuses. ProRes has no browser encoder, so a master always renders on the worker. A cut of any length renders in the tab, since the pipeline streams to disk and duration costs only time. A project that fails either probe, or fails mid-render, goes silently to the machine behind it: the engine on this Mac renders a Mac project with its own ffmpeg, and the worker renders the rest. For a cloud project the worker already holds the media. A browser project's media lives only in that tab, so it goes up with the job beside the overlay stills, the worker renders from those uploads, and the finished file comes back down into the project's own exports folder; the cloud keeps nothing afterwards. Whatever the user picked, something renders it — the only thing that stops a browser project's export is an account that cannot use the cloud, and the export says so.

The worker and the engine also take the renders the editor fires on its own — hover proxies, share cards, streaming ladders — and the ProRes masters no browser can encode. Those are the renders nobody watched first, and ffmpeg's picture and sound are held to the browser's by measurement: the same numbers for framing, grades and fades, the browser's own makeup gain on a compressed clip, a mono source at full level.

A client with no compositor at all asks by project id instead. The phone sends the project and a size; the worker opens the stored document into the editor store, runs the same payload builder the export dialog runs, paints the overlay stills straight into the render's own scratch dir, and encodes. This is the headless runtime doing what it was built for — canvas, decoders, fonts standing in for the page — so the phone's export is the editor's export, not an approximation of it.

## Converting footage

Imports and the assistant's conversion tool prepare playable H.264/AAC media through the backend that holds the file. Compatible streams copy into the new container. Unsupported streams are encoded, and a playable audio rendition takes precedence over optional spatial audio.

The Library uploads originals even when browser probing fails; the worker prepares playback and retains the source for download. A browser-local project or shelf without the required codec borrows preparation, saves the result into its own storage, and removes the temporary cloud copy. The engine shelf uses the same worker when its tools fail. Hosted preparation requires a signed-in account with available storage and worker capacity.

Library drops share local previews and background storage across folders and panels; cards show “Importing”, and retries reuse uploaded bytes and jobs.

Project conversion keeps the asset id, so existing clips continue to reference it. The same tools run in the editor and headless clients.

## Rules

1. **Local is an optimization, never a requirement.** Every job routed to the Mac has a hosted path behind it. An engine that never answered, or one that fails the job, means the work goes hosted — the user hears about a failure only when both paths fail.
2. **The result lands where the project lives.** A job's output is addressed to the project's own backend, chosen from the project id, never from whatever the app happens to be bound to when the job finishes.
3. **Credits follow the work.** Metering belongs to the hosted route; the feature never decides it. Work done on the Mac spends nothing, and the user is never asked to choose.
4. **Silence about the machine.** The editor says what it is doing, not which computer is doing it. Closing the app mid-session makes the next job slower, not different.

## What runs where

| Work | Runs | Why |
| --- | --- | --- |
| Transcription, dictation | the Mac when it is there, hosted otherwise | the app ships the speech tool |
| Export | the Mac for its own projects, the browser for cloud and browser ones, the worker when the tab can't encode the choice | see Export above |
| Thumbnails, waveforms, media probing | the browser, always | it decodes the media itself |
| Converting media to MP4 | the backend holding the bytes, with hosted preparation when the browser lacks a codec | see Converting footage above |
| Image, video, and voice generation | hosted, always | no local counterpart |
| Cutout mattes | the quick person matte in the tab, on-device and free; the quality and tracked bakes hosted (credits), driven by the tab | the tab decodes the clip and owns the session; the engine and the worker only consume the stored matte asset |
| The assistant's Gemini models | hosted, always | credits and the user's session |
| The assistant's Claude and Codex providers | the Mac, always | the user's own CLI logins |

## Where it lives

The client's backend seam picks the compute target beside the per-project driver, the browser-side mix render sits with the transcription client code, the engine's speech handlers take work for a project they do not store, and the client's export store routes a render between the tab and the worker on a renderability probe the browser render pipeline owns.
