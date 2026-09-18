import { describe, expect, test } from "bun:test";
import { JUDGE_MAX_QUESTIONS } from "@/lib/inference/judge";
import { SETTINGS } from "@/lib/config/registry";
import {
  availableActions,
  instantAction,
  instantQuestions,
  instantSnapshot,
  INSTANT_ACTIONS,
  scoreToNumber,
  type InstantAnswers,
  type TargetKind,
} from "./instantAction";

const settings = SETTINGS.cutJudge.default;

/** An editor snapshot in the shape buildAiContext returns, with enough on it
 * for every tier of the registry to be offered. */
const context = {
  playhead: 3,
  playing: false,
  selection: { kind: "clip", id: "clip-b" },
  media: [{ id: "asset-a", name: "beach.mp4", type: "video", duration: 12 }],
  videoTrack: [
    { index: 0, id: "clip-a", asset: "intro.mp4", start: 0, len: 4, muted: false },
    { index: 1, id: "clip-b", asset: "beach.mp4", start: 4, len: 6, muted: false },
    { index: 2, id: "clip-c", asset: "sunset.mp4", start: 10, len: 5, muted: false },
  ],
  overlayVideo: [],
  soundtrack: [{ id: "audio-a", asset: "music.mp3", start: 0 }],
  overlays: [{ id: "ov-a", kind: "text", text: "Hello", start: 1, end: 3 }],
  transitions: [{ id: "tr-a", start: 4, seconds: 0.5, style: "crossfade" }],
  subtitles: {
    cues: [
      { id: "cue-a", start: 0, end: 1, text: "first line" },
      { id: "cue-b", start: 1, end: 2, text: "second line" },
    ],
    tracks: [{ track: 0, locale: "en-US", cues: 2 }],
  },
};

const snap = instantSnapshot(context);
const keyOf = (kind: TargetKind, id: string) => snap.by[kind].find((c) => c.id === id)!.key;

type Over = {
  action?: string;
  actionP?: number;
  targets?: Record<string, { key: string; p?: number }>;
  enums?: Record<string, { value: string; p?: number }>;
  levels?: Record<string, { score: number; confidence?: number }>;
  bools?: Record<string, number>;
  exact?: number;
  multi?: number;
  leftover?: number;
  remake?: number;
};

function answers(over: Over): InstantAnswers {
  const out: Record<string, unknown> = {
    action: {
      type: "choice",
      choice: over.action ?? "none",
      probabilities: { [over.action ?? "none"]: over.actionP ?? 0.8 },
      confidence: 0.5,
    },
    exact_value: { type: "noul", noul: over.exact ?? 0.05 },
    multi_target: { type: "noul", noul: over.multi ?? 0.05 },
    leftover: { type: "noul", noul: over.leftover ?? 0.05 },
    remake: { type: "noul", noul: over.remake ?? 0.05 },
  };
  for (const [kind, t] of Object.entries(over.targets ?? {}))
    out[`target::${kind}`] = { type: "choice", choice: t.key, probabilities: { [t.key]: t.p ?? 0.9 }, confidence: 0.5 };
  for (const [name, e] of Object.entries(over.enums ?? {}))
    out[`enum::${name}`] = { type: "choice", choice: e.value, probabilities: { [e.value]: e.p ?? 0.9 }, confidence: 0.5 };
  for (const [name, l] of Object.entries(over.levels ?? {}))
    out[`level::${name}`] = { type: "score", score: l.score, probabilities: {}, legend: {}, confidence: l.confidence ?? 0.8 };
  for (const [name, p] of Object.entries(over.bools ?? {})) out[`bool::${name}`] = { type: "noul", noul: p };
  return out as InstantAnswers;
}

describe("instantSnapshot", () => {
  test("names every item the timeline holds and marks the selected one", () => {
    expect(snap.by.clip.map((c) => c.id)).toEqual(["clip-a", "clip-b", "clip-c"]);
    expect(snap.by.clip.find((c) => c.id === "clip-b")!.label).toContain("currently selected");
    expect(snap.by.cue.map((c) => c.name)).toEqual(["first line", "second line"]);
    expect(snap.by.track.map((t) => t.track?.kind)).toEqual(["video", "soundtrack", "text", "subtitles"]);
  });

  test("an empty project offers only the actions that need nothing", () => {
    const empty = instantSnapshot({});
    const ids = availableActions(empty);
    expect(ids).toContain("undo");
    expect(ids).toContain("set_aspect");
    expect(ids).not.toContain("set_clip_muted");
    expect(ids).not.toContain("delete_cue");
  });

  // buildAiContext always reports at least one subtitle track, so a project
  // with no captions must still leave the caption tools out.
  test("a subtitle track with no cues is neither a track nor a caption tool", () => {
    const bare = instantSnapshot({
      ...context,
      subtitles: { count: 0, cues: [], tracks: [{ track: 0, locale: "en-US", cues: 0 }] },
    });
    expect(bare.captionTracks).toBe(0);
    expect(bare.by.track.map((t) => t.track?.kind)).not.toContain("subtitles");
    const ids = availableActions(bare);
    expect(ids).not.toContain("set_caption_look");
    expect(ids).not.toContain("subtitles_remove_track");
  });

  // The sound and title rows are numbered, so a project with music over
  // narration offers both and the track tools can tell them apart.
  test("every sound and title row is its own track candidate", () => {
    const layered = instantSnapshot({
      ...context,
      soundtrack: [
        { id: "audio-a", asset: "narration.mp3", start: 0 },
        { id: "audio-b", asset: "music.mp3", start: 0, lane: 1 },
      ],
      overlays: [
        { id: "ov-a", kind: "text", text: "Hello", start: 1, end: 3 },
        { id: "ov-b", kind: "shape", name: "Bar", start: 1, end: 3, lane: 2 },
      ],
    });
    const rows = layered.by.track.map((t) => `${t.track?.kind}-${t.track?.index}`);
    expect(rows).toContain("soundtrack-0");
    expect(rows).toContain("soundtrack-1");
    expect(rows).toContain("text-0");
    expect(rows).toContain("text-2");
    expect(layered.by.track.find((t) => t.track?.kind === "soundtrack" && t.track.index === 1)!.label).toContain(
      "music.mp3",
    );
  });
});

describe("instantQuestions", () => {
  test("one action question, the guards, and one question per family — under the cap", () => {
    const qs = instantQuestions(snap);
    expect(qs.action.type).toBe("choice");
    expect(qs.exact_value.type).toBe("noul");
    expect(qs.multi_target.type).toBe("noul");
    expect(Object.keys(qs).length).toBeLessThanOrEqual(JUDGE_MAX_QUESTIONS);
    // Targets are asked per item kind, never per action, so the count stays
    // flat as the registry grows.
    expect(Object.keys(qs).filter((k) => k.startsWith("target::")).length).toBeLessThanOrEqual(8);
  });

  test("the action options are the available actions plus the three ways out", () => {
    const qs = instantQuestions(snap);
    const options = Object.keys((qs.action as { criteria: Record<string, unknown> }).criteria);
    expect(new Set(options)).toEqual(new Set([...availableActions(snap), "none", "remake_it", "make_new"]));
  });

  test("a way out never resolves to a call", () => {
    for (const out of ["none", "remake_it", "make_new"])
      expect(instantAction(answers({ action: out }), snap, settings)).toBeNull();
  });

  test("delete_asset is never offered — undo does not bring the file back", () => {
    expect(Object.keys(INSTANT_ACTIONS)).not.toContain("delete_asset");
    expect(Object.values(INSTANT_ACTIONS).map((d) => d.tool)).not.toContain("delete_asset");
  });
});

describe("scoreToNumber", () => {
  const values = [0.25, 0.5, 1, 1.5, 2, 4];
  const ans = (score: number) => ({ type: "score" as const, score, probabilities: {}, legend: {}, confidence: 1 });

  test("a whole level reads back its own value", () => {
    expect(scoreToNumber(ans(0), values)).toBe(0.25);
    expect(scoreToNumber(ans(2), values)).toBe(1);
    expect(scoreToNumber(ans(5), values)).toBe(4);
  });

  test("between two levels it interpolates", () => {
    expect(scoreToNumber(ans(2.5), values)).toBe(1.25);
    expect(scoreToNumber(ans(3.25), values)).toBe(1.63);
  });

  test("outside the rubric it clamps", () => {
    expect(scoreToNumber(ans(-4), values)).toBe(0.25);
    expect(scoreToNumber(ans(99), values)).toBe(4);
  });

  test("places round to what the tool takes", () => {
    expect(scoreToNumber(ans(1.5), [-50, -25, 0, 25, 50], 0)).toBe(-12);
    expect(scoreToNumber(ans(3.2), [-50, -25, 0, 25, 50], 0)).toBe(30);
  });
});

describe("instantAction", () => {
  test("a resolved toggle builds its tool call and its line", () => {
    const r = instantAction(
      answers({ action: "set_clip_muted", targets: { clip: { key: keyOf("clip", "clip-a") } }, bools: { mute: 0.95 } }),
      snap,
      settings,
    );
    expect(r).toEqual({
      id: "set_clip_muted",
      tool: "set_clip_muted",
      args: { clipId: "clip-a", muted: true },
      say: 'Muted "intro.mp4".',
    });
  });

  test("a level becomes the number the tool takes", () => {
    const r = instantAction(
      answers({
        action: "set_speed",
        targets: { clip: { key: keyOf("clip", "clip-b") } },
        levels: { speed: { score: 1 } },
        bools: { smooth: 0.05 },
      }),
      snap,
      settings,
    );
    expect(r?.args).toEqual({ clipId: "clip-b", speed: 0.5 });
  });

  test("an enum comes from the shipped catalog", () => {
    const r = instantAction(
      answers({
        action: "set_transition",
        targets: { clip: { key: keyOf("clip", "clip-a") } },
        enums: { transition_style: { value: "crossfade" } },
        levels: { seconds_short: { score: 2 } },
      }),
      snap,
      settings,
    );
    expect(r?.args).toEqual({ clipId: "clip-a", style: "crossfade", seconds: 0.5 });
  });

  test("the action's own probability, not its confidence, decides", () => {
    const low = answers({
      action: "set_clip_muted",
      actionP: 0.2,
      targets: { clip: { key: keyOf("clip", "clip-a") } },
      bools: { mute: 0.95 },
    });
    expect(instantAction(low, snap, settings)).toBeNull();
  });

  test("an unsettled argument runs the loop instead", () => {
    const base = { action: "set_clip_muted", targets: { clip: { key: keyOf("clip", "clip-a") } }, bools: { mute: 0.95 } };
    expect(instantAction(answers({ ...base, targets: { clip: { key: keyOf("clip", "clip-a"), p: 0.2 } } }), snap, settings)).toBeNull();
    // A coin-flip direction is wrong half the time.
    expect(instantAction(answers({ ...base, bools: { mute: 0.5 } }), snap, settings)).toBeNull();
    expect(instantAction(answers({ ...base, targets: {} }), snap, settings)).toBeNull();
  });

  test("a modifier the ask never states takes its default, the direction does not", () => {
    // "select the sunset clip" says nothing about adding to the selection.
    const r = instantAction(
      answers({ action: "select_clip", targets: { clip: { key: keyOf("clip", "clip-c") } } }),
      snap,
      settings,
    );
    expect(r?.args).toEqual({ kind: "clip", id: "clip-c", additive: false });
    // "duck the music" says nothing about how far; the panel's own default does.
    const duck = instantAction(
      answers({ action: "set_audio_duck", targets: { audio: { key: keyOf("audio", "audio-a") } } }),
      snap,
      settings,
    );
    expect(duck?.args).toEqual({ id: "audio-a", duck: 0.5 });
    // Mute or unmute is the whole ask, so an undecided direction runs the loop.
    expect(
      instantAction(
        answers({ action: "set_clip_muted", targets: { clip: { key: keyOf("clip", "clip-a") } }, bools: { mute: 0.5 } }),
        snap,
        settings,
      ),
    ).toBeNull();
  });

  test("a named figure and a described set both take the model", () => {
    const base = {
      action: "set_speed",
      targets: { clip: { key: keyOf("clip", "clip-b") } },
      levels: { speed: { score: 4 } },
      bools: { smooth: 0.05 },
    };
    expect(instantAction(answers(base), snap, settings)).not.toBeNull();
    expect(instantAction(answers({ ...base, exact: 0.9 }), snap, settings)).toBeNull();
    expect(instantAction(answers({ ...base, multi: 0.9 }), snap, settings)).toBeNull();
    expect(instantAction(answers({ ...base, leftover: 0.9 }), snap, settings)).toBeNull();
    // A shot the person wants remade goes to the model however close a
    // colour setting reads to the ask.
    expect(instantAction(answers({ ...base, remake: 0.9 }), snap, settings)).toBeNull();
  });

  test("an exact figure still allows an action with no numeric argument", () => {
    const r = instantAction(
      answers({
        action: "set_clip_muted",
        targets: { clip: { key: keyOf("clip", "clip-a") } },
        bools: { mute: 0.95 },
        exact: 0.9,
      }),
      snap,
      settings,
    );
    expect(r?.tool).toBe("set_clip_muted");
  });

  test("no answers, no action, and the path switched off all run the loop", () => {
    expect(instantAction(null, snap, settings)).toBeNull();
    expect(instantAction(answers({ action: "none", actionP: 0.9 }), snap, settings)).toBeNull();
    expect(
      instantAction(
        answers({ action: "undo", actionP: 0.99 }),
        snap,
        { ...settings, instantAction: false },
      ),
    ).toBeNull();
  });

  test("an action this project cannot carry is refused even if it wins", () => {
    const empty = instantSnapshot({});
    expect(instantAction(answers({ action: "delete_cue", actionP: 0.99 }), empty, settings)).toBeNull();
  });

  test("a track reorder onto its own position writes nothing", () => {
    const row = snap.by.track.find((t) => t.track?.kind === "video")!;
    const to = snap.by.trackTo.find((t) => t.track?.kind === "video")!;
    expect(
      instantAction(
        answers({ action: "reorder_track", targets: { track: { key: row.key }, trackTo: { key: to.key } } }),
        snap,
        settings,
      ),
    ).toBeNull();
  });

  // Subtitle tracks have no stacking order and reorder_track's schema does
  // not take them, so the pair writes nothing.
  test("a track reorder across subtitle tracks writes nothing", () => {
    const subs = instantSnapshot({
      ...context,
      subtitles: {
        ...context.subtitles,
        tracks: [
          { track: 0, locale: "en-US", cues: 2 },
          { track: 1, locale: "ko-KR", cues: 2 },
        ],
      },
    });
    const rows = subs.by.track.filter((t) => t.track?.kind === "subtitles");
    const tos = subs.by.trackTo.filter((t) => t.track?.kind === "subtitles");
    expect(rows.length).toBe(2);
    expect(
      instantAction(
        answers({ action: "reorder_track", targets: { track: { key: rows[0].key }, trackTo: { key: tos[1].key } } }),
        subs,
        settings,
      ),
    ).toBeNull();
  });

  // set_color_hsl writes a band's hue, saturation and luminance together and
  // the snapshot carries no values, so a band already set is the model's.
  test("a colour band already set takes the model", () => {
    const picks = {
      action: "set_color_hsl",
      targets: { clip: { key: keyOf("clip", "clip-a") } },
      enums: { hsl_band: { value: "blue" } },
      levels: { hsl_sat: { score: 3 } },
    };
    expect(instantAction(answers(picks), snap, settings)?.tool).toBe("set_color_hsl");
    const graded = instantSnapshot({
      ...context,
      videoTrack: [{ ...context.videoTrack[0], hslBands: ["blue"] }, ...context.videoTrack.slice(1)],
    });
    expect(instantAction(answers(picks), graded, settings)).toBeNull();
  });
});
