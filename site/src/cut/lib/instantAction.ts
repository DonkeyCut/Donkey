import type { UIMessage } from "ai";
import {
  ALL_EFFECT_IDS,
  EFFECT_LABELS,
  GRADE_BASIC_FIELDS,
  GRADE_MAX,
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESET_IDS,
  GRADE_PRESETS,
  HSL_BANDS,
  MASK_SHAPES,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_ANIM_STYLE_LABELS,
  OVERLAY_LOOP_STYLE_IDS,
  OVERLAY_LOOP_STYLE_LABELS,
  STROKE_STYLES,
  STROKE_STYLE_LABELS,
  WORD_EFFECT_IDS,
  WORD_EFFECT_LABELS,
} from "@donkeycut/effects-kit";
import { CAPTION_STYLES } from "./subtitles";
import { TEXT_MOVE_IDS, TEXT_MOVE_NOTES } from "./textMotion";
import {
  ANIM_STYLE_IDS,
  ANIM_STYLE_LABELS,
  SIDE_PANEL_TABS,
  TRANSITION_STYLE_IDS,
  TRANSITION_STYLE_LABELS,
} from "./types";
import { choice, noul, score, type ChoiceAnswer, type Entry, type JudgeQuestion, type NoulAnswer, type ScoreAnswer } from "./judge";
import { judgeTurnState, type CutJudgeSettings } from "./turnJudge";

// The instant path: a turn whose whole job is one known action runs with no
// model round at all. One typed judgment — asked beside the turn's route, so
// it costs no extra wall time — picks the action out of this registry, fills
// its arguments from questions the same request carries, and the harness
// executes the tool and writes the line. A single edit lands in the time of
// one judgment instead of two model rounds.
//
// It works because the action set is closed. Every option, every enum and
// every numeric band is declared here and derived from the same exported
// constants the panels render, so a new transition style or grade preset
// joins the judgment on its own. Anything the judgment cannot settle —
// a value the ask names exactly, several targets at once, a probability
// short of its floor — resolves to nothing and the turn runs the ordinary
// loop, which is why a miss costs nothing.

// ---------------------------------------------------------------------------
// The snapshot the questions are built over.

export type TargetKind = "clip" | "audio" | "overlay" | "cue" | "transition" | "asset" | "track" | "trackTo";

const TARGET_KINDS: TargetKind[] = ["clip", "audio", "overlay", "cue", "transition", "asset", "track", "trackTo"];

export interface Candidate {
  /** The short key the judgment answers with. */
  key: string;
  /** How the option reads to the judge. */
  label: string;
  /** The item id a tool takes. */
  id: string;
  /** The short name the written line uses. */
  name: string;
  /** A track row's address, for the track-level tools. */
  track?: { kind: string; index: number };
  /** Where the item sits on the timeline, for the tools that take a window. */
  span?: { start: number; end: number };
  /** The colour bands a clip already carries, for the tools that replace a
   * band whole. */
  bands?: readonly string[];
}

export interface InstantSnapshot {
  by: Record<TargetKind, Candidate[]>;
  selection: { kind: string | null; id: string | null };
  captionTracks: number;
}

/** The most options one target question offers. A longer list dilutes every
 * candidate's share below the floor anyway, so a project past this size
 * simply takes the model round. */
const CANDIDATE_CAP = 40;

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const rows = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const at = (v: unknown): string => {
  const t = n(v);
  return t === null ? "" : ` at ${t}s`;
};
const clip = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The items each target question can name, read off the editor snapshot the
 * turn already built. Nothing here reads the user's words. */
export function instantSnapshot(context: unknown): InstantSnapshot {
  const c = rec(context);
  const sel = rec(c.selection);
  const selId = text(sel.id) || null;
  const mark = (id: string, label: string) => (id === selId ? `${label} — currently selected` : label);

  const by = Object.fromEntries(TARGET_KINDS.map((k) => [k, [] as Candidate[]])) as Record<TargetKind, Candidate[]>;
  let seq = 0;
  const add = (
    kind: TargetKind,
    id: string,
    name: string,
    label: string,
    extra?: { track?: Candidate["track"]; span?: Candidate["span"]; bands?: Candidate["bands"] },
  ) => {
    if (!id || by[kind].length >= CANDIDATE_CAP) return;
    by[kind].push({ key: `i${++seq}`, id, name, label: mark(id, label), ...extra });
  };
  const window = (start: unknown, len: unknown): Candidate["span"] | undefined => {
    const s = n(start), l = n(len);
    return s === null || l === null ? undefined : { start: s, end: s + l };
  };

  for (const v of [...rows(c.videoTrack), ...rows(c.overlayVideo)]) {
    const name = clip(text(v.name) || text(v.asset) || "clip");
    const flags = [v.muted === true ? "muted" : "", v.hidden === true ? "hidden" : ""].filter(Boolean);
    const track = n(v.track);
    add(
      "clip",
      text(v.id),
      name,
      `"${name}"${at(v.start)}, ${n(v.len) ?? 0}s long${track ? `, video track ${track}` : ""}${flags.length ? `, ${flags.join(" and ")}` : ""}`,
      {
        span: window(v.start, v.len),
        bands: Array.isArray(v.hslBands) ? v.hslBands.filter((b): b is string => typeof b === "string") : undefined,
      },
    );
  }
  for (const a of rows(c.soundtrack)) {
    const name = clip(text(a.name) || text(a.asset) || "audio");
    const lane = n(a.lane) ?? 0;
    add("audio", text(a.id), name, `"${name}"${at(a.start)} on sound row ${lane}`);
  }
  for (const o of rows(c.overlays)) {
    const name = clip(text(o.text) || text(o.name) || text(o.kind) || "element");
    const lane = n(o.lane) ?? 0;
    add("overlay", text(o.id), name, `${text(o.kind) || "element"} "${name}"${at(o.start)} on title row ${lane}`);
  }
  for (const q of rows(rec(c.subtitles).cues)) {
    const name = clip(text(q.text) || "caption");
    add("cue", text(q.id), name, `caption "${name}"${at(q.start)}`);
  }
  for (const t of rows(c.transitions)) {
    const style = text(t.style) || "transition";
    add(
      "transition",
      text(t.id),
      style,
      `${style}, ${n(t.seconds) ?? 0}s${at(t.start)}${t.parked === true ? ", parked and playing nothing" : ""}`,
    );
  }
  for (const m of rows(c.media)) {
    const name = clip(text(m.name) || "asset");
    add("asset", text(m.id), name, `${text(m.type) || "file"} "${name}", ${n(m.duration) ?? 0}s`);
  }

  // Track rows, addressed the way the track tools take them. Audio and
  // titles each sit on their own numbered row, so a project with music over
  // narration offers both and the wrong one is never picked by default.
  const lanes = (of: unknown[]) => [...new Set(of.map((r) => n(rec(r).lane) ?? 0))].sort((a, b) => a - b);
  const playing = (of: Record<string, unknown>[], lane: number, name: (r: Record<string, unknown>) => string) =>
    of.filter((r) => (n(r.lane) ?? 0) === lane).map(name).slice(0, 3).join(", ");
  const audioRows = rows(c.soundtrack);
  const titleRows = rows(c.overlays);
  const captionRows = rows(rec(c.subtitles).tracks).filter((t) => (n(t.cues) ?? 0) > 0);
  const videoTracks = new Set<number>([0, ...rows(c.overlayVideo).map((v) => n(v.track) ?? 0)]);
  const tracks: { kind: string; index: number; label: string }[] = [
    ...[...videoTracks].sort((a, b) => a - b).map((i) => ({ kind: "video", index: i, label: `video track ${i}` })),
    ...lanes(audioRows).map((i) => ({
      kind: "soundtrack",
      index: i,
      label: `sound row ${i}, carrying ${playing(audioRows, i, (r) => `"${clip(text(r.name) || text(r.asset) || "audio", 24)}"`)}`,
    })),
    ...lanes(titleRows).map((i) => ({
      kind: "text",
      index: i,
      label: `title row ${i}, carrying ${playing(titleRows, i, (r) => `"${clip(text(r.text) || text(r.name) || text(r.kind) || "element", 24)}"`)}`,
    })),
    ...captionRows.map((t, i) => ({
      kind: "subtitles",
      index: n(t.track) ?? i,
      label: `the ${text(t.locale) || "caption"} subtitle track`,
    })),
  ];
  for (const t of tracks) {
    for (const kind of ["track", "trackTo"] as const) {
      by[kind].push({ key: `${kind === "track" ? "k" : "j"}${t.kind}-${t.index}`, id: "", name: t.label, label: t.label, track: t });
    }
  }

  return {
    by,
    selection: { kind: text(sel.kind) || null, id: selId },
    // A project with no captions still reports one empty subtitle track, so
    // the count that gates the caption tools is the one holding cues.
    captionTracks: captionRows.length,
  };
}

/** The state the instant judgment reads: the turn's own state plus where the
 * playhead sits, which is what a "here" lands on. */
export function instantState(messages: UIMessage[], context: unknown): Entry {
  const base = judgeTurnState(messages, context) as Record<string, Entry>;
  const c = rec(context);
  return { ...base, playhead: n(c.playhead), playing: c.playing === true };
}

// ---------------------------------------------------------------------------
// The question families. Each is asked once and shared by every action that
// consumes it, so the question count stays flat as the registry grows.

interface EnumFamily {
  instructions: string;
  options: Record<string, string>;
  /** Any winner is an acceptable answer: a look, a style, a direction the
   * request left open. Several good options split the probability between
   * them — "slide it in" over four slide directions — so concentration is
   * the wrong thing to demand, and these clear a lower floor. An enum where
   * the wrong option is a wrong edit (in or out, fit or fill, which panel)
   * is not one of these. */
  preference?: true;
}

const labelled = (ids: readonly string[], labels: Record<string, string>, extra?: Record<string, string>) =>
  Object.fromEntries([
    ...ids.map((id) => [id, GLOSS[id] ? `${labels[id] ?? id} — ${GLOSS[id]}` : (labels[id] ?? id)]),
    ...Object.entries(extra ?? {}),
  ]) as Record<string, string>;

/** A style whose name is the direction it travels, not the edge it comes
 * from: the label alone reads backwards to anyone asking for a slide "from
 * the left". The tool descriptions say the same thing. */
const GLOSS: Record<string, string> = {
  slideleft: "travels leftward, so an entrance comes in from the right edge",
  slideright: "travels rightward, so an entrance comes in from the left edge",
  slideup: "travels upward, so an entrance comes in from the bottom edge",
  slidedown: "travels downward, so an entrance comes in from the top edge",
};

const ENUMS: Record<string, EnumFamily> = {
  transition_style: {
    instructions: "Which transition does the request ask for between the two clips?",
    options: labelled(TRANSITION_STYLE_IDS, TRANSITION_STYLE_LABELS),
    preference: true,
  },
  anim_which: {
    instructions: "Does the request shape how the clip arrives or how it leaves?",
    options: { in: "How it arrives — its entrance.", out: "How it leaves — its exit." },
  },
  anim_style: {
    instructions: "Which entrance or exit ramp does the request ask for on the clip?",
    options: labelled(ANIM_STYLE_IDS, ANIM_STYLE_LABELS, { none: "No ramp — the clip cuts straight in or out." }),
    preference: true,
  },
  grade_preset: {
    // A look's family is what the ask usually names — "cinematic", "black
    // and white" — so each option carries its category beside its name.
    instructions: "Which colour look does the request ask for?",
    options: labelled(
      GRADE_PRESET_IDS,
      Object.fromEntries(
        Object.entries(GRADE_PRESETS).map(([id, p]) => {
          const preset = p as { label?: string; category?: string };
          const family = GRADE_PRESET_CATEGORIES.find((c) => c.id === preset.category)?.label;
          return [id, family ? `${preset.label ?? id} — a ${family} look` : (preset.label ?? id)];
        }),
      ),
      { none: "Clear the look and leave the picture as shot." },
    ),
    preference: true,
  },
  grade_field: {
    instructions: "Which colour slider does the request move?",
    options: Object.fromEntries(GRADE_BASIC_FIELDS.map((f) => [f.key, f.label])),
  },
  hsl_band: {
    instructions: "Which colour band does the request single out?",
    options: Object.fromEntries(HSL_BANDS.map((b) => [b.id, b.label])),
  },
  effect: {
    instructions: "Which effect does the request ask for?",
    options: labelled(ALL_EFFECT_IDS as string[], EFFECT_LABELS as Record<string, string>),
    preference: true,
  },
  overlay_in_style: {
    instructions: "How does the request want the element to arrive?",
    options: labelled(OVERLAY_ANIM_STYLE_IDS as string[], OVERLAY_ANIM_STYLE_LABELS as Record<string, string>, {
      none: "No entrance — it is simply there.",
    }),
    preference: true,
  },
  overlay_out_style: {
    instructions: "How does the request want the element to leave?",
    options: labelled(OVERLAY_ANIM_STYLE_IDS as string[], OVERLAY_ANIM_STYLE_LABELS as Record<string, string>, {
      none: "No exit — it simply goes.",
    }),
    preference: true,
  },
  overlay_loop_style: {
    instructions: "What does the request want the element doing while it holds?",
    options: labelled(OVERLAY_LOOP_STYLE_IDS as string[], OVERLAY_LOOP_STYLE_LABELS as Record<string, string>, {
      none: "Nothing — it holds still.",
    }),
    preference: true,
  },
  text_move: {
    instructions: "Which travelling move does the request ask of the text?",
    options: labelled(TEXT_MOVE_IDS, TEXT_MOVE_NOTES),
    preference: true,
  },
  word_effect: {
    instructions: "How does the request want the words themselves played?",
    options: labelled(WORD_EFFECT_IDS as string[], WORD_EFFECT_LABELS, { none: "Plainly — the whole line at once." }),
    preference: true,
  },
  mask_kind: {
    instructions: "Which shape does the request want the picture trimmed to?",
    options: labelled(
      MASK_SHAPES.map((s) => s.id),
      Object.fromEntries(MASK_SHAPES.map((s) => [s.id, s.label])),
      { none: "Remove the mask and show the whole picture." },
    ),
    preference: true,
  },
  side_panel: {
    instructions: "Which editor panel does the request ask to see?",
    options: {
      ...Object.fromEntries(SIDE_PANEL_TABS.map((t) => [t, `The ${t} panel.`])),
      none: "Close the side panel.",
    },
  },
  aspect: {
    instructions: "Which output frame shape does the request ask for?",
    options: {
      "16:9": "Widescreen landscape — YouTube, a TV, a desktop player.",
      "9:16": "Full-height portrait — TikTok, Reels, Shorts.",
      "1:1": "A square frame.",
      "4:3": "Classic landscape, nearly square.",
      "3:4": "Classic portrait, nearly square.",
      "2:1": "A wide cinematic letterbox.",
    },
  },
  framing_mode: {
    instructions: "How should the footage sit in the frame?",
    options: {
      fit: "Whole picture visible, bars where the shapes differ.",
      fill: "Fills the frame edge to edge, cropping what hangs over.",
    },
  },
  caption_style: {
    instructions: "Which caption look does the request ask for?",
    options: Object.fromEntries(Object.entries(CAPTION_STYLES).map(([id, s]) => [id, (s as { label?: string }).label ?? id])),
    preference: true,
  },
  select_kind: {
    instructions: "What kind of thing does the request ask to be selected?",
    options: {
      clip: "A video clip on the timeline.",
      audio: "A soundtrack clip.",
      overlay: "A title, shape or sticker.",
      cue: "A caption.",
      transition: "A transition bar.",
      none: "Nothing — clear the selection.",
    },
  },
  file_to: {
    instructions: "Where does the request want the file put?",
    options: { media: "Into this project's media panel.", library: "Onto the account's library shelf." },
  },
  removal_mode: {
    instructions: "How should the cutout be made?",
    options: {
      off: "Turn the cutout off and show the whole picture again.",
      auto: "Cut the person out of the shot automatically.",
    },
  },
  removal_removes: {
    instructions: "Which part of the picture goes?",
    options: { background: "The background goes; the subject stays.", subject: "The subject goes; the background stays." },
  },
  stroke_style: {
    instructions: "What outline does the request want drawn around the cutout?",
    options: labelled(STROKE_STYLES as readonly string[], STROKE_STYLE_LABELS as Record<string, string>, {
      none: "No outline.",
    }),
    preference: true,
  },
  overlay_layout: {
    instructions: "Where in the frame should the added video sit?",
    options: {
      full: "Filling the whole frame, over what is underneath.",
      top: "Across the top half.",
      bottom: "Across the bottom half.",
      left: "Down the left half.",
      right: "Down the right half.",
      pip: "A small inset box — picture in picture.",
    },
  },
};

interface LevelFamily {
  instructions: string;
  levels: { text: string; value: number }[];
  /** Decimal places the tool's argument is rounded to. */
  places: number;
  /** What a modifier the request never states takes — "duck the music"
   * says nothing about how far, and the panel's own default is the right
   * answer. A level that IS the ask ("too loud", "slow it down") has none,
   * so an unreadable amount runs the loop rather than guessing. */
  fallback?: number;
}

const LEVELS: Record<string, LevelFamily> = {
  volume: {
    instructions: "How loud should it end up, against the level it plays at now?",
    levels: [
      { text: "Silent.", value: 0 },
      { text: "Well under what it is now — background, sitting under everything else.", value: 0.35 },
      { text: "A touch quieter.", value: 0.7 },
      { text: "Exactly as loud as it is now.", value: 1 },
      { text: "A touch louder.", value: 1.4 },
      { text: "Well over what it is now — clearly the loudest thing in the mix.", value: 2 },
    ],
    places: 2,
  },
  speed: {
    instructions: "How fast should the footage play, against its own recorded speed?",
    levels: [
      { text: "Deep slow motion — a quarter of real time.", value: 0.25 },
      { text: "Half speed.", value: 0.5 },
      { text: "Its own recorded speed.", value: 1 },
      { text: "Half again as fast.", value: 1.5 },
      { text: "Twice as fast.", value: 2 },
      { text: "A hard time-lapse — four times as fast.", value: 4 },
    ],
    places: 2,
  },
  seconds_short: {
    instructions: "How long should the move take?",
    levels: [
      { text: "A snap — barely there.", value: 0.1 },
      { text: "Quick.", value: 0.25 },
      { text: "An ordinary beat.", value: 0.5 },
      { text: "Slow and deliberate.", value: 1 },
      { text: "A long, drawn-out sweep.", value: 2 },
    ],
    places: 2,
    fallback: 0.5,
  },
  amount: {
    instructions: "How strong should the treatment be?",
    levels: [
      { text: "Barely perceptible.", value: 0.1 },
      { text: "Subtle.", value: 0.3 },
      { text: "Plainly visible.", value: 0.5 },
      { text: "Strong.", value: 0.75 },
      { text: "As far as it goes.", value: 1 },
    ],
    places: 2,
    fallback: 0.5,
  },
  zoom: {
    instructions: "How far into the picture should the frame push?",
    levels: [
      { text: "Not at all — the whole picture.", value: 1 },
      { text: "A slight push.", value: 1.25 },
      { text: "Half again as close.", value: 1.5 },
      { text: "Twice as close.", value: 2 },
      { text: "Right in — three times as close.", value: 3 },
    ],
    places: 2,
  },
  fade: {
    instructions: "How long should the sound take to come up and go away?",
    levels: [
      { text: "No fade — it starts and stops flat.", value: 0 },
      { text: "A short lift.", value: 0.5 },
      { text: "A second.", value: 1 },
      { text: "A slow swell.", value: 2 },
      { text: "A long, cinematic fade.", value: 4 },
    ],
    places: 2,
    fallback: 1,
  },
  duck: {
    instructions: "How far should this track drop under the speech on top of it?",
    levels: [
      { text: "Not at all — it holds its level through the talking.", value: 0 },
      { text: "A little — still clearly present under the voice.", value: 0.25 },
      { text: "Half out of the way.", value: 0.5 },
      { text: "Almost out — barely audible while anyone speaks.", value: 0.8 },
    ],
    places: 2,
    fallback: 0.5,
  },
  loop_speed: {
    instructions: "How quickly should the element's held motion cycle?",
    levels: [
      { text: "A slow drift.", value: 0.25 },
      { text: "Half pace.", value: 0.5 },
      { text: "Its natural pace.", value: 1 },
      { text: "Twice as quick.", value: 2 },
      { text: "Frantic.", value: 4 },
    ],
    places: 2,
    fallback: 1,
  },
  move_strength: {
    instructions: "How far should the move carry the text?",
    levels: [
      { text: "A quarter of the shape it is written at — hardly moving.", value: 0.25 },
      { text: "Restrained.", value: 0.5 },
      { text: "The move as written.", value: 1 },
      { text: "Exaggerated.", value: 1.5 },
      { text: "Twice the written shape — as far as it goes.", value: 2 },
    ],
    places: 2,
    fallback: 1,
  },
  grade_amount: {
    instructions: "Which way and how far should that colour slider move from where it sits now?",
    levels: [
      { text: "All the way down.", value: -GRADE_MAX },
      { text: "Down a clear step.", value: -GRADE_MAX / 2 },
      { text: "Not at all — leave it.", value: 0 },
      { text: "Up a clear step.", value: GRADE_MAX / 2 },
      { text: "All the way up.", value: GRADE_MAX },
    ],
    places: 0,
  },
  hsl_sat: {
    instructions: "Which way and how far should that colour band's intensity move?",
    levels: [
      { text: "Drained to grey.", value: -GRADE_MAX },
      { text: "Muted.", value: -GRADE_MAX / 2 },
      { text: "Left as it is.", value: 0 },
      { text: "Richer.", value: GRADE_MAX / 2 },
      { text: "As saturated as it goes.", value: GRADE_MAX },
    ],
    places: 0,
  },
};

interface BoolFamily {
  instructions: string;
  yes: string;
  no: string;
  /** A modifier rather than the point of the action: an undecided answer
   * takes this instead of running the loop. A direction the action turns
   * on — mute or unmute, hide or show — has none, so a coin flip falls
   * through rather than guessing wrong half the time. */
  fallback?: boolean;
}

const BOOLS: Record<string, BoolFamily> = {
  mute: {
    instructions: "Does the request want the sound silenced, rather than brought back?",
    yes: "Silence it — mute, kill the audio, drop the sound.",
    no: "Bring the sound back — unmute, restore the audio.",
  },
  hide: {
    instructions: "Does the request want the item taken out of the video, rather than brought back into it?",
    yes: "Out: hidden, switched off, silenced, not playing — still on the timeline, just not in the video.",
    no: "Back in: shown again, switched on, playing again.",
  },
  play: {
    instructions: "Does the request want playback running, rather than stopped?",
    yes: "Start playing.",
    no: "Stop, pause, or hold.",
  },
  reverse: {
    instructions: "Does the request want the footage running backwards, rather than forwards again?",
    yes: "Play it backwards.",
    no: "Put it back the right way round.",
  },
  flip: {
    instructions: "Does the request want the picture mirrored left-to-right, rather than un-mirrored?",
    yes: "Mirror it.",
    no: "Undo a mirror and show it the right way round.",
  },
  captions_visible: {
    instructions: "Does the request want the captions showing on the video, rather than hidden?",
    yes: "Show them burned over the picture.",
    no: "Take them off the picture.",
  },
  additive: {
    instructions: "Does the request add this item to what is already selected, rather than replacing the selection?",
    yes: "Add it to the current selection.",
    no: "Select only this one.",
    fallback: false,
  },
  smooth: {
    instructions: "Does the request ask for the slow motion to be smoothed, with the in-between frames synthesized?",
    yes: "Smooth it — buttery, no stepping.",
    no: "Nothing about smoothness.",
    fallback: false,
  },
};

// The three guards. All are judgments; none reads the user's words.
const GUARDS = {
  exact_value: noul(
    "Does the request name a specific number, time, duration or measured value the edit must hit exactly?",
    {
      true: 'A figure the result has to match — "trim to 4.2 seconds", "set it to 80%", "exactly two seconds", "at 01:13".',
      false: "The request describes the result in words — louder, slower, subtler, a quick fade — with no figure to hit.",
    },
  ),
  remake: noul(
    "Is the person unhappy with the SHOT ITSELF — what it shows, how it was captured — and asking for a different or better one, rather than asking for the shot that is there to be used or adjusted?",
    {
      true:
        'They want another shot, and the footage they are picturing does not exist yet: "this feels off, make me a better version", "another take", "a different one, more golden-hour", "redo this".',
      false:
        "The footage they have is the footage they want. The request selects it, moves it, plays it, files it, or presents it differently — a look, a grade, a crop, a speed, a volume, a title. The same frames stay on the timeline.",
    },
  ),
  leftover: noul(
    "If the editor carried out the FIRST thing `request` asks for and then stopped, would the person still be waiting on something else they asked for in the same message?",
    {
      true:
        'Yes, something they asked for would be left undone: "get rid of the crossfade — make it pop in instead" still owes the pop; "trim the clip and add a title" still owes the title.',
      false:
        "No, they would be satisfied. The message asks for one thing, and the rest of it says which item, how much, or what the result should look like. A single setting that has two ends is one thing, not two: fading a sound in AND out is one fade setting; trimming both ends of a clip is one trim; flipping a clip both ways is one framing.",
    },
  ),
  multi_target: noul(
    "Carrying out `request` — would it mean making the same edit over and over, once for each of several items?",
    {
      true: 'The same change lands on item after item, so it takes a run of separate edits: "all the titles", "every clip", "the short ones", "each caption", "the grey ones".',
      false:
        "One edit does it: a single item, the thing already selected, a whole track or the whole project changed by one setting, or nothing on the timeline at all. A request that mentions several items only to say WHERE the one edit goes — between these two clips, after that one — is still one edit.",
    },
  ),
} as const;

// ---------------------------------------------------------------------------
// The registry.

/** The answers an action's builder reads, already cleared against the floors. */
export interface Picks {
  target: (kind: TargetKind) => Candidate;
  /** A target the action can use but does not require. */
  maybe: (kind: TargetKind) => Candidate | undefined;
  enumOf: (name: string) => string;
  level: (name: string) => number;
  bool: (name: string) => boolean;
}

interface ActionDef {
  tool: string;
  /** How the option reads in the action question. */
  blurb: string;
  needs?: readonly TargetKind[];
  /** Targets the action uses when the judgment names one, and does without
   * when it does not — an effect over one clip, or over the whole cut. */
  optional?: readonly TargetKind[];
  /** The action sets both ends of a two-sided setting in one call, so an
   * ask that names both ends leaves nothing undone. */
  twoSided?: true;
  enums?: readonly string[];
  levels?: readonly string[];
  bools?: readonly string[];
  /** An extra condition on the project beyond its targets existing. */
  when?: (s: InstantSnapshot) => boolean;
  build: (p: Picks) => { args: Record<string, unknown>; say: string };
}

const selected = (s: InstantSnapshot) => s.selection.id !== null;

export const INSTANT_ACTIONS: Record<string, ActionDef> = {
  // --- no target -----------------------------------------------------------
  undo: {
    tool: "undo",
    blurb: "Undo: take back the edit that was just made, stepping the project back one step.",
    build: () => ({ args: {}, say: "Undone." }),
  },
  redo: {
    tool: "redo",
    blurb: "Redo: put back an edit that was undone, stepping the project forward again. Only for a request that reverses an undo.",
    build: () => ({ args: {}, say: "Redone." }),
  },
  copy_selection: {
    tool: "copy_selection",
    blurb: "Copy what is selected to the clipboard.",
    when: selected,
    build: () => ({ args: {}, say: "Copied." }),
  },
  paste_selection: {
    tool: "paste_selection",
    blurb: "Paste what was copied, at the playhead.",
    build: () => ({ args: {}, say: "Pasted at the playhead." }),
  },
  group_items: {
    tool: "group_items",
    blurb: "Group the selected items so they move together.",
    when: selected,
    build: () => ({ args: {}, say: "Grouped — they move together now." }),
  },
  ungroup_items: {
    tool: "ungroup_items",
    blurb: "Break the selected group apart so its items move on their own.",
    when: selected,
    build: () => ({ args: {}, say: "Ungrouped." }),
  },
  split_at: {
    tool: "split_at",
    blurb: "Cut the clip in two at the playhead, where it is parked right now.",
    build: () => ({ args: {}, say: "Split at the playhead." }),
  },
  detach_audio: {
    tool: "detach_audio",
    blurb: "Lift the selected clip's sound off onto the soundtrack, where it can be edited on its own.",
    when: selected,
    build: () => ({ args: {}, say: "Audio detached onto the soundtrack." }),
  },
  set_playing: {
    tool: "set_playing",
    blurb: "Start or stop playback in the preview.",
    bools: ["play"],
    build: (p) => ({ args: { playing: p.bool("play") }, say: p.bool("play") ? "Playing." : "Paused." }),
  },
  open_export: {
    tool: "open_export",
    blurb: "Open the export dialog so the video can be rendered out.",
    build: () => ({ args: {}, say: "Export is open." }),
  },
  set_side_panel: {
    tool: "set_side_panel",
    blurb: "Show a particular editor panel, or close the side panel.",
    enums: ["side_panel"],
    build: (p) => {
      const panel = p.enumOf("side_panel");
      return { args: { panel }, say: panel === "none" ? "Closed the side panel." : `Opened the ${panel} panel.` };
    },
  },
  set_aspect: {
    tool: "set_aspect",
    blurb: "Change the project's output frame shape — vertical, square, widescreen.",
    enums: ["aspect"],
    build: (p) => ({ args: { aspect: p.enumOf("aspect") }, say: `Frame is ${p.enumOf("aspect")} now.` }),
  },
  subtitles_set_view: {
    tool: "subtitles_set_view",
    blurb: "Whether the captions are drawn over the picture. Turning them off leaves every caption exactly where it is on its track and only stops them showing on the video. This is the answer whenever the request is about seeing them or not seeing them.",
    bools: ["captions_visible"],
    when: (s) => s.captionTracks > 0,
    build: (p) => ({
      args: { showOnVideo: p.bool("captions_visible") },
      say: p.bool("captions_visible") ? "Captions are on the video." : "Captions are off the video.",
    }),
  },
  select_none: {
    tool: "select",
    blurb: "Clear the selection — deselect everything.",
    when: selected,
    build: () => ({ args: { kind: "none" }, say: "Selection cleared." }),
  },
  add_effect: {
    tool: "add_effect",
    blurb: "Lay an effect over one clip or the whole cut — grain, a glow, a shake, a filter.",
    optional: ["clip"],
    enums: ["effect"],
    levels: ["amount"],
    build: (p) => {
      const on = p.maybe("clip");
      const label = EFFECT_LABELS[p.enumOf("effect") as keyof typeof EFFECT_LABELS] ?? p.enumOf("effect");
      return {
        args: {
          effect: p.enumOf("effect"),
          amount: p.level("amount"),
          ...(on?.span ? { start: on.span.start, end: on.span.end } : {}),
        },
        say: on ? `Added ${label} over "${on.name}".` : `Added ${label} over the cut.`,
      };
    },
  },
  set_caption_look: {
    tool: "set_caption_look",
    blurb: "Restyle the captions with one of the built-in caption looks.",
    enums: ["caption_style"],
    when: (s) => s.captionTracks > 0,
    build: (p) => ({ args: { style: p.enumOf("caption_style") }, say: `Captions are wearing the ${p.enumOf("caption_style")} look.` }),
  },

  // --- select and delete ---------------------------------------------------
  ...selectAndDelete("clip", "a video clip"),
  ...selectAndDelete("audio", "a soundtrack clip"),
  ...selectAndDelete("overlay", "a title, shape or sticker"),
  ...selectAndDelete("transition", "a transition bar"),
  select_cue: {
    tool: "select",
    blurb: "Select a caption.",
    needs: ["cue"],
    bools: ["additive"],
    build: (p) => ({
      args: { kind: "cue", id: p.target("cue").id, additive: p.bool("additive") },
      say: `Selected "${p.target("cue").name}".`,
    }),
  },
  delete_cue: {
    tool: "delete_cue",
    blurb: "Delete a caption.",
    needs: ["cue"],
    build: (p) => ({ args: { id: p.target("cue").id }, say: `Deleted the caption "${p.target("cue").name}".` }),
  },
  merge_cue: {
    tool: "merge_cue",
    blurb: "Join a caption into the one before it, so the two lines read as one.",
    needs: ["cue"],
    build: (p) => ({ args: { id: p.target("cue").id }, say: `Merged "${p.target("cue").name}" into the line before it.` }),
  },

  // --- per-item toggles ----------------------------------------------------
  set_clip_muted: {
    tool: "set_clip_muted",
    blurb: "Silence one clip's sound, or bring it back.",
    needs: ["clip"],
    bools: ["mute"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, muted: p.bool("mute") },
      say: `${p.bool("mute") ? "Muted" : "Unmuted"} "${p.target("clip").name}".`,
    }),
  },
  set_clip_hidden: {
    tool: "set_clip_hidden",
    blurb: "Take one clip out of the picture without deleting it, or bring it back.",
    needs: ["clip"],
    bools: ["hide"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, hidden: p.bool("hide") },
      say: `${p.bool("hide") ? "Hid" : "Showing"} "${p.target("clip").name}".`,
    }),
  },
  set_track_muted: {
    tool: "set_track_muted",
    blurb: "Silence every clip on one VIDEO track at once, or bring the sound back. The picture keeps playing.",
    needs: ["track"],
    bools: ["mute"],
    when: (s) => s.by.track.some((t) => t.track?.kind === "video"),
    build: (p) => {
      const t = p.target("track");
      return t.track?.kind === "video"
        ? { args: { track: t.track.index, muted: p.bool("mute") }, say: `${p.bool("mute") ? "Muted" : "Unmuted"} ${t.name}.` }
        : { args: {}, say: "" };
    },
  },
  set_track_hidden: {
    tool: "set_track_hidden",
    blurb: "Take a whole track out of the video — every clip, title, caption or piece of music on it stops playing — or bring it back. This is how a whole soundtrack row is silenced.",
    needs: ["track"],
    bools: ["hide"],
    build: (p) => {
      const t = p.target("track");
      return {
        args: { kind: t.track?.kind ?? "video", track: t.track?.index ?? 0, hidden: p.bool("hide") },
        say: `${p.bool("hide") ? "Hid" : "Showing"} ${t.name}.`,
      };
    },
  },
  remove_transition: {
    tool: "remove_transition",
    blurb: "Take a transition bar off the timeline so the two clips cut straight together.",
    needs: ["transition"],
    build: (p) => ({ args: { transitionId: p.target("transition").id }, say: `Removed the ${p.target("transition").name}.` }),
  },
  set_transition_hidden: {
    tool: "set_transition_hidden",
    blurb: "Switch a transition bar off without removing it, or switch it back on.",
    needs: ["transition"],
    bools: ["hide"],
    build: (p) => ({
      args: { transitionId: p.target("transition").id, hidden: p.bool("hide") },
      say: `${p.bool("hide") ? "Switched off" : "Switched on"} the ${p.target("transition").name}.`,
    }),
  },
  subtitles_remove_track: {
    tool: "subtitles_remove_track",
    blurb: "Throw a whole subtitle track away, captions and all — those words leave the project. Never for a request about whether the captions show; that one is only about drawing them on the picture.",
    needs: ["track"],
    when: (s) => s.captionTracks > 0,
    build: (p) => {
      const t = p.target("track");
      return t.track?.kind === "subtitles"
        ? { args: { track: t.track.index }, say: `Removed ${t.name}.` }
        : { args: {}, say: "" };
    },
  },
  reorder_track: {
    tool: "reorder_track",
    blurb: "Move a whole track up or down the stack, changing what sits in front of what.",
    needs: ["track", "trackTo"],
    build: (p) => {
      const from = p.target("track");
      const to = p.target("trackTo");
      // The tool stacks video, sound and title rows; subtitle tracks have no
      // stacking order, so an ask about them takes the model.
      const stackable = new Set(["video", "soundtrack", "text"]);
      return from.track &&
        to.track &&
        stackable.has(from.track.kind) &&
        from.track.kind === to.track.kind &&
        from.track.index !== to.track.index
        ? {
            args: { kind: from.track.kind, from: from.track.index, to: to.track.index },
            say: `Moved ${from.name} to position ${to.track.index}.`,
          }
        : { args: {}, say: "" };
    },
  },

  // --- assets --------------------------------------------------------------
  file_asset: {
    tool: "file_asset",
    blurb: "File a piece of media — move it into the project's media panel or onto the library shelf.",
    needs: ["asset"],
    enums: ["file_to"],
    build: (p) => ({
      args: { asset_id: p.target("asset").id, to: p.enumOf("file_to") },
      say: `Filed "${p.target("asset").name}" ${p.enumOf("file_to") === "media" ? "into the media panel" : "onto the library shelf"}.`,
    }),
  },
  add_clip: {
    tool: "add_clip",
    blurb: "Put one piece of media on the timeline, the way dragging it in would.",
    needs: ["asset"],
    build: (p) => ({ args: { asset_id: p.target("asset").id }, say: `Added "${p.target("asset").name}" to the timeline.` }),
  },
  add_overlay_video: {
    tool: "add_overlay_video",
    blurb: "Put a video or image on a layer above the main track — a split screen or a picture-in-picture inset.",
    needs: ["asset"],
    enums: ["overlay_layout"],
    build: (p) => ({
      args: { asset_id: p.target("asset").id, layout: p.enumOf("overlay_layout") },
      say: `Laid "${p.target("asset").name}" over the cut.`,
    }),
  },

  // --- clip treatment ------------------------------------------------------
  set_transition: {
    tool: "set_transition",
    blurb: "Put a transition on the cut at the end of one clip — a crossfade, a wipe, a dip to black.",
    needs: ["clip"],
    enums: ["transition_style"],
    levels: ["seconds_short"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, style: p.enumOf("transition_style"), seconds: p.level("seconds_short") },
      say: `Put a ${p.level("seconds_short")}s ${TRANSITION_STYLE_LABELS[p.enumOf("transition_style") as keyof typeof TRANSITION_STYLE_LABELS]?.toLowerCase() ?? p.enumOf("transition_style")} after "${p.target("clip").name}".`,
    }),
  },
  set_animation: {
    tool: "set_animation",
    blurb: "Give one VIDEO CLIP an entrance or an exit ramp — a fade up, a slide in, a push out. Not for a title, shape or sticker.",
    needs: ["clip"],
    enums: ["anim_which", "anim_style"],
    levels: ["seconds_short"],
    build: (p) => ({
      args: {
        clipId: p.target("clip").id,
        which: p.enumOf("anim_which"),
        style: p.enumOf("anim_style"),
        seconds: p.level("seconds_short"),
      },
      say: `"${p.target("clip").name}" ${p.enumOf("anim_which") === "in" ? "arrives" : "leaves"} on a ${p.level("seconds_short")}s ${p.enumOf("anim_style")}.`,
    }),
  },
  set_color_preset: {
    tool: "set_color_preset",
    blurb: "Put a colour look on one clip — cinematic, warm, black and white.",
    needs: ["clip"],
    enums: ["grade_preset"],
    levels: ["amount"],
    build: (p) => {
      const preset = p.enumOf("grade_preset");
      return {
        args: { clipId: p.target("clip").id, preset, ...(preset === "none" ? {} : { amount: p.level("amount") }) },
        say:
          preset === "none"
            ? `Cleared the look on "${p.target("clip").name}".`
            : `"${p.target("clip").name}" is wearing ${(GRADE_PRESETS[preset] as { label?: string } | undefined)?.label ?? preset}.`,
      };
    },
  },
  set_color_grade: {
    tool: "set_color_grade",
    blurb: "Move one of a clip's colour sliders — exposure, contrast, warmth, saturation.",
    needs: ["clip"],
    enums: ["grade_field"],
    levels: ["grade_amount"],
    build: (p) => {
      const field = p.enumOf("grade_field");
      const value = p.level("grade_amount");
      const label = GRADE_BASIC_FIELDS.find((f) => f.key === field)?.label ?? field;
      return {
        args: { clipId: p.target("clip").id, [field]: value },
        say: `${label} ${value >= 0 ? "up" : "down"} on "${p.target("clip").name}".`,
      };
    },
  },
  set_color_hsl: {
    tool: "set_color_hsl",
    blurb: "Change one colour band in a clip and leave the rest alone — the sky bluer, the greens muted.",
    needs: ["clip"],
    enums: ["hsl_band"],
    levels: ["hsl_sat"],
    build: (p) => {
      const on = p.target("clip");
      const band = p.enumOf("hsl_band");
      // The tool writes a band's hue, saturation and luminance together, and
      // the snapshot carries the band names without their values — so a band
      // already set is the model's to change, with the current numbers read.
      if (on.bands?.includes(band)) return { args: {}, say: "" };
      return {
        args: { clipId: on.id, band, sat: p.level("hsl_sat") },
        say: `${p.level("hsl_sat") >= 0 ? "Lifted" : "Pulled back"} the ${band}s in "${on.name}".`,
      };
    },
  },
  set_framing: {
    tool: "set_framing",
    blurb: "Change how a clip sits in the frame — fit the whole picture, or fill the frame and crop.",
    needs: ["clip"],
    enums: ["framing_mode"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, mode: p.enumOf("framing_mode") },
      say: `"${p.target("clip").name}" ${p.enumOf("framing_mode") === "fill" ? "fills the frame" : "fits in the frame"} now.`,
    }),
  },
  set_zoom: {
    tool: "set_framing",
    blurb: "Push into a clip's picture or pull back out — a punch-in on the shot.",
    needs: ["clip"],
    levels: ["zoom"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, zoom: p.level("zoom") },
      say: `"${p.target("clip").name}" is at ${p.level("zoom")}× now.`,
    }),
  },
  flip_clip: {
    tool: "set_framing",
    blurb: "Mirror a clip left-to-right, or turn the mirror off.",
    needs: ["clip"],
    bools: ["flip"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, flipH: p.bool("flip") },
      say: `${p.bool("flip") ? "Mirrored" : "Un-mirrored"} "${p.target("clip").name}".`,
    }),
  },
  set_speed: {
    tool: "set_speed",
    blurb: "Change how fast a clip plays — slow motion, a speed-up, a time-lapse. ONE rate across the whole clip: a rate that changes through the footage, easing in or out of slow motion, is not this.",
    needs: ["clip"],
    levels: ["speed"],
    bools: ["smooth"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, speed: p.level("speed"), ...(p.bool("smooth") ? { smooth: true } : {}) },
      say: `"${p.target("clip").name}" plays at ${p.level("speed")}× now.`,
    }),
  },
  reverse_clip: {
    tool: "set_speed",
    blurb: "Play a clip backwards, or put it the right way round again.",
    needs: ["clip"],
    bools: ["reverse"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, reverse: p.bool("reverse") },
      say: `"${p.target("clip").name}" runs ${p.bool("reverse") ? "backwards" : "forwards"} now.`,
    }),
  },
  set_clip_volume: {
    tool: "set_clip_volume",
    blurb: "Change how loud one video clip's own sound is.",
    needs: ["clip"],
    levels: ["volume"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, volume: p.level("volume") },
      say: `"${p.target("clip").name}" is at ${Math.round(p.level("volume") * 100)}% volume.`,
    }),
  },
  set_removal: {
    tool: "set_removal",
    blurb: "Cut the subject out of a clip's shot, or turn the cutout off.",
    needs: ["clip"],
    enums: ["removal_mode", "removal_removes"],
    build: (p) => {
      const mode = p.enumOf("removal_mode");
      return {
        args: { clipId: p.target("clip").id, mode, ...(mode === "off" ? {} : { remove: p.enumOf("removal_removes") }) },
        say:
          mode === "off"
            ? `Cutout off on "${p.target("clip").name}".`
            : `Cutting the ${p.enumOf("removal_removes")} out of "${p.target("clip").name}".`,
      };
    },
  },
  set_removal_stroke: {
    tool: "set_removal_stroke",
    blurb: "Draw an outline around a clip's cutout — a glow, a hand-drawn line, a sticker edge.",
    needs: ["clip"],
    enums: ["stroke_style"],
    build: (p) => ({
      args: { clipId: p.target("clip").id, style: p.enumOf("stroke_style") },
      say:
        p.enumOf("stroke_style") === "none"
          ? `Took the outline off "${p.target("clip").name}".`
          : `Drew a ${p.enumOf("stroke_style")} outline on "${p.target("clip").name}".`,
    }),
  },
  set_mask: {
    tool: "set_mask",
    blurb: "Trim an element's picture to a shape — a circle, a heart, the person in the shot.",
    needs: ["overlay"],
    enums: ["mask_kind"],
    build: (p) => ({
      args: { id: p.target("overlay").id, kind: p.enumOf("mask_kind") },
      say:
        p.enumOf("mask_kind") === "none"
          ? `Took the mask off "${p.target("overlay").name}".`
          : `Masked "${p.target("overlay").name}" to a ${p.enumOf("mask_kind")}.`,
    }),
  },

  // --- soundtrack ----------------------------------------------------------
  set_audio_volume: {
    tool: "update_audio",
    blurb: "Change how loud one soundtrack clip is.",
    needs: ["audio"],
    levels: ["volume"],
    build: (p) => ({
      args: { id: p.target("audio").id, volume: p.level("volume") },
      say: `"${p.target("audio").name}" is at ${Math.round(p.level("volume") * 100)}% volume.`,
    }),
  },
  set_audio_fade: {
    tool: "update_audio",
    blurb: "Fade a soundtrack clip in and out instead of starting and stopping flat.",
    needs: ["audio"],
    twoSided: true,
    levels: ["fade"],
    build: (p) => ({
      args: { id: p.target("audio").id, fadeIn: p.level("fade"), fadeOut: p.level("fade") },
      say: `"${p.target("audio").name}" fades in and out over ${p.level("fade")}s.`,
    }),
  },
  set_audio_duck: {
    tool: "update_audio",
    blurb: "Have a soundtrack clip drop under the speech on top of it.",
    needs: ["audio"],
    levels: ["duck"],
    build: (p) => ({
      args: { id: p.target("audio").id, duck: p.level("duck") },
      say:
        p.level("duck") === 0
          ? `"${p.target("audio").name}" holds its level through the speech.`
          : `"${p.target("audio").name}" ducks under the speech.`,
    }),
  },

  // --- overlay motion ------------------------------------------------------
  set_overlay_in: {
    tool: "set_overlay_animation",
    blurb: "Change how a TITLE, SHAPE OR STICKER arrives on screen — how the element itself comes in.",
    needs: ["overlay"],
    enums: ["overlay_in_style"],
    levels: ["seconds_short"],
    build: (p) => ({
      args: { id: p.target("overlay").id, in_style: p.enumOf("overlay_in_style"), in_seconds: p.level("seconds_short") },
      say: `"${p.target("overlay").name}" arrives on a ${p.level("seconds_short")}s ${p.enumOf("overlay_in_style")}.`,
    }),
  },
  set_overlay_out: {
    tool: "set_overlay_animation",
    blurb: "Change how a TITLE, SHAPE OR STICKER leaves the screen — how the element itself goes out.",
    needs: ["overlay"],
    enums: ["overlay_out_style"],
    levels: ["seconds_short"],
    build: (p) => ({
      args: { id: p.target("overlay").id, out_style: p.enumOf("overlay_out_style"), out_seconds: p.level("seconds_short") },
      say: `"${p.target("overlay").name}" leaves on a ${p.level("seconds_short")}s ${p.enumOf("overlay_out_style")}.`,
    }),
  },
  set_overlay_loop: {
    tool: "set_overlay_animation",
    blurb: "Give an element a motion it keeps doing while it holds — a pulse, a wobble, a float.",
    needs: ["overlay"],
    enums: ["overlay_loop_style"],
    levels: ["loop_speed"],
    build: (p) => ({
      args: { id: p.target("overlay").id, loop_style: p.enumOf("overlay_loop_style"), loop_speed: p.level("loop_speed") },
      say:
        p.enumOf("overlay_loop_style") === "none"
          ? `"${p.target("overlay").name}" holds still now.`
          : `"${p.target("overlay").name}" ${p.enumOf("overlay_loop_style")}s while it holds.`,
    }),
  },
  set_overlay_move: {
    tool: "set_overlay_animation",
    blurb: "Give text a travelling move while it holds — a slow push, a drift across the frame.",
    needs: ["overlay"],
    enums: ["text_move"],
    levels: ["move_strength"],
    build: (p) => ({
      args: { id: p.target("overlay").id, move: p.enumOf("text_move"), move_strength: p.level("move_strength") },
      say:
        p.enumOf("text_move") === "none"
          ? `"${p.target("overlay").name}" holds its pose now.`
          : `"${p.target("overlay").name}" moves on ${p.enumOf("text_move")}.`,
    }),
  },
  set_overlay_words: {
    tool: "set_overlay_animation",
    blurb: "Play a text element word by word as it is spoken, instead of the whole line at once.",
    needs: ["overlay"],
    enums: ["word_effect"],
    build: (p) => ({
      args: { id: p.target("overlay").id, words_style: p.enumOf("word_effect") },
      say:
        p.enumOf("word_effect") === "none"
          ? `"${p.target("overlay").name}" plays as one line now.`
          : `"${p.target("overlay").name}" plays word by word.`,
    }),
  },
};

/** The select/delete pair for one item kind — the same two actions over every
 * kind the timeline holds, so neither is written five times. */
function selectAndDelete(kind: "clip" | "audio" | "overlay" | "transition", what: string): Record<string, ActionDef> {
  return {
    [`select_${kind}`]: {
      tool: "select",
      blurb: `Select ${what}.`,
      needs: [kind],
      bools: ["additive"],
      build: (p) => ({
        args: { kind, id: p.target(kind).id, additive: p.bool("additive") },
        say: `Selected "${p.target(kind).name}".`,
      }),
    },
    [`delete_${kind}`]: {
      tool: "delete_item",
      blurb: `Delete ${what} from the timeline.`,
      needs: [kind],
      build: (p) => ({ args: { kind, id: p.target(kind).id }, say: `Deleted "${p.target(kind).name}".` }),
    },
  };
}

// ---------------------------------------------------------------------------
// Questions, asked all at once.

/** Which actions this project can carry: every target kind the action needs
 * has something to name, and its own condition holds. */
export function availableActions(snap: InstantSnapshot): string[] {
  return Object.entries(INSTANT_ACTIONS)
    .filter(([, def]) => (def.needs ?? []).every((k) => snap.by[k].length > 0) && (def.when?.(snap) ?? true))
    .map(([id]) => id);
}

/** Every question the instant path asks, in one request: the action, the
 * targets each kind could name, the enums and bands the available actions
 * consume, and the two guards. Speculative by design — code reads only the
 * answers the chosen action needs. */
export function instantQuestions(snap: InstantSnapshot): Record<string, JudgeQuestion> {
  const ids = availableActions(snap);
  if (ids.length === 0) return {};
  const defs = ids.map((id) => INSTANT_ACTIONS[id]);
  const used = (pick: (d: ActionDef) => readonly string[] | undefined) =>
    [...new Set(defs.flatMap((d) => pick(d) ?? []))];

  const questions: Record<string, JudgeQuestion> = {
    action: choice(
      "The newest user message, `request`, is aimed at a video editor. Which one of these editor actions carries it out exactly, with nothing else needed?",
      Object.fromEntries([
        ...ids.map((id) => [id, INSTANT_ACTIONS[id].blurb]),
        [
          "none",
          "No single action here does it: the request needs several steps, asks a question, or asks for something this list does not cover.",
        ],
        [
          "remake_it",
          "The person wants the shot itself made again: a new or better take, a different version of what it shows. Nothing on the timeline can be adjusted into it — new footage has to be rendered first.",
        ],
        [
          "make_new",
          "The person wants material the project does not have yet: music, a spoken line, captions, a transcript, a shot of something new, a search, or a measurement someone has to take.",
        ],
      ]) as Record<string, Entry>,
    ),
    ...GUARDS,
  };

  for (const kind of TARGET_KINDS) {
    const items = snap.by[kind];
    if (items.length === 0 || !defs.some((d) => [...(d.needs ?? []), ...(d.optional ?? [])].includes(kind))) continue;
    questions[`target::${kind}`] = choice(TARGET_PROMPTS[kind], {
      ...Object.fromEntries(items.map((c) => [c.key, c.label])),
      none: NO_TARGET[kind],
    });
  }
  for (const name of used((d) => d.enums)) {
    const fam = ENUMS[name];
    questions[`enum::${name}`] = choice(fam.instructions, fam.options as Record<string, Entry>);
  }
  for (const name of used((d) => d.levels)) {
    const fam = LEVELS[name];
    questions[`level::${name}`] = score(fam.instructions, fam.levels.map((l) => l.text) as unknown as [Entry, Entry, ...Entry[]]);
  }
  for (const name of used((d) => d.bools)) {
    const fam = BOOLS[name];
    questions[`bool::${name}`] = noul(fam.instructions, { true: fam.yes, false: fam.no });
  }
  return questions;
}

// People point at things however they like — by file, by what the shot
// shows, by where it sits, by "this" or "the music" or "the first one" —
// and the editor's own selection is what "this" means when nothing else
// says. The question has to accept all of that, or an ask that never spells
// out a file name reads as naming nothing.
const aimedAt = (what: string) =>
  `Which ${what} is \`request\` about? It counts however the request refers to it: by its file, by what it shows or says, by where it sits — a request about a cut, a gap or a join points at the item just before it — by "this one", or by being the item already selected.`;

const TARGET_PROMPTS: Record<TargetKind, string> = {
  clip: aimedAt("video clip"),
  audio: aimedAt("soundtrack clip"),
  overlay: aimedAt("title, shape or sticker"),
  cue: aimedAt("caption"),
  transition: aimedAt("transition"),
  asset: aimedAt("piece of media"),
  track: aimedAt("whole track"),
  trackTo: "Which position in the stack should that track end up at?",
};

const noneOf = (what: string) =>
  `\`request\` is about no ${what} at all — it asks about something else, or it acts on the project as a whole. Only for a request that has nothing to do with these.`;

const NO_TARGET: Record<TargetKind, string> = {
  clip: noneOf("video clip"),
  audio: noneOf("soundtrack clip"),
  overlay: noneOf("title, shape or sticker"),
  cue: noneOf("caption"),
  transition: noneOf("transition"),
  asset: noneOf("piece of media"),
  track: noneOf("track"),
  trackTo: "The request does not move a track anywhere.",
};

// ---------------------------------------------------------------------------
// Composition.

export type InstantAnswers = Record<string, NoulAnswer | ChoiceAnswer<Record<string, string>> | ScoreAnswer>;

export interface ResolvedAction {
  /** The registry id, for the eval and the timing hook. */
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** The line the harness writes once the tool has run. */
  say: string;
}

/** A Score's expected level read back as the number the tool takes: the
 * answer is a position in level space and may fall between two of them, so
 * the declared values interpolate the same way. */
export function scoreToNumber(answer: ScoreAnswer, values: readonly number[], places = 2): number {
  const top = values.length - 1;
  const s = Math.min(Math.max(answer.score, 0), top);
  const lo = Math.floor(s);
  const hi = Math.min(lo + 1, top);
  const v = values[lo] + (values[hi] - values[lo]) * (s - lo);
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

/** The winner's own probability. Over forty options every plausible action
 * takes a share, so a correct pick reads as low `confidence` — the same
 * reason `resolveVoiceAsk` gates on the chosen voice's probability rather
 * than the spread. */
const won = (a: ChoiceAnswer<Record<string, string>>): number => a.probabilities[a.choice] ?? 0;

/** The action a turn can run with no model round, or null to run the loop.
 * Every answer the chosen action reads must clear its own floor, both guards
 * must stay clear, and the action's arguments must come out complete. */
export function instantAction(
  answers: InstantAnswers | null,
  snap: InstantSnapshot,
  settings: CutJudgeSettings,
): ResolvedAction | null {
  return instantResolve(answers, snap, settings).action;
}

/** The same composition, with what fell short when nothing resolved. The
 * eval reads the shortfall to say why a case took the loop; production
 * reads the action. */
export function instantResolve(
  answers: InstantAnswers | null,
  snap: InstantSnapshot,
  settings: CutJudgeSettings,
): { action: ResolvedAction | null; shortfall: string[] } {
  const none = (...why: string[]) => ({ action: null, shortfall: why });
  if (!settings.instantAction) return none("off");
  if (!answers) return none("no answers");
  const pickOf = (key: string) => answers[key] as ChoiceAnswer<Record<string, string>> | undefined;
  const noulOf = (key: string) => (answers[key] as NoulAnswer | undefined)?.noul ?? null;

  const action = pickOf("action");
  if (!action) return none("action unanswered");
  // The three outcomes that are not an action: nothing here fits, the shot
  // has to be remade, or something has to be produced. All take the loop.
  if (!(action.choice in INSTANT_ACTIONS)) return none(`action=${action.choice}`);
  if (won(action) < settings.instantFloor) return none(`action ${action.choice}@${won(action).toFixed(2)}`);
  const id = action.choice;
  const def = INSTANT_ACTIONS[id];
  if (!def || !availableActions(snap).includes(id)) return none(`${id} unavailable`);

  const multi = noulOf("multi_target");
  if (multi === null || multi >= settings.instantMulti) return none(`multi_target=${multi?.toFixed(2) ?? "?"}`);
  // One action finishes one ask. Two edits in one message — take the
  // crossfade off AND make it pop in — leave half the request undone, so
  // they go to the model, which can run both.
  const leftover = noulOf("leftover");
  if (!def.twoSided && (leftover === null || leftover >= settings.instantLeftover))
    return none(`leftover=${leftover?.toFixed(2) ?? "?"}`);
  // Nothing in this registry makes anything, and a dissatisfied "give me a
  // better version" reads as a colour ask from the outside. The guard sends
  // it to the model, where it becomes a render.
  const remake = noulOf("remake");
  if (remake === null || remake >= settings.instantRemake) return none(`remake=${remake?.toFixed(2) ?? "?"}`);
  if ((def.levels?.length ?? 0) > 0) {
    const exact = noulOf("exact_value");
    if (exact === null || exact >= settings.instantExact) return none(`exact_value=${exact?.toFixed(2) ?? "?"}`);
  }

  const shortfall: string[] = [];
  const resolved = {
    target: {} as Record<string, Candidate>,
    enums: {} as Record<string, string>,
    levels: {} as Record<string, number>,
    bools: {} as Record<string, boolean>,
  };

  for (const kind of [...(def.needs ?? []), ...(def.optional ?? [])]) {
    const a = pickOf(`target::${kind}`);
    const hit = a && a.choice !== "none" && won(a) >= settings.instantTarget
      ? snap.by[kind].find((c) => c.key === a.choice)
      : undefined;
    if (hit) resolved.target[kind] = hit;
    else if (!(def.optional ?? []).includes(kind))
      shortfall.push(`target::${kind}=${a ? `${a.choice}@${won(a).toFixed(2)}` : "?"}`);
  }
  for (const name of def.enums ?? []) {
    const a = pickOf(`enum::${name}`);
    const floor = ENUMS[name].preference ? settings.instantPick : settings.instantEnum;
    if (a && won(a) >= floor && a.choice in ENUMS[name].options) resolved.enums[name] = a.choice;
    else shortfall.push(`enum::${name}=${a ? `${a.choice}@${won(a).toFixed(2)}` : "?"}`);
  }
  for (const name of def.levels ?? []) {
    const a = answers[`level::${name}`] as ScoreAnswer | undefined;
    const fam = LEVELS[name];
    if (a && a.type === "score" && a.confidence >= settings.instantLevel)
      resolved.levels[name] = scoreToNumber(a, fam.levels.map((l) => l.value), fam.places);
    else if (fam.fallback !== undefined) resolved.levels[name] = fam.fallback;
    else shortfall.push(`level::${name}=${a ? `conf ${a.confidence.toFixed(2)}` : "?"}`);
  }
  for (const name of def.bools ?? []) {
    const p = noulOf(`bool::${name}`);
    // A coin flip picks the wrong direction half the time, so a bool the
    // action turns on has to be decisive; a modifier takes its default.
    const settled = p !== null && (p >= settings.instantBool || p <= 1 - settings.instantBool);
    const fallback = BOOLS[name].fallback;
    if (settled) resolved.bools[name] = p! >= 0.5;
    else if (fallback !== undefined) resolved.bools[name] = fallback;
    else shortfall.push(`bool::${name}=${p?.toFixed(2) ?? "?"}`);
  }
  if (shortfall.length > 0) return none(...shortfall);

  const built = def.build({
    target: (kind) => resolved.target[kind],
    maybe: (kind) => resolved.target[kind],
    enumOf: (name) => resolved.enums[name],
    level: (name) => resolved.levels[name],
    bool: (name) => resolved.bools[name],
  });
  // An action whose own builder cannot make sense of the picks (a track
  // reorder onto itself, a subtitle tool handed a video track) writes no
  // sentence, and the turn runs the loop.
  if (!built.say) return none(`${id} does not fit those picks`);
  return { action: { id, tool: def.tool, args: built.args, say: built.say }, shortfall: [] };
}
