/**
 * Shared fixtures for the Cut chat evals: editor snapshots, composer-turn
 * builders, tool simulators, and the safe-tool server. Everything here is
 * deterministic so the correctness and latency entrypoints measure the model,
 * not the harness.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_SKILL_INDEX } from "../../../src/cut/server/ai/catalog";

export type Item = Record<string, unknown>;

// Tools that read or steer the view without changing the cut or spending
// credits. Anything outside this set counts as a mutation for the evals.
export const SAFE_TOOLS = new Set([
  "get_state",
  "list_skills",
  "read_skill",
  "capture_frame",
  "watch_video",
  "detect_silence",
  "detect_beats",
  "listen_audio",
  // The model's own memory of a source and the user's synced notes: reading
  // notes and writing down a look are bookkeeping, never a project edit.
  "note_source",
  "notes_list",
  "read_color_stats",
  "library_list",
  "stock_search",
  "list_voices",
  "seek",
  "select",
  "set_playing",
  "set_view",
]);

// ---------------------------------------------------------------------------
// Fixtures

export const SPOKEN_LINE = "Hi, this is Mason.";

/** Synthesize the fixture line locally (macOS say + afconvert), base64 wav. */
export function makeFixtureAudio(): { dataBase64: string; mimeType: string } {
  const dir = mkdtempSync(join(tmpdir(), "cut-eval-"));
  const aiff = join(dir, "line.aiff");
  const wav = join(dir, "line.wav");
  const say = spawnSync("say", ["-o", aiff, SPOKEN_LINE]);
  if (say.status !== 0) throw new Error(`say failed: ${say.stderr}`);
  const conv = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", "-c", "1", aiff, wav]);
  if (conv.status !== 0) throw new Error(`afconvert failed: ${conv.stderr}`);
  return { dataBase64: readFileSync(wav).toString("base64"), mimeType: "audio/wav" };
}

export const VOICE_ASSET = {
  id: "a-vo1",
  name: "AI voice — Hi, this is",
  type: "audio",
  duration: 1.6,
  origin: "voiceover",
};

/** Photos dropped on the chat composer: imported as plain user media (no
 * origin), referenced by the message's attachment metadata. */
export const PHOTO_ASSETS = [
  { id: "a-i1", name: "dog-park.jpg", type: "image" },
  { id: "a-i2", name: "dog-beach.jpg", type: "image" },
];

export const PHOTO_REFS = PHOTO_ASSETS.map((a, i) => ({
  scope: "project",
  id: a.id,
  name: a.name,
  kind: "image",
  url: `http://127.0.0.1:41417/media/${a.id}.jpg`,
  handle: `i${i + 1}`,
}));

/** Hand-built snapshot mirroring buildAiContext's shape (aiContext.ts): one
 * 12.5s video clip on track 0, the voiceover on the soundtrack, no captions.
 * Keep the keys in sync with buildAiContext when its shape changes. */
export const EDITOR_STATE = {
  project: {
    id: "p-eval",
    name: "Eval project",
    duration: 12.5,
    aspect: "9:16",
    frame: "1080x1920",
  },
  playhead: 0,
  skimmer: null,
  playing: false,
  selection: null,
  media: [
    { id: "a-v1", name: "beach.mp4", type: "video", duration: 20 },
    VOICE_ASSET,
    ...PHOTO_ASSETS,
  ],
  mediaTruncated: false,
  videoTrack: [
    {
      index: 0,
      id: "c1",
      asset: "beach.mp4",
      start: 0,
      len: 12.5,
      in: 0,
      out: 12.5,
      sourceDuration: 20,
      muted: false,
      framing: "fit",
      speed: 1,
    },
  ],
  overlayVideo: [],
  soundtrack: [
    {
      id: "au1",
      asset: VOICE_ASSET.name,
      start: 0,
      len: 1.6,
      in: 0,
      out: 1.6,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      duck: 0.4,
    },
  ],
  titles: [],
  subtitles: {
    count: 0,
    showOnVideo: true,
    showOnTimeline: true,
    activeTrack: 0,
    tracks: [{ track: 0, locale: "en-US", cues: 0 }],
    status: "idle",
    cues: [],
    cuesTruncated: false,
  },
  publish: { caption: "", tags: "", soundTitle: "", handle: "" },
  view: { pxPerSec: 60, timelineH: 260, exportDialogOpen: false },
};

/** Two abutting track-0 clips for the effects cases (transition, animation,
 * and look control). Keys mirror buildAiContext, like EDITOR_STATE. */
export const TWO_CLIP_STATE = {
  ...EDITOR_STATE,
  videoTrack: [
    {
      index: 0,
      id: "c1",
      asset: "beach.mp4",
      start: 0,
      len: 6,
      in: 0,
      out: 6,
      sourceDuration: 20,
      muted: false,
      framing: "fit",
      speed: 1,
    },
    {
      index: 1,
      id: "c2",
      asset: "beach.mp4",
      start: 6,
      len: 6.5,
      in: 6,
      out: 12.5,
      sourceDuration: 20,
      muted: false,
      framing: "fit",
      speed: 1,
    },
  ],
};

/** The same pair already joined by a crossfade, for the edge-override case. */
export const CROSSFADED_STATE = {
  ...TWO_CLIP_STATE,
  videoTrack: [
    { ...TWO_CLIP_STATE.videoTrack[0], transitionToNext: { style: "crossfade", seconds: 0.5 } },
    { ...TWO_CLIP_STATE.videoTrack[1], start: 5.5 },
  ],
};

/** A user-imported narration file for the scene-production cases. */
export const NARRATION_ASSET = { id: "a-au1", name: "narration.mp3", type: "audio", duration: 24 };

export const VOICE_REF = {
  scope: "project",
  id: VOICE_ASSET.id,
  name: VOICE_ASSET.name,
  kind: "audio",
  url: `http://127.0.0.1:41417/media/${VOICE_ASSET.id}.wav`,
  duration: VOICE_ASSET.duration,
  handle: "a1",
};

/** The base snapshot with a spoken transcript on track 0 — filler words at
 * known cue timings, so "cut the filler" has real ranges to act on. */
export const FILLER_CUES = [
  { id: "cue1", start: 0, end: 1.8, text: "Um, so today we're" },
  { id: "cue2", start: 1.8, end: 4.2, text: "at the beach with the dogs" },
  { id: "cue3", start: 4.2, end: 5.6, text: "and, uh, you know," },
  { id: "cue4", start: 5.6, end: 9, text: "they absolutely love the water" },
  { id: "cue5", start: 9, end: 12.5, text: "so let's watch them play" },
];

export const FILLER_STATE = {
  ...EDITOR_STATE,
  subtitles: {
    ...EDITOR_STATE.subtitles,
    count: FILLER_CUES.length,
    tracks: [{ track: 0, locale: "en-US", cues: FILLER_CUES.length }],
    cues: FILLER_CUES,
  },
};

/** The base snapshot plus the narration import — the scene cases' spine. */
export const AUDIO_STATE = {
  ...EDITOR_STATE,
  media: [...EDITOR_STATE.media, NARRATION_ASSET],
};

/** A tweet photo import_url landed in an earlier turn: chat-owned (aiTools
 * tags chat imports origin "chat"), named by the post's text, not yet placed.
 * A past turn replays as its text plus a ledger of the tool names it ran, so
 * the model must find this asset through `media` in the snapshot. */
export const TWEET_ASSET = {
  id: "a-tw1",
  name: "first snow of the year ❄️",
  type: "image",
  origin: "chat",
};

export const TWEET_STATE = {
  ...EDITOR_STATE,
  media: [...EDITOR_STATE.media, TWEET_ASSET],
};

/** The project after a styling turn finished: the reference import landed in
 * media, the three city clips are already joined by the crosszooms that turn
 * set, and every clip is still unmuted. Everything the previous turn did is
 * visible here, so redoing any of it is plainly redundant. */
const cityClip = (n: number, name: string, start: number, styled: boolean) => ({
  index: n - 1,
  id: `c${n}`,
  asset: name,
  start,
  len: 4.7,
  in: 0,
  out: 4.7,
  sourceDuration: 4.7,
  muted: false,
  framing: "fit",
  speed: 1,
  ...(styled ? { transitionToNext: { style: "crosszoom", seconds: 1 } } : {}),
});
export const STYLED_STATE = {
  ...EDITOR_STATE,
  media: [
    ...EDITOR_STATE.media,
    TWEET_ASSET,
    { id: "a-c1", name: "seoul.mp4", type: "video", duration: 4.7, origin: "generated" },
    { id: "a-c2", name: "san-francisco.mp4", type: "video", duration: 4.7, origin: "generated" },
    { id: "a-c3", name: "toronto.mp4", type: "video", duration: 4.7, origin: "generated" },
  ],
  videoTrack: [
    cityClip(1, "seoul.mp4", 0, true),
    cityClip(2, "san-francisco.mp4", 3.7, true),
    cityClip(3, "toronto.mp4", 7.4, false),
  ],
  soundtrack: [],
};

/** STYLED_STATE's timeline with its transition bars listed the way
 * buildAiContext reports them: two playing their cuts, two parked — the
 * debris-scope cases. */
export const PARKED_STATE = {
  ...STYLED_STATE,
  transitions: [
    { id: "tr-1", start: 2.7, seconds: 1, style: "crosszoom", plays: [{ at: 3.7, clipId: "c1" }] },
    { id: "tr-2", start: 6.4, seconds: 1, style: "crosszoom", plays: [{ at: 7.4, clipId: "c2" }] },
    { id: "tr-8", start: 0.9, seconds: 0.5, style: "blur", parked: true },
    { id: "tr-9", start: 10.6, seconds: 0.5, style: "crossfade", parked: true },
  ],
};

/** EDITOR_STATE with a title stranded past the video's end — the ledger's
 * non-transition debris class. */
export const STRANDED_TITLE_STATE = {
  ...EDITOR_STATE,
  titles: [
    { id: "ov-7", kind: "title", text: "THE END", start: 14.0, end: 17.0, x: 0.5, y: 0.5 },
  ],
};

/** A finished scene run's timeline: three generated takes, each clip carrying
 * its plan shot number (sceneShot), the narration as the spine. */
const sceneClip = (n: number, start: number, len: number) => ({
  index: n - 1,
  id: `sc-${n}`,
  asset: `shot ${n} take.mp4`,
  start,
  len,
  in: 0,
  out: len,
  sourceDuration: 10,
  muted: true,
  framing: "fit",
  speed: 1,
  sceneShot: n,
});
export const SCENE_DONE_STATE = {
  ...EDITOR_STATE,
  media: [
    ...EDITOR_STATE.media,
    NARRATION_ASSET,
    { id: "t-1", name: "shot 1 take.mp4", type: "video", duration: 10, origin: "generated" },
    { id: "t-2", name: "shot 2 take.mp4", type: "video", duration: 10, origin: "generated" },
    { id: "t-3", name: "shot 3 take.mp4", type: "video", duration: 10, origin: "generated" },
  ],
  videoTrack: [sceneClip(1, 0, 3), sceneClip(2, 3, 3), sceneClip(3, 6, 3)],
  soundtrack: [{ id: "au-n", asset: NARRATION_ASSET.name, start: 0, len: 9, in: 0, out: 9, volume: 1 }],
};

/** The clip mention refs the composer attaches for "@c1"/"@c2". */
export const CLIP_REFS = [
  { scope: "clip", id: "sc-1", name: "clip 1", kind: "video", url: "file:sc-1", duration: 3, handle: "c1" },
  { scope: "clip", id: "sc-2", name: "clip 2", kind: "video", url: "file:sc-2", duration: 3, handle: "c2" },
];

/** What generate_scene returns after planning (mirrors aiTools' note). */
export const SCENE_PLANNED = {
  planned: true,
  shots: 5,
  note: "Planned 5 shots over the audio. A plan card below lists the shots for the user, so keep your reply to one short line — don't re-describe the shots or the timing. Just ask them to confirm; when they do, call approve_scene (each shot spends credits, so don't approve on your own).",
};

/** Scene-case interceptor: asserts on generate_scene's arguments and fails
 * the case if the model self-approves the plan. */
export function makeSceneSim(check: (args: Record<string, unknown>) => void) {
  return () => (name: string, args: Record<string, unknown>): unknown => {
    if (name === "generate_scene") {
      check(args);
      return SCENE_PLANNED;
    }
    if (name === "approve_scene") throw new Error("approve_scene before the user confirmed");
    return undefined;
  };
}

/** A composer message as the production loop receives it. The eval-only
 * fields carry what production resolves live: the editor snapshot this turn
 * rides with, and the wire media its attachments resolve to. */
export interface EvalMessage {
  id: string;
  role: "user" | "assistant";
  parts: { type: string; text?: string; state?: string }[];
  metadata?: { attachments?: unknown[] };
  __state?: unknown;
  __wireParts?: Item[];
}

let turnSeq = 0;

export function userTurn(
  text: string,
  opts?: {
    attachAudio?: { dataBase64: string; mimeType: string };
    attachRefs?: unknown[];
    state?: unknown;
  }
): EvalMessage {
  const refs = [...(opts?.attachAudio ? [VOICE_REF] : []), ...(opts?.attachRefs ?? [])];
  const wire: Item[] = [];
  if (opts?.attachAudio) {
    wire.push({ text: `Attached audio "${VOICE_REF.name}":` });
    wire.push({ type: "input_audio", ...opts.attachAudio });
  }
  return {
    id: `m${++turnSeq}`,
    role: "user",
    parts: [{ type: "text", text }],
    ...(refs.length > 0 ? { metadata: { attachments: refs } } : {}),
    ...(opts?.state !== undefined ? { __state: opts.state } : {}),
    ...(wire.length > 0 ? { __wireParts: wire } : {}),
  };
}

/** Earlier turns in a multi-message case: plain text — production attaches
 * the editor snapshot to the newest user message alone. */
export const plainUserTurn = (text: string): EvalMessage => ({
  id: `m${++turnSeq}`,
  role: "user",
  parts: [{ type: "text", text }],
});
export const assistantTurn = (text: string): EvalMessage => ({
  id: `m${++turnSeq}`,
  role: "assistant",
  parts: [{ type: "text", text }],
});

/** An earlier assistant turn that ran tools; the loop's legacy converter
 * folds these settled tool parts into the replayed context. */
export const assistantToolTurn = (text: string, tools: string[]): EvalMessage => ({
  id: `m${++turnSeq}`,
  role: "assistant",
  parts: [
    { type: "text", text },
    ...tools.map((t) => ({ type: `tool-${t}`, state: "output-available" })),
  ],
});

/** A tiny track-0 simulator for composed cut flows: splits, trims, deletes,
 * and undo evolve real state, so get_state shows the model its own edits and
 * later calls can use the new clip ids. A frozen snapshot can't support a
 * multi-step cut — the model chases clips that "aren't there" and stalls. */
export function makeTimelineSim(base: typeof FILLER_STATE) {
  interface SimClip {
    id: string;
    start: number;
    in: number;
    out: number;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let clips: SimClip[] = base.videoTrack.map((c) => ({
    id: c.id,
    start: c.start,
    in: c.in,
    out: c.out,
  }));
  let cues = base.subtitles.cues.map((c) => ({ ...c }));
  let audio: SimClip[] = base.soundtrack.map((a) => ({
    id: a.id,
    start: a.start,
    in: a.in,
    out: a.out,
  }));
  const history: { clips: SimClip[]; audio: SimClip[] }[] = [];
  const remember = () => history.push({ clips, audio });
  let n = 0;
  const ripple = () => {
    let t = 0;
    clips = clips.map((c) => {
      const next = { ...c, start: r2(t) };
      t += c.out - c.in;
      return next;
    });
  };
  const snapshot = () => ({
    ...base,
    project: { ...base.project, duration: r2(clips.reduce((s, c) => s + c.out - c.in, 0)) },
    subtitles: {
      ...base.subtitles,
      count: cues.length,
      tracks: [{ track: 0, locale: "en-US", cues: cues.length }],
      cues,
    },
    soundtrack: audio.map((a) => ({
      id: a.id,
      asset: VOICE_ASSET.name,
      start: a.start,
      len: r2(a.out - a.in),
      in: a.in,
      out: a.out,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
      duck: 0.4,
    })),
    videoTrack: clips.map((c, i) => ({
      index: i,
      id: c.id,
      asset: "beach.mp4",
      start: c.start,
      len: r2(c.out - c.in),
      in: c.in,
      out: c.out,
      sourceDuration: 20,
      muted: false,
      framing: "fit",
      speed: 1,
    })),
  });
  // Mirrors production aiTools: every timeline mutation returns the updated
  // rows so the model keeps cutting from ids in the result.
  const rows = () => ({
    track0: clips.map((c) => ({ id: c.id, start: c.start, len: r2(c.out - c.in) })),
    soundtrack: audio.map((a) => ({ id: a.id, start: a.start, len: r2(a.out - a.in) })),
  });
  return (name: string, args: Record<string, unknown>): unknown => {
    if (name === "get_state") return snapshot();
    // A caption refresh after the cut: the fixture's cues already sit on the
    // speech, so the pass moves nothing.
    if (name === "align_to_audio")
      return { target: "captions", track: 0, count: cues.length, moved: 0, note: "Every caption edge already sits on the speech." };
    if (name === "refine_speech_cuts") {
      const ids = Array.isArray(args.clip_ids) ? args.clip_ids.map(String) : [];
      const missing = ids.filter((id) => !clips.some((c) => c.id === id));
      if (ids.length === 0 || missing.length > 0)
        return { error: `No such clip(s): ${missing.join(", ") || "(none given)"}.` };
      return { refined: ids, note: "Edges re-trimmed into the nearest pauses.", ...rows() };
    }
    if (name === "split_at") {
      const t = Number(args.t);
      const splittable = (x: SimClip) => t > x.start + 0.05 && t < x.start + (x.out - x.in) - 0.05;
      const cut = (list: SimClip[]) =>
        list.flatMap((x) => {
          if (!splittable(x)) return [x];
          const at = r2(x.in + (t - x.start));
          return [
            { id: `${x.id}-${++n}`, start: x.start, in: x.in, out: at },
            { id: `${x.id}-${++n}`, start: r2(t), in: at, out: x.out },
          ];
        });
      if (!Number.isFinite(t) || (!clips.some(splittable) && !audio.some(splittable)))
        return { error: "Nothing to split at that time." };
      remember();
      clips = cut(clips);
      audio = cut(audio);
      return { split: true, ...rows() };
    }
    if (name === "delete_item") {
      const id = String(args.id);
      if (args.kind === "clip") {
        if (!clips.some((c) => c.id === id)) return { error: `No clip with id ${id}.` };
        remember();
        clips = clips.filter((c) => c.id !== id);
        ripple();
        return { deleted: { kind: "clip", id }, ...rows() };
      }
      if (args.kind === "audio") {
        if (!audio.some((a) => a.id === id)) return { error: `No audio with id ${id}.` };
        remember();
        audio = audio.filter((a) => a.id !== id);
        return { deleted: { kind: "audio", id }, ...rows() };
      }
      return undefined;
    }
    if (name === "trim_clip") {
      const c = clips.find((x) => x.id === String(args.clipId));
      if (!c) return { error: `No video clip with id ${String(args.clipId)}.` };
      const nextIn = typeof args.in === "number" ? args.in : c.in;
      const nextOut = typeof args.out === "number" ? args.out : c.out;
      if (nextOut - nextIn < 0.1) return { error: "Clip must stay at least 0.1s long." };
      remember();
      clips = clips.map((x) => (x === c ? { ...x, in: nextIn, out: nextOut } : x));
      ripple();
      return { in: nextIn, out: nextOut, len: r2(nextOut - nextIn), ...rows() };
    }
    if (name === "place_clip") {
      const c = clips.find((x) => x.id === String(args.clipId));
      if (!c) return { error: `No video clip with id ${String(args.clipId)}.` };
      remember();
      const at = typeof args.start === "number" ? Math.max(0, args.start) : c.start;
      clips = clips
        .map((x) => (x === c ? { ...x, start: at } : x))
        .sort((a, b) => a.start - b.start);
      ripple();
      return { start: at, ...rows() };
    }
    if (name === "update_audio") {
      const a = audio.find((x) => x.id === String(args.id));
      if (!a) return { error: `No soundtrack clip with id ${String(args.id)}.` };
      remember();
      audio = audio.map((x) =>
        x === a
          ? {
              ...x,
              start: typeof args.start === "number" ? args.start : x.start,
              in: typeof args.in === "number" ? args.in : x.in,
              out: typeof args.out === "number" ? args.out : x.out,
            }
          : x
      );
      return { id: a.id, ok: true };
    }
    if (name === "undo") {
      const prev = history.pop();
      if (prev) {
        clips = prev.clips;
        audio = prev.audio;
      }
      return { ok: true, ...rows() };
    }
    if (name === "delete_cue") {
      const cue = cues.find((c) => c.id === String(args.id));
      if (!cue) return { error: `No subtitle cue with id ${String(args.id)}.` };
      cues = cues.filter((c) => c !== cue);
      return { deleted: cue.id };
    }
    if (name === "update_cue") {
      const cue = cues.find((c) => c.id === String(args.id));
      if (!cue) return { error: `No subtitle cue with id ${String(args.id)}.` };
      if (typeof args.text === "string") cue.text = args.text;
      if (typeof args.start === "number") cue.start = args.start;
      if (typeof args.end === "number") cue.end = args.end;
      return { id: cue.id, text: cue.text, start: cue.start, end: cue.end };
    }
    if (name === "merge_cue") {
      const i = cues.findIndex((c) => c.id === String(args.id));
      if (i < 0) return { error: `No subtitle cue with id ${String(args.id)}.` };
      if (i === 0) return { error: "That is its track's first cue — nothing before it to merge into." };
      cues[i - 1] = { ...cues[i - 1], end: cues[i].end, text: `${cues[i - 1].text} ${cues[i].text}` };
      cues.splice(i, 1);
      return { mergedInto: "previous cue" };
    }
    return undefined;
  };
}

/** Serve a read-only tool from the fixture snapshot. */
export function serveSafeTool(name: string, state: unknown): unknown {
  if (name === "get_state") {
    // The fixture snapshot is frozen — it can't reflect this turn's stubbed
    // edits. Say so, or the model sees its adds "missing" and re-adds in a
    // loop (the live store never has this problem).
    return {
      ...(state as Record<string, unknown>),
      note: "Snapshot may lag this turn's edits — trust each tool's own result.",
    };
  }
  if (name === "list_skills") return { skills: AI_SKILL_INDEX };
  if (name === "library_list") return { folders: [], assets: [], templates: [] };
  if (name === "notes_list") return { notes: [], folders: [], labels: [] };
  if (name === "detect_silence") return { silences: [] };
  if (name === "detect_beats") return { bpm: 0, beats: [] };
  return { ok: true };
}
