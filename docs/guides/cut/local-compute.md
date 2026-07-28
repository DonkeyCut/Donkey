# Local Compute for Cloud Projects

A cloud project stores its document in Postgres and its media in R2, and it still uses the Mac when there is one. Speech is the case that matters today: transcription and dictation run on device whenever the Donkey app is running, even for a project whose media the engine has never seen. The user pays nothing for that work, gets it faster, and gets better timings out of it.

**The one rule:** compute never decides where data lands. Whoever does the work, the result goes back to the project's own backend — cues into the cloud document, a render into R2. A locally run job that finishes in a folder on the Mac and leaves the cloud project none the wiser breaks the rule.

## How it works

Where a project's data lives and who does its work are two separate decisions. Residency is a fact about the project, fixed when it is created. Compute is decided per job, at the moment the user asks for it, and the Mac wins whenever it is there.

```
cloud project, user asks for subtitles
  │
  browser renders the audible mix
  │
  ├─ the app answered ──▶ on-device speech on the Mac — free, real word timings
  │                          │
  └─ no app ────────────▶ hosted speech — credits, timings interpolated per cue
                             │
                             ▼
                       cues into the cloud document
```

The project's backend decides *where the result lives*; the app's presence decides *who does the work*.

## Availability

Availability is the probe the client already runs — the app's engine answered on this machine, or the page is served by it. Nothing new is asked of the browser, which matters: a hosted page's calls to the local machine are permission-gated, so the client probes only where that raises no prompt. No app, no probe, or a browser blocking the connection all read the same way, and the work goes hosted.

## Speech

The engine transcribes a rendered mix, not a timeline, and that is what makes this work for a project it doesn't store. For a cloud project the browser renders the mix itself — the same trims, speeds, volumes, and crossfades the engine's ffmpeg graph applies — and posts the audio to the Mac, which runs on-device speech over it and answers with cues. The engine reads nothing from R2 and learns nothing about the project.

Dictation is the same trade in the other direction: with the app running, mic audio streams to the engine live and the transcript evolves as the user speaks; without it, the take is recorded, sent up in one piece, and arrives when it arrives.

## Export

Export still runs hosted for cloud projects, on the render worker. Moving it to the Mac is the same shape as speech with two extra pieces: the engine has to pull each clip from a signed URL before it can render, and push the finished file back up to storage after.

## Rules

1. **Local is an optimization, never a requirement.** Every job routed to the Mac has a hosted path behind it. An engine that never answered, or one that fails the job, means the work goes hosted — the user hears about a failure only when both paths fail.
2. **The result lands where the project lives.** A job's output is addressed to the project's own backend, chosen from the project id, never from whatever the app happens to be bound to when the job finishes.
3. **Credits follow the work.** Metering belongs to the hosted route, not to the feature. Work done on the Mac spends nothing, and the user is never asked to choose.
4. **Silence about the machine.** The editor says what it is doing, not which computer is doing it. Closing the app mid-session makes the next job slower, not different.

## What runs where

| Work | Runs | Why |
| --- | --- | --- |
| Transcription, dictation | the Mac when it is there, hosted otherwise | the app ships the speech tool |
| Export, encoding, thumbnails | the Mac for its own projects, hosted for cloud ones | see Export above |
| Image, video, and voice generation | hosted, always | no local counterpart |
| The assistant's Gemini models | hosted, always | credits and the user's session |
| The assistant's Claude and Codex providers | the Mac, always | the user's own CLI logins |

## Where it lives

The client's backend seam picks the compute target beside the per-project driver, the browser-side mix render sits with the transcription client code, and the engine's speech handlers take work for a project they do not store.
