#!/usr/bin/env bun
/**
 * Behavior evals for the Cut assistant chat.
 *
 * Each case replays a real composer turn (system prompt, tool catalog,
 * <attached_assets>, <editor_state>, inline audio) against the live chat
 * model through the hosted Responses route and asserts on what the model
 * does: questions get answered in chat without project-mutating tool calls,
 * edit requests still reach for tools.
 *
 * Run with the site dev server up:
 *   bun run scripts/eval-cut-chat.ts [--base http://localhost:3000] [--only <case>] [--runs N]
 *
 * Auth is the dev bypass header (scripts only — never the app), so runs are
 * dev-server-only and spend no credits. The spoken fixture is synthesized
 * locally with macOS `say`, so the transcript assertion is deterministic.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiModelRoles } from "../src/lib/inference/gemini-models";
import { AI_SKILL_INDEX, AI_SKILLS, AI_TOOLS, attachedAssetsBlock, systemPrompt, toolsRanBlock } from "../src/cut/server/ai/catalog";
import {
  parseTurnIntent,
  TURN_INTENT_PROMPT,
  turnIntentInput,
  type TurnIntent,
} from "../src/cut/lib/turnIntent";

type Item = Record<string, unknown>;

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const BASE = argValue("--base") ?? "http://localhost:3000";
const ONLY = argValue("--only");
const RUNS = Number(argValue("--runs") ?? 1);
// Matches the production chat loop's tool-round cap (geminiChat.ts).
const MAX_ROUNDS = 24;

// Tools that read or steer the view without changing the cut or spending
// credits. Anything outside this set counts as a mutation for the evals.
const SAFE_TOOLS = new Set([
  "get_state",
  "list_skills",
  "read_skill",
  "capture_frame",
  "watch_video",
  "detect_silence",
  "listen_audio",
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

const SPOKEN_LINE = "Hi, this is Mason.";

/** Synthesize the fixture line locally (macOS say + afconvert), base64 wav. */
function makeFixtureAudio(): { dataBase64: string; mimeType: string } {
  const dir = mkdtempSync(join(tmpdir(), "cut-eval-"));
  const aiff = join(dir, "line.aiff");
  const wav = join(dir, "line.wav");
  const say = spawnSync("say", ["-o", aiff, SPOKEN_LINE]);
  if (say.status !== 0) throw new Error(`say failed: ${say.stderr}`);
  const conv = spawnSync("afconvert", ["-f", "WAVE", "-d", "LEI16@22050", "-c", "1", aiff, wav]);
  if (conv.status !== 0) throw new Error(`afconvert failed: ${conv.stderr}`);
  return { dataBase64: readFileSync(wav).toString("base64"), mimeType: "audio/wav" };
}

const VOICE_ASSET = {
  id: "a-vo1",
  name: "AI voice — Hi, this is",
  type: "audio",
  duration: 1.6,
  origin: "voiceover",
};

/** Photos dropped on the chat composer: imported as plain user media (no
 * origin), referenced by the message's attachment metadata. */
const PHOTO_ASSETS = [
  { id: "a-i1", name: "dog-park.jpg", type: "image" },
  { id: "a-i2", name: "dog-beach.jpg", type: "image" },
];

const PHOTO_REFS = PHOTO_ASSETS.map((a, i) => ({
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
const EDITOR_STATE = {
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
const TWO_CLIP_STATE = {
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
const CROSSFADED_STATE = {
  ...TWO_CLIP_STATE,
  videoTrack: [
    { ...TWO_CLIP_STATE.videoTrack[0], transitionToNext: { style: "crossfade", seconds: 0.5 } },
    { ...TWO_CLIP_STATE.videoTrack[1], start: 5.5 },
  ],
};

/** A user-imported narration file for the scene-production cases. */
const NARRATION_ASSET = { id: "a-au1", name: "narration.mp3", type: "audio", duration: 24 };

const VOICE_REF = {
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
const FILLER_CUES = [
  { id: "cue1", start: 0, end: 1.8, text: "Um, so today we're" },
  { id: "cue2", start: 1.8, end: 4.2, text: "at the beach with the dogs" },
  { id: "cue3", start: 4.2, end: 5.6, text: "and, uh, you know," },
  { id: "cue4", start: 5.6, end: 9, text: "they absolutely love the water" },
  { id: "cue5", start: 9, end: 12.5, text: "so let's watch them play" },
];

const FILLER_STATE = {
  ...EDITOR_STATE,
  subtitles: {
    ...EDITOR_STATE.subtitles,
    count: FILLER_CUES.length,
    tracks: [{ track: 0, locale: "en-US", cues: FILLER_CUES.length }],
    cues: FILLER_CUES,
  },
};

/** The base snapshot plus the narration import — the scene cases' spine. */
const AUDIO_STATE = {
  ...EDITOR_STATE,
  media: [...EDITOR_STATE.media, NARRATION_ASSET],
};

/** A tweet photo import_url landed in an earlier turn: chat-owned (aiTools
 * tags chat imports origin "chat"), named by the post's text, not yet placed.
 * A past turn replays as its text plus a ledger of the tool names it ran, so
 * the model must find this asset through `media` in the snapshot. */
const TWEET_ASSET = {
  id: "a-tw1",
  name: "first snow of the year ❄️",
  type: "image",
  origin: "chat",
};

const TWEET_STATE = {
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
const STYLED_STATE = {
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
const SCENE_DONE_STATE = {
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
const CLIP_REFS = [
  { scope: "clip", id: "sc-1", name: "clip 1", kind: "video", url: "file:sc-1", duration: 3, handle: "c1" },
  { scope: "clip", id: "sc-2", name: "clip 2", kind: "video", url: "file:sc-2", duration: 3, handle: "c2" },
];

/** What generate_scene returns after planning (mirrors aiTools' note). */
const SCENE_PLANNED = {
  planned: true,
  shots: 5,
  note: "Planned 5 shots over the audio. A plan card below lists the shots for the user, so keep your reply to one short line — don't re-describe the shots or the timing. Just ask them to confirm; when they do, call approve_scene (each shot spends credits, so don't approve on your own).",
};

/** Scene-case interceptor: asserts on generate_scene's arguments and fails
 * the case if the model self-approves the plan. */
function makeSceneSim(check: (args: Record<string, unknown>) => void) {
  return () => (name: string, args: Record<string, unknown>): unknown => {
    if (name === "generate_scene") {
      check(args);
      return SCENE_PLANNED;
    }
    if (name === "approve_scene") throw new Error("approve_scene before the user confirmed");
    return undefined;
  };
}

/** A composer turn as geminiChat's inputFromMessages builds it (keep the
 * envelope text in sync with geminiChat.ts). */
function userTurn(
  text: string,
  opts?: {
    attachAudio?: { dataBase64: string; mimeType: string };
    attachRefs?: unknown[];
    state?: unknown;
  }
): Item {
  let full = text;
  const extra: Item[] = [];
  const refs = [...(opts?.attachAudio ? [VOICE_REF] : []), ...(opts?.attachRefs ?? [])];
  full += attachedAssetsBlock(refs);
  if (opts?.attachAudio) {
    extra.push({ text: `Attached audio "${VOICE_REF.name}":` });
    extra.push({ type: "input_audio", ...opts.attachAudio });
  }
  full += `\n\n<editor_state>\n${JSON.stringify(opts?.state ?? EDITOR_STATE)}\n</editor_state>`;
  return { role: "user", content: [{ text: full }, ...extra] };
}

/** Earlier turns in a multi-message case: plain text, no envelope — production
 * attaches the editor snapshot to the newest user message alone. */
const plainUserTurn = (text: string): Item => ({ role: "user", content: [{ text }] });
const assistantTurn = (text: string): Item => ({ role: "assistant", content: [{ text }] });

/** An earlier assistant turn that ran tools, carrying the same <tools_ran>
 * ledger production replays it with (catalog's toolsRanBlock). */
const assistantToolTurn = (text: string, tools: string[]): Item => ({
  role: "assistant",
  content: [{ text: `${text}${toolsRanBlock(tools)}` }],
});

/** A tiny track-0 simulator for composed cut flows: splits, trims, deletes,
 * and undo evolve real state, so get_state shows the model its own edits and
 * later calls can use the new clip ids. A frozen snapshot can't support a
 * multi-step cut — the model chases clips that "aren't there" and stalls. */
function makeTimelineSim(base: typeof FILLER_STATE) {
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
  return (name: string, args: Record<string, unknown>): unknown => {
    if (name === "get_state") return snapshot();
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
      return { split: true, videoClips: clips.length };
    }
    if (name === "delete_item") {
      const id = String(args.id);
      if (args.kind === "clip") {
        if (!clips.some((c) => c.id === id)) return { error: `No clip with id ${id}.` };
        remember();
        clips = clips.filter((c) => c.id !== id);
        ripple();
        return { deleted: { kind: "clip", id } };
      }
      if (args.kind === "audio") {
        if (!audio.some((a) => a.id === id)) return { error: `No audio with id ${id}.` };
        remember();
        audio = audio.filter((a) => a.id !== id);
        return { deleted: { kind: "audio", id } };
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
      return { in: nextIn, out: nextOut, len: r2(nextOut - nextIn) };
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
      return { start: at };
    }
    if (name === "undo") {
      const prev = history.pop();
      if (prev) {
        clips = prev.clips;
        audio = prev.audio;
      }
      return { ok: true, videoClips: clips.length };
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

// ---------------------------------------------------------------------------
// Cases

interface EvalCase {
  name: string;
  input: () => Item[];
  /** The final reply must match. */
  reply: RegExp;
  /** Tools that MUST appear across the turn (each stubbed to succeed). */
  requiredTools?: string[];
  /** At least one of these must appear — for flows with several valid cuts. */
  anyTools?: string[];
  /** Latency guard: the turn fails if the trace exceeds this many calls. A
   * simple ask must not detour through skill reads or state polls. */
  maxToolCalls?: number;
  /** The tool gate's required verdict for the turn ("chat" turns run with no
   * tool declarations, so tool calls become impossible). */
  gate?: TurnIntent;
  /** Editor snapshot served to get_state for this case (default EDITOR_STATE). */
  state?: unknown;
  /** Per-run tool interceptor (fresh per run); a non-undefined return serves
   * the call before stubs and safe tools. */
  simulate?: () => (name: string, args: Record<string, unknown>) => unknown;
  /** Stub results for expected tool calls. */
  stubs?: Record<string, unknown>;
}

function cases(audio: { dataBase64: string; mimeType: string }): EvalCase[] {
  return [
    {
      // The regression from the screenshot: asking for an attached audio's
      // text must be answered from the inline audio — in chat, no captions
      // written onto the project.
      name: "transcribe-attached-audio",
      input: () => [userTurn("get the text from this", { attachAudio: audio })],
      reply: /mason/i,
    },
    {
      // The tool gate (the "hi" regression, which once fired an unsolicited
      // subtitles_generate): a bare greeting asks for nothing, so the turn
      // must classify "chat" and run with every tool declaration withheld.
      name: "greeting-is-gated",
      input: () => [userTurn("hi")],
      reply: /help|what would you/i,
      gate: "chat",
      maxToolCalls: 0,
    },
    {
      // Same gate mid-conversation: thanks after landed work requests nothing.
      name: "thanks-is-gated",
      input: () => [
        plainUserTurn("trim the first clip down to 5 seconds"),
        assistantTurn("Trimmed! The first clip now runs 5 seconds."),
        userTurn("nice, thank you!"),
      ],
      reply: /\S/,
      gate: "chat",
      maxToolCalls: 0,
    },
    {
      // Context rides into the gate: a terse follow-up is a request — its
      // referent lives in the earlier turns — so it classifies "work" and the
      // caption cleanup actually lands.
      name: "follow-up-do-it-works",
      input: () => [
        plainUserTurn("could you clean up my captions? lots of filler words"),
        assistantTurn(
          "Happy to — I'd tidy the five cues on track 0, dropping the ums and uhs. Want me to go ahead?"
        ),
        userTurn("yes do it", { state: FILLER_STATE }),
      ],
      reply: /cue|caption|filler|clean|tidi|done|\bum\b|\buh\b|remove|swept/i,
      gate: "work",
      anyTools: ["update_cue", "delete_cue", "merge_cue"],
      state: FILLER_STATE,
      simulate: () => makeTimelineSim(FILLER_STATE),
    },
    {
      // Plain questions answer from the snapshot; at most safe reads.
      name: "question-answers-in-chat",
      input: () => [userTurn("how long is my cut right now?")],
      reply: /12[.,]?5?/,
    },
    {
      // The "drag photos in, ask for a movie" flow: an explicit ask to put
      // attached media in the cut must reach add_clip for each photo. Styling
      // follow-ups a movie ask can reasonably trigger are stubbed too.
      name: "photos-request-places-clips",
      input: () => [
        userTurn("stitch these two photos into a short movie", { attachRefs: PHOTO_REFS }),
      ],
      reply: /photo|movie|timeline|cut/i,
      requiredTools: ["add_clip"],
      stubs: {
        add_clip: { id: "c-new", kind: "image", index: 1, start: 12.5, len: 8 },
        set_transition: { ok: true },
        set_project_fade: { ok: true },
        add_title: { ok: true },
      },
    },
    {
      // Attached media with a question stays a chat deliverable: ideas in
      // text, the photos stay off the timeline (add_clip would be a violation).
      name: "photos-question-stays-in-chat",
      input: () => [
        userTurn("what could you make with these two photos?", { attachRefs: PHOTO_REFS }),
      ],
      // Any engaged ideas answer counts — the real assertion is that no
      // mutating tool ran on a question turn.
      reply: /photo|movie|montage|slideshow|cut|idea|story|transition|split|dog|pup|beach|park/i,
    },
    {
      // Destructive and organizing tools stay sheathed without an explicit
      // command: venting about clutter deletes and files nothing.
      name: "clutter-complaint-deletes-nothing",
      input: () => [userTurn("ugh, my project is getting cluttered with files")],
      reply: /media|asset|file|clean|organi|tidy|clutter|remove|delete/i,
    },
    {
      // Fast path: a plain text-only video ask is ONE generate_video call —
      // no scene pipeline, no image staging, no skill-doc detour first.
      name: "video-ask-single-generate",
      input: () => [userTurn("generate a video about dogs")],
      reply: /video|render|dog|minute/i,
      requiredTools: ["generate_video"],
      maxToolCalls: 2,
      stubs: {
        generate_video: {
          kind: "video",
          started: true,
          jobId: "job-dogs",
          addToTimeline: false,
          note:
            "Rendering — it previews in this chat when it lands, in a minute or two. It stays in the chat until the user places it.",
        },
      },
    },
    {
      // The screenshot regression: iterating on an existing clip ("make me a
      // better version / closer to the original / a different take") ADDS a
      // fresh generation and leaves the clip in place. Without an explicit
      // "delete / replace / remove this", deleting the user's existing work
      // to "make room" is wrong — the trap word "instead"/"version" is not a
      // delete instruction.
      name: "iterate-keeps-existing-clip",
      input: () => [
        userTurn("the beach clip feels off — make me a better version, more of a golden-hour sunset"),
      ],
      reply: /version|render|sunset|golden|minute|new|preview|kept|left|place/i,
      requiredTools: ["generate_video"],
      simulate: () => (name) => {
        if (name === "delete_item")
          throw new Error("delete_item — iterating is not a delete/replace; the existing clip must stay");
        if (name === "delete_asset")
          throw new Error("delete_asset — iterating must not remove the existing clip's media");
        return undefined;
      },
      stubs: {
        generate_video: {
          kind: "video",
          started: true,
          jobId: "job-sunset",
          addToTimeline: false,
          note:
            "Rendering a new take — it previews in this chat when it lands, in a minute or two. Your current clip stays put.",
        },
      },
    },
    {
      // The screenshot regression: after a turn that imported a reference and
      // styled the cut, "mute all clips" mutes and stops. A replayed
      // conversation carries no tool traffic, so without the <tools_ran>
      // ledger the model reads its own last reply as an unfinished plan and
      // runs the whole thing again — re-importing, re-watching, re-styling —
      // then narrates that as the answer. The snapshot names every clip and
      // its muted flag, so the mute needs no reads either.
      name: "mute-all-does-not-redo-prior-turn",
      input: () => [
        plainUserTurn(
          "use the illustration style at https://x.com/example/status/1 and blend the three city clips together"
        ),
        assistantToolTurn(
          "Imported the reference illustration and blended Seoul, San Francisco, and Toronto with 1-second crosszooms.",
          ["import_url", "watch_video", "watch_video", "watch_video", "set_transition", "set_transition"]
        ),
        userTurn("mute all clips", { state: STYLED_STATE }),
      ],
      reply: /mut/i,
      requiredTools: ["set_clip_muted"],
      maxToolCalls: 3,
      state: STYLED_STATE,
      simulate: () => (name) => {
        if (name === "import_url" || name === "watch_video" || name === "set_transition")
          throw new Error(`${name} — the previous turn already ran it; "mute all clips" only mutes`);
        return undefined;
      },
      stubs: { set_clip_muted: { muted: true } },
    },
    {
      // The tweet-import flow: after import_url landed a photo in an earlier
      // turn, "the exact same thing but…" must anchor generate_image on that
      // asset via reference_asset_ids — the compose pass and image model see
      // the real photo only through the reference, so a text-only render of
      // the model's guess loses the source image entirely.
      name: "imported-photo-edit-references-photo",
      input: () => [
        plainUserTurn("https://x.com/oggii_0/status/2079613105571828043"),
        assistantTurn(
          `Imported the photo from that post — it's on a card in this chat. The post says: "${TWEET_ASSET.name}".`
        ),
        userTurn("generate the exact same thing but put her in a santa hat", {
          state: TWEET_STATE,
        }),
      ],
      reply: /santa|hat|image|render|preview/i,
      requiredTools: ["generate_image"],
      state: TWEET_STATE,
      simulate: () => (name, args) => {
        if (name === "generate_image") {
          const refs = Array.isArray(args.reference_asset_ids)
            ? args.reference_asset_ids.map(String)
            : [];
          if (!refs.includes(TWEET_ASSET.id))
            throw new Error(
              `generate_image must reference ${TWEET_ASSET.id}, got ${JSON.stringify(args.reference_asset_ids)}`
            );
          return {
            assetId: "a-gen1",
            kind: "image",
            note: "Rendered — the image previews on a card in this chat.",
          };
        }
        if (name === "watch_video")
          return { note: "Eval: the photo shows a young woman smiling outdoors in falling snow." };
        if (name === "generate_video" || name === "generate_scene")
          throw new Error(`${name} called — an edited copy of a photo is a generate_image ask`);
        return undefined;
      },
    },
    {
      // Fast path: audio generation goes straight to voiceover_generate
      // (list_voices is a fine extra hop, more than that is a detour).
      name: "audio-ask-single-generate",
      input: () => [userTurn("generate a voiceover that says welcome to the dog show")],
      reply: /voice|audio|narrat|welcome/i,
      requiredTools: ["voiceover_generate"],
      maxToolCalls: 3,
      stubs: {
        voiceover_generate: {
          assetId: "a-tts2",
          name: "AI voice — welcome to the dog show",
          start: 0,
          duration: 2.3,
          voice: "aoede",
        },
      },
    },
    {
      // Background music goes straight to generate_music (not voiceover, which
      // is speech; not generate_scene, which is a whole narrated production).
      name: "music-ask-single-generate",
      input: () => [userTurn("add some chill background music to this video")],
      reply: /music|track|bed|chill|background/i,
      requiredTools: ["generate_music"],
      maxToolCalls: 3,
      stubs: {
        generate_music: {
          assetId: "a-music1",
          name: "chill background music",
          duration: 30,
          addedToTimeline: false,
        },
      },
    },
    {
      // Fast path: a direct edit is one trim_clip on the clip in the snapshot.
      name: "trim-ask-single-tool",
      input: () => [userTurn("trim the first clip down to 5 seconds")],
      reply: /trim|5|second/i,
      requiredTools: ["trim_clip"],
      maxToolCalls: 2,
      stubs: { trim_clip: { in: 0, out: 5, len: 5 } },
    },
    {
      // Effects: a styled transition ask is one set_transition on the LEADING
      // clip with the catalog style id (a skill read on the way is fine).
      name: "transition-ask-styled",
      input: () => [
        userTurn("add a push down transition between the two clips", { state: TWO_CLIP_STATE }),
      ],
      reply: /push|transition/i,
      requiredTools: ["set_transition"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_transition") return undefined;
        if (args.clipId !== "c1")
          throw new Error(`set_transition on ${args.clipId} — the transition belongs to the leading clip c1`);
        if (args.style !== "pushdown")
          throw new Error(`style ${args.style} — expected pushdown`);
        return { id: "c1", transition: Number(args.seconds) || 0.5, style: "pushdown" };
      },
    },
    {
      // Directional comprehension: slide names are the motion direction, so
      // "slide in from the left" moves rightward — slideright on c2's "in".
      name: "slide-in-direction-correct",
      input: () => [
        userTurn("make the second clip slide in from the left", { state: TWO_CLIP_STATE }),
      ],
      reply: /slide/i,
      requiredTools: ["set_animation"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_animation") return undefined;
        if (args.clipId !== "c2" || args.which !== "in")
          throw new Error(`set_animation ${args.clipId}/${args.which} — expected c2 "in"`);
        if (args.style !== "slideright")
          throw new Error(`style ${args.style} — "from the left" moves rightward (slideright)`);
        return { id: "c2", which: "in", style: "slideright", seconds: Number(args.seconds) || 0.5 };
      },
    },
    {
      // Looks route to set_look with a catalog id — not a hand-rolled
      // set_color_grade approximation.
      name: "look-ask-single-tool",
      input: () => [
        userTurn("give the second clip a retro VHS look", { state: TWO_CLIP_STATE }),
      ],
      reply: /vhs|retro|look/i,
      requiredTools: ["set_look"],
      maxToolCalls: 3,
      state: TWO_CLIP_STATE,
      simulate: () => (name, args) => {
        if (name !== "set_look") return undefined;
        if (args.clipId !== "c2") throw new Error(`set_look on ${args.clipId} — expected c2`);
        if (args.style !== "vhs") throw new Error(`style ${args.style} — expected vhs`);
        return { id: "c2", look: "vhs", amount: 1 };
      },
    },
    {
      // Last pick wins per edge: swapping a crossfading joint for an entrance
      // animation is a set_animation — the override clears the transition
      // itself (an explicit set_transition 0 first is fine, not required).
      // "Pop" exists only as an animation, so the routing is unambiguous
      // (a wipe ask could legitimately become a wipe *transition* instead).
      name: "animation-overrides-transition",
      input: () => [
        userTurn("get rid of the crossfade — make the second clip pop in instead", {
          state: CROSSFADED_STATE,
        }),
      ],
      reply: /pop/i,
      requiredTools: ["set_animation"],
      maxToolCalls: 4,
      state: CROSSFADED_STATE,
      simulate: () => (name, args) => {
        if (name === "set_transition") return { id: "c1", transition: 0, style: "crossfade" };
        if (name !== "set_animation") return undefined;
        if (args.clipId !== "c2" || args.which !== "in")
          throw new Error(`set_animation ${args.clipId}/${args.which} — expected c2 "in"`);
        if (args.style !== "pop") throw new Error(`style ${args.style} — expected pop`);
        return { id: "c2", which: "in", style: "pop", seconds: 0.5 };
      },
    },
    {
      // Driving the editor on the user's behalf: with a transcript in the
      // snapshot, "cut the filler words" must land real timeline cuts (split
      // then delete, or a trim) — not just talk about them, and not merely
      // rewrite the captions.
      name: "filler-words-cut-with-editor",
      input: () => [userTurn("cut the filler words out of my video", { state: FILLER_STATE })],
      reply: /filler|um|uh|cut|remove|trim/i,
      anyTools: ["split_at", "delete_item", "trim_clip"],
      state: FILLER_STATE,
      simulate: () => makeTimelineSim(FILLER_STATE),
    },
    {
      // Control: a real edit request must still act with tools — guards
      // against over-suppressing tool use.
      name: "edit-request-still-uses-tools",
      input: () => [userTurn("add captions to my video")],
      reply: /caption|subtitle/i,
      requiredTools: ["subtitles_generate"],
      stubs: {
        subtitles_generate: {
          status: "done",
          track: 0,
          locale: "en-US",
          cues: 12,
          note: "Transcribed the cut onto subtitle track 0.",
        },
      },
    },
    {
      // A cartoon ask over project audio is one generate_scene plan: the
      // audio rides as the spine, the plan waits for the user's go-ahead,
      // and a 9:16 project takes 9:16 shots.
      name: "cartoon-from-audio-plans-scene",
      input: () => [
        userTurn("turn my narration audio into a smooth 2D cartoon", { state: AUDIO_STATE }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        if (String(args.from_audio_asset_id ?? "") !== NARRATION_ASSET.id)
          throw new Error(
            `generate_scene must animate ${NARRATION_ASSET.id}, got ${JSON.stringify(args.from_audio_asset_id)}`
          );
        if (args.aspect !== undefined && args.aspect !== "9:16")
          throw new Error(
            `generate_scene aspect must match the 9:16 project, got ${JSON.stringify(args.aspect)}`
          );
      }),
    },
    {
      // Foreign source audio: the speech language rides audio_language so the
      // on-device recognizer matches, and the audio still spines the cut.
      name: "cartoon-korean-audio-passes-language",
      input: () => [
        userTurn("my narration audio is in Korean — turn it into a smooth 2D cartoon", {
          state: AUDIO_STATE,
        }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene|korean/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        if (String(args.from_audio_asset_id ?? "") !== NARRATION_ASSET.id)
          throw new Error("generate_scene must animate the narration audio");
        if (!/^ko(-|$)/i.test(String(args.audio_language ?? "")))
          throw new Error(
            `audio_language must name Korean, got ${JSON.stringify(args.audio_language)}`
          );
      }),
    },
    {
      // A style image attached to the ask anchors the scene's look: its asset
      // id must ride reference_asset_ids into the plan.
      name: "cartoon-style-reference-anchors-look",
      input: () => [
        userTurn("make a cartoon episode from my narration audio in the style of this picture", {
          state: AUDIO_STATE,
          attachRefs: [PHOTO_REFS[0]],
        }),
      ],
      reply: /shot|plan|confirm|approv|cartoon|scene|style/i,
      requiredTools: ["generate_scene"],
      state: AUDIO_STATE,
      simulate: makeSceneSim((args) => {
        const refs = Array.isArray(args.reference_asset_ids)
          ? args.reference_asset_ids.map(String)
          : [];
        if (!refs.includes(PHOTO_ASSETS[0].id))
          throw new Error(
            `reference_asset_ids must carry ${PHOTO_ASSETS[0].id}, got ${JSON.stringify(args.reference_asset_ids)}`
          );
      }),
    },
    {
      // A "how would you" cartoon question is a chat deliverable: approach in
      // words, the scene pipeline untouched (generate_scene would violate).
      name: "cartoon-question-stays-in-chat",
      input: () => [
        userTurn("how would you turn my narration audio into a 2D cartoon?", {
          state: AUDIO_STATE,
        }),
      ],
      reply: /cartoon|scene|shot|animate|style|narration/i,
      state: AUDIO_STATE,
    },
    {
      // Timeline mentions: "@c1 and @c2 are too similar" must map through the
      // clip attachments to videoTrack's sceneShot numbers and revise those
      // exact shots — regenerate_shot with the complaint riding as the note,
      // never a fresh generate_video/generate_scene.
      name: "clip-mentions-redo-their-shots",
      input: () => [
        userTurn(
          "clip 1 and clip 2 are too similar and they don't match the audio. fix them",
          { attachRefs: CLIP_REFS, state: SCENE_DONE_STATE }
        ),
      ],
      reply: /shot|redo|regenerat/i,
      requiredTools: ["regenerate_shot"],
      state: SCENE_DONE_STATE,
      simulate: () => {
        const redone = new Set<number>();
        return (name, args) => {
          if (name === "regenerate_shot") {
            const n = Number(args.n);
            if (n !== 1 && n !== 2) throw new Error(`regenerate_shot ${n} — the mentions were shots 1 and 2`);
            if (!String(args.note ?? "").trim()) throw new Error("regenerate_shot without the user's note");
            redone.add(n);
            return { ok: true, message: `Redoing shot ${n}…` };
          }
          if (name === "generate_video" || name === "generate_scene" || name === "restyle_scene")
            throw new Error(`${name} called — a clip complaint revises its shot, not a new render`);
          return undefined;
        };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Runner

const toolDeclarations = AI_TOOLS.map((t) => ({
  type: "function",
  name: t.name,
  description: t.description,
  parameters: t.inputSchema,
}));

/** A case item's composer text with the envelope stripped back off — the
 * gate's classifier sees the raw turn, before the snapshot rides on. */
const itemText = (item: Item): string => {
  const first = (item.content as { text?: string }[] | undefined)?.find(
    (p) => typeof p.text === "string"
  );
  return (first?.text ?? "")
    .split("\n\n<attached_assets>")[0]
    .split("\n\n<editor_state>")[0]
    .trim();
};

/** The production tool gate, replicated from geminiChat.ts: a message with
 * attachments is work by construction; otherwise the fast-decision model
 * judges the newest message. Fails open to "work". */
async function classifyIntent(input: Item[]): Promise<TurnIntent> {
  const lastUser = [...input].reverse().find((i) => i.role === "user");
  const raw =
    ((lastUser?.content as { text?: string }[]) ?? []).find((p) => typeof p.text === "string")
      ?.text ?? "";
  if (raw.includes("<attached_assets>")) return "work";
  const turns = input.map((i) => ({
    role: (i.role === "user" ? "user" : "assistant") as "user" | "assistant",
    text: itemText(i),
  }));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}/api/inference/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-donkey-client-id": "donkey-cut-eval",
        "x-donkey-dev-auth-bypass": "1",
      },
      body: JSON.stringify({
        donkeyProvider: "gemini",
        model: geminiModelRoles.fastDecision,
        instructions: TURN_INTENT_PROMPT,
        input: turnIntentInput(turns),
      }),
    });
    if (res.ok) {
      const body = (await res.json()) as { output_text?: string };
      return parseTurnIntent(body.output_text);
    }
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt >= 2) return "work";
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
}

function serveSafeTool(name: string, state: unknown): unknown {
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
  if (name === "detect_silence") return { silences: [] };
  return { ok: true };
}

interface CaseResult {
  pass: boolean;
  reply: string;
  trace: string[];
  violations: string[];
  notes: string[];
  intent: TurnIntent;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const input = c.input();
  // The gate runs first, exactly as in production: a "chat" verdict strips
  // the tool declarations from the whole turn.
  const intent = await classifyIntent(input);
  const tools = intent === "work" ? toolDeclarations : undefined;
  const sim = c.simulate?.();
  const trace: string[] = [];
  const violations: string[] = [];
  const notes: string[] = [];
  let reply = "";
  let emptyRounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    // A transient upstream failure (rate limit, Gemini 5xx) gets a couple of
    // retries so it doesn't read as a behavioral failure of the case.
    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${BASE}/api/inference/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-donkey-client-id": "donkey-cut-eval",
          "x-donkey-dev-auth-bypass": "1",
        },
        body: JSON.stringify({
          donkeyProvider: "gemini",
          model: geminiModelRoles.chat,
          instructions: systemPrompt(),
          input,
          ...(tools ? { tools } : {}),
        }),
      });
      if (res.ok || ![429, 500, 502, 503, 504].includes(res.status) || attempt >= 2) break;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!res.ok) throw new Error(`responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      output_text?: string;
      output?: { type?: string; id?: string; name?: string; arguments?: unknown; thoughtSignature?: string }[];
    };

    const text = (body.output_text ?? "").trim();
    if (text) reply = reply ? `${reply}\n${text}` : text;

    const calls = (body.output ?? []).filter((o) => o.type === "function_call");
    if (calls.length === 0) {
      // A no-call round with nothing said all turn is the degenerate empty
      // STOP; the production loop (geminiChat.ts) re-asks the same input a
      // couple of times, so the eval does too rather than scoring it silent.
      if (!reply && emptyRounds < 2) {
        emptyRounds++;
        continue;
      }
      break;
    }
    emptyRounds = 0;

    const assistantParts: Item[] = text ? [{ text }] : [];
    const responseParts: Item[] = [];
    for (const call of calls) {
      const name = String(call.name ?? "unknown");
      trace.push(name);
      const id = call.id ? String(call.id) : `call-${trace.length}`;
      const part: Item = {
        functionCall: {
          id,
          name,
          args: call.arguments && typeof call.arguments === "object" ? call.arguments : {},
        },
      };
      if (call.thoughtSignature) part.thoughtSignature = call.thoughtSignature;
      assistantParts.push(part);

      let response: unknown;
      const argsObj =
        call.arguments && typeof call.arguments === "object"
          ? (call.arguments as Record<string, unknown>)
          : {};
      const simulated = sim?.(name, argsObj);
      if (name === "read_skill") {
        const doc = AI_SKILLS[String(argsObj.name ?? "")];
        response = doc ? { doc } : { error: "No such skill." };
      } else if (simulated !== undefined) {
        response = simulated;
      } else if (c.stubs && name in c.stubs) {
        response = c.stubs[name];
      } else if (SAFE_TOOLS.has(name)) {
        response = serveSafeTool(name, c.state ?? EDITOR_STATE);
      } else {
        violations.push(name);
        response = { error: "eval: this tool is disabled for this turn" };
      }
      responseParts.push({
        type: "function_response",
        id,
        name,
        response:
          response && typeof response === "object" && !Array.isArray(response)
            ? response
            : { result: response ?? null },
      });
    }
    input.push({ role: "assistant", content: assistantParts });
    input.push({ role: "user", content: responseParts });
  }

  if (c.gate && intent !== c.gate) notes.push(`gate said ${intent}, expected ${c.gate}`);
  if (!c.reply.test(reply)) notes.push(`reply did not match ${c.reply}`);
  for (const t of c.requiredTools ?? []) {
    if (!trace.includes(t)) notes.push(`required tool ${t} was never called`);
  }
  if (c.anyTools && !c.anyTools.some((t) => trace.includes(t)))
    notes.push(`none of [${c.anyTools.join(", ")}] were called`);
  if (c.maxToolCalls !== undefined && trace.length > c.maxToolCalls)
    notes.push(`slow: ${trace.length} tool calls (cap ${c.maxToolCalls})`);
  if (violations.length > 0) notes.push(`mutating tools called: ${violations.join(", ")}`);
  return { pass: notes.length === 0, reply, trace, violations, notes, intent };
}

async function main() {
  const audio = makeFixtureAudio();
  const all = cases(audio).filter((c) => !ONLY || c.name === ONLY);
  if (all.length === 0) throw new Error(`No case named "${ONLY}".`);

  let failed = 0;
  for (const c of all) {
    for (let run = 1; run <= RUNS; run++) {
      const label = RUNS > 1 ? `${c.name} [${run}/${RUNS}]` : c.name;
      try {
        const r = await runCase(c);
        const tools =
          r.trace.length > 0
            ? ` tools: ${r.trace.join(" → ")}`
            : r.intent === "chat"
              ? " tools: none (gated)"
              : " tools: none";
        if (r.pass) {
          console.log(`PASS ${label}${tools}`);
        } else {
          failed++;
          console.log(`FAIL ${label}${tools}`);
          for (const n of r.notes) console.log(`     - ${n}`);
          console.log(`     reply: ${r.reply.slice(0, 200) || "(empty)"}`);
        }
      } catch (err) {
        failed++;
        console.log(`FAIL ${label} — ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  if (failed > 0) {
    console.log(`\n${failed} failure(s).`);
    process.exit(1);
  }
  console.log("\nAll cases passed.");
}

void main();
