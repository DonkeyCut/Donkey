"use client";

import { getBackend, hasLocalCompute } from "../backend";
import {
  isFreeTranscriptionExhausted,
  renderMix,
  transcribeSamples,
  type CloudTranscribeSpec,
} from "../cloudTranscribe";
import { alignCues } from "../cueAlign";
import { engineTranscribeSamples } from "../localStt";
import { sampleWatchFrames } from "../media";
import { runTranscription, useEditor } from "../store";
import { trackLocale } from "../subtitles";
import { mergeSpeech, mergeWatch, nextUncoveredSpan } from "./merge";

/** Background watch sweep: after the assistant's first look at (or listen to)
 * a source, quietly build the rest of its working metadata — the transcript
 * first, then the visual map, segment by segment, merged into the asset's
 * stored records as each piece lands. No images are made, no subtitle track
 * is written, and the user is never charged: transcription runs on the free
 * paths (the local engine, a Mac's engine behind a cloud project, or the
 * hosted route's included allowance) and stops when none remains. The
 * sweep yields the decoders to playback and to foreground watch calls,
 * yields the engine's transcriber to user caption generation, survives its
 * own interruption because coverage persists per segment, and ends when
 * nothing is left uncovered. */

const SEGMENT_S = 600; // visual sweep segment
const SPEECH_CHUNK_S = 120; // transcription chunk — short, so a user's own
// caption generation never waits long behind the engine's one-at-a-time STT
const SPEECH_PAD_S = 2; // re-listen into the previous chunk so no word is cut
const STT_MAX_FAILS = 4;
const WATCH_MAX_FAILS = 4; // media reads ride the network — retry transient failures
const RETRY_MS = 5_000; // wait while playback or a foreground watch holds the decoders
const BREATHER_MS = 1_000; // idle gap between segments

const queued = new Set<string>();
const sttFails = new Map<string, number>();
const watchFails = new Map<string, number>();
let running = false;
let syncWatches = 0;
// The UTC month in which the hosted route said this account's included chunks
// were used up. The sweep stops asking until the month changes (or a reload);
// the route re-decides from the account's actual allowance window — a Pro
// billing period, or the calendar month — on the next ask.
let hostedFreeExhaustedMonth: string | null = null;
const utcMonth = () => new Date().toISOString().slice(0, 7);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The sweep steps aside whenever someone is actively using the decoders:
 * the preview playing, or the assistant inside a foreground watch call. */
const decodersBusy = () => syncWatches > 0 || useEditor.getState().playing;

/** A free transcriber exists: the local engine, a Mac's engine behind a cloud
 * project, or the hosted route's monthly included allowance while it lasts. */
const sttFree = () =>
  getBackend().kind === "local" || hasLocalCompute() || hostedFreeExhaustedMonth !== utcMonth();

/** Run a foreground watch with the sweep paused for its duration, so the
 * call the assistant is waiting on gets the decoders to itself. */
export async function withSweepPaused<T>(work: () => Promise<T>): Promise<T> {
  syncWatches++;
  try {
    return await work();
  } finally {
    syncWatches--;
  }
}

/** True while a background sweep is still filling this asset's metadata. */
export function watchSweepActive(assetId: string): boolean {
  return queued.has(assetId);
}

/** Queue an asset for background sweeping. Safe to call repeatedly; a fully
 * covered asset dequeues on its first turn. */
export function queueWatchSweep(assetId: string): void {
  if (queued.has(assetId)) return;
  queued.add(assetId);
  if (!running) void run();
}

/** The free transcribers only. A background job must be unable to spend the
 * user's credits by construction, so the cloud case here talks to its
 * transcriber directly: the Mac's engine when one is reachable, else the
 * hosted route pinned to `freeOnly` — the route refuses past the account's
 * included allowance, and that refusal ends hosted sweeping for the session. */
async function transcribeFree(
  projectId: string,
  spec: CloudTranscribeSpec
): Promise<{ start: number; end: number; text: string }[] | null> {
  if (getBackend().kind === "local") return runTranscription(projectId, spec);
  const stale = () => useEditor.getState().projectId !== projectId;
  const mix = await renderMix(projectId, spec);
  if (stale()) return null;
  if (!mix) return []; // nothing audible — no speech, like the engine's short-circuit
  const samples = mix.getChannelData(0);
  if (hasLocalCompute()) {
    try {
      return await engineTranscribeSamples(samples, spec.duration, spec.locale, stale);
    } catch {
      // The app went away mid-call, or on-device speech is unavailable on
      // this Mac — the hosted included path below still serves this chunk.
    }
  }
  try {
    // The hosted model reads cue times off the audio by ear; snap them to the
    // mix the same way the user's caption path does.
    const cues = await transcribeSamples(samples, spec.locale, stale, { freeOnly: true });
    return cues && alignCues(cues, samples, mix.sampleRate, { snap: 0.6 });
  } catch (error) {
    if (isFreeTranscriptionExhausted(error)) hostedFreeExhaustedMonth = utcMonth();
    throw error;
  }
}

/** Transcribe one chunk of the source into its asset-level transcript. The
 * chunk re-listens SPEECH_PAD_S into covered ground so a word straddling the
 * boundary is heard whole; segments the previous chunk already owns drop. */
async function transcribeChunk(
  assetId: string,
  span: { from: number; to: number }
): Promise<void> {
  const s = useEditor.getState();
  const asset = s.assets.find((a) => a.id === assetId);
  if (!s.projectId || !asset) return;
  const locale = asset.language ?? trackLocale(s.subtitles, 0);
  const specFrom = Math.max(0, span.from - (span.from > 0 ? SPEECH_PAD_S : 0));
  const cues = await transcribeFree(s.projectId, {
    duration: span.to - specFrom,
    locale,
    clips: [],
    audio: [{ file: asset.fileName, in: specFrom, out: span.to, start: 0, volume: 1 }],
  });
  if (cues === null) return; // another project took over mid-run
  const segments = cues
    .map((c) => ({ start: c.start + specFrom, end: c.end + specFrom, text: c.text }))
    .filter((sg) => sg.start >= span.from - 0.05);
  const cur = useEditor.getState().assets.find((a) => a.id === assetId);
  if (!cur) return;
  useEditor.getState().updateAsset(assetId, {
    speech: mergeSpeech(cur.speech, { from: span.from, to: span.to, segments, locale }, cur.duration),
  });
}

async function run(): Promise<void> {
  running = true;
  try {
    while (queued.size > 0) {
      const id: string = queued.values().next().value!;
      const s = useEditor.getState();
      const asset = s.assets.find((a) => a.id === id);
      // The asset may be gone (deleted, or another project opened) — the
      // sweep dies with it, like its metadata does.
      if (
        !asset ||
        asset.upload ||
        !(asset.duration > 0) ||
        (asset.type !== "video" && asset.type !== "audio")
      ) {
        queued.delete(id);
        sttFails.delete(id);
        watchFails.delete(id);
        continue;
      }

      // Transcript first: it is small, unlocks the fused timeline for every
      // later watch, and answers "what is said" without inlining audio.
      // It waits out the user's own caption generation — the engine
      // transcribes one job at a time and the user goes first.
      const speechSpan =
        sttFree() && (sttFails.get(id) ?? 0) < STT_MAX_FAILS && s.subtitleStatus !== "running"
          ? nextUncoveredSpan(asset.speech, asset.duration, SPEECH_CHUNK_S)
          : null;
      if (speechSpan) {
        try {
          await transcribeChunk(id, speechSpan);
          sttFails.delete(id);
        } catch {
          // Likely the engine's single transcription slot — back off; the
          // fail cap keeps an unreadable source from looping forever.
          sttFails.set(id, (sttFails.get(id) ?? 0) + 1);
          await sleep(RETRY_MS);
        }
        await sleep(BREATHER_MS);
        continue;
      }

      // Visual map second; audio-only sources are done once heard.
      const span =
        asset.type === "video" ? nextUncoveredSpan(asset.watch, asset.duration, SEGMENT_S) : null;
      if (!span) {
        queued.delete(id);
        sttFails.delete(id);
        watchFails.delete(id);
        continue;
      }
      if (decodersBusy()) {
        await sleep(RETRY_MS);
        continue;
      }
      try {
        const r = await sampleWatchFrames(asset.url, {
          from: span.from,
          to: span.to,
          metadataOnly: true,
          shouldPause: decodersBusy,
        });
        if (r.coveredTo > span.from) {
          const cur = useEditor.getState().assets.find((a) => a.id === id);
          if (!cur) {
            queued.delete(id);
            continue;
          }
          watchFails.delete(id);
          useEditor.getState().updateAsset(id, {
            watch: mergeWatch(cur.watch, {
              from: span.from,
              to: r.coveredTo,
              frames: r.frames.map((f) => ({ t: f.t, via: f.via })),
              sceneChanges: r.sceneChanges,
            }),
          });
        } else {
          await sleep(RETRY_MS); // paused before any progress
        }
      } catch {
        // Media reads ride the network, so a failure is retried like the
        // speech pass's; the cap keeps a truly unreadable source from
        // looping forever.
        const fails = (watchFails.get(id) ?? 0) + 1;
        watchFails.set(id, fails);
        if (fails >= WATCH_MAX_FAILS) {
          queued.delete(id);
          watchFails.delete(id);
        } else {
          await sleep(RETRY_MS);
        }
      }
      await sleep(BREATHER_MS);
    }
  } finally {
    running = false;
  }
}
