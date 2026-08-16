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
  └─ no app ────────────▶ hosted speech — credits, timings interpolated per cue
                             │
                             ▼
                       cues into the project's own document
```

The project's backend decides *where the result lives*; the app's presence decides *who does the work*.

## Availability

Availability is the probe the client already runs — the app's engine answered on this machine, or the page is served by it. Nothing new is asked of the browser, which matters: a hosted page's calls to the local machine are permission-gated, so the client probes only where that raises no prompt. No app, no probe, or a browser blocking the connection all read the same way, and the work goes hosted.

## Speech

The engine transcribes a rendered mix, and that is what makes this work for a project it doesn't store. The browser renders the mix itself — the same trims, speeds, volumes, and crossfades the engine's ffmpeg graph applies — and posts the audio to the Mac, which runs on-device speech over it and answers with cues. The engine reads nothing from the project's storage and learns nothing about the project.

Whoever transcribes, the cue times are checked against that same mix before they become captions. Every transcriber mistimes a caption in its own way — the on-device model hands the silence in front of a sentence to that sentence's first word, so a caption can appear a second before anyone speaks — and the audio settles it: a speech envelope says where each stretch of talking starts and stops, and a cue edge moves onto the edge it belongs to. Only edges the audio can testify to move. A caption boundary in the middle of a sentence, or a mix playing music under the whole cut, keeps the time the transcriber gave it, so the pass is an improvement or nothing.

Dictation is the same trade in the other direction: with the app running, mic audio streams to the engine live and the transcript evolves as the user speaks; without it, the take is recorded, sent up in one piece, and arrives when it arrives.

The assistant's background sweep over a source takes the same fork under one extra constraint: it uses only a transcriber that costs the user nothing — this Mac's engine, or the hosted route held to the account's included allowance — and stops asking once that allowance is spent. Background work is unable to reach a metered path by construction.

## Export

A cloud project exports in the browser, and so does a browser project — the tab is that project's whole machine. The rule above still holds: the finished file lands in the project's own storage and is registered there, R2 for a cloud project and the origin-private `exports/` folder for a browser one. What moved is who does the work, and the answer turned out to be the machine already in front of the user.

That works because the editor composites the cut live to draw the preview. Rendering is the same drawing done on a clock the tab steps, so a browser and a container produce the same picture from the same document, and the browser needs nothing pulled out of storage that it is not already playing.

Two facts decide whether a tab can carry a render, both probed per export: origin-private scratch storage to stream the file to, and a WebCodecs video encoder at the requested dimensions. A cut of any length renders in the tab, since the pipeline streams to disk and duration costs only time. A cloud project that fails either probe, or fails mid-render, goes to the worker silently. A browser project has no second machine, so the failure is the user's to resolve: the export says what went wrong and points at Move to Cloud.

The worker also takes the renders the editor fires on its own — hover proxies, share cards, streaming ladders. Moving export to the Mac would be a third path and there is no longer much to win from it.

## Rules

1. **Local is an optimization, never a requirement.** Every job routed to the Mac has a hosted path behind it. An engine that never answered, or one that fails the job, means the work goes hosted — the user hears about a failure only when both paths fail.
2. **The result lands where the project lives.** A job's output is addressed to the project's own backend, chosen from the project id, never from whatever the app happens to be bound to when the job finishes.
3. **Credits follow the work.** Metering belongs to the hosted route; the feature never decides it. Work done on the Mac spends nothing, and the user is never asked to choose.
4. **Silence about the machine.** The editor says what it is doing, not which computer is doing it. Closing the app mid-session makes the next job slower, not different.

## What runs where

| Work | Runs | Why |
| --- | --- | --- |
| Transcription, dictation | the Mac when it is there, hosted otherwise | the app ships the speech tool |
| Export | the Mac for its own projects, the browser for cloud and browser ones, the worker when a cloud project's tab can't encode | see Export above |
| Thumbnails, waveforms, media probing | the browser, always | it decodes the media itself |
| Image, video, and voice generation | hosted, always | no local counterpart |
| The assistant's Gemini models | hosted, always | credits and the user's session |
| The assistant's Claude and Codex providers | the Mac, always | the user's own CLI logins |

## Where it lives

The client's backend seam picks the compute target beside the per-project driver, the browser-side mix render sits with the transcription client code, the engine's speech handlers take work for a project they do not store, and the client's export store routes a render between the tab and the worker on a renderability probe the browser render pipeline owns.
