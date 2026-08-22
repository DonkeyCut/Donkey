import { describe, expect, test } from "bun:test";
import {
  clipAnimFx,
  crossHandles,
  duckGainAt,
  overlayTransitionFx,
  prerollLead,
  PREROLL_LEAD_S,
  soundCrossGain,
  trackZeroPlan,
} from "./framePlan";
import { TRANSITION_ZOOM } from "./types";
import type { AudioClip, ClipSpan, MediaAsset, VideoClip } from "./types";

const asset: MediaAsset = {
  id: "asset",
  fileName: "a.mp4",
  name: "a",
  type: "video",
  duration: 100,
  url: "blob:a",
};

let nextId = 0;
const videoClip = (over: Partial<VideoClip> = {}): VideoClip => ({
  id: `clip-${nextId++}`,
  assetId: "asset",
  track: 0,
  start: 0,
  in: 0,
  out: 4,
  muted: false,
  ...over,
});

/** Spans laid end to end, each dissolving into the next by `transitions[i]`. */
function spansOf(count: number, len = 4, transitions: number[] = []): ClipSpan[] {
  const spans: ClipSpan[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const transitionOut = transitions[i] ?? 0;
    spans.push({
      clip: videoClip({ start: at, out: len, transitionStyle: undefined }),
      asset,
      start: at,
      len,
      transitionOut,
      soundOut: 0,
      soundAhead: 0,
      soundBack: 0,
    });
    at += len; // clips abut — a transition is a blend at the cut, never overlap
  }
  return spans;
}

/** The same run, handing over on the sound: the picture cuts, and each cut's
 * crossing runs `crosses[i]` either side of it. Both clips are trimmed out of
 * a longer source, so each has the handle its side of a crossing reaches
 * into. */
function soundSpansOf(count: number, len = 4, crosses: number[] = []): ClipSpan[] {
  const spans = spansOf(count, len);
  return spans.map((sp, i) => ({
    ...sp,
    soundOut: crosses[i] ?? 0,
    soundAhead: crosses[i] ?? 0,
    soundBack: crosses[i - 1] ?? 0,
  }));
}

describe("soundCrossGain", () => {
  test("crosses the level over the cut while the picture stays a cut", () => {
    const spans = soundSpansOf(2, 4, [2]);
    const cut = spans[1].start;
    // Nothing moves until the window opens, and it is done when it closes.
    expect(soundCrossGain(spans, spans[0], cut - 2.5)).toBeCloseTo(1, 5);
    expect(soundCrossGain(spans, spans[1], cut - 2)).toBeCloseTo(0, 5);
    expect(soundCrossGain(spans, spans[0], cut + 2)).toBeCloseTo(0, 5);
    expect(soundCrossGain(spans, spans[1], cut + 2.5)).toBeCloseTo(1, 5);
    // The two sides meet on the cut itself, each at equal power's half.
    expect(soundCrossGain(spans, spans[0], cut)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(soundCrossGain(spans, spans[1], cut)).toBeCloseTo(Math.SQRT1_2, 5);
    // The picture never blends: no overlap, no incoming picture.
    expect(trackZeroPlan(spans[0], spans, cut - 1).p).toBe(0);
    expect(trackZeroPlan(spans[0], spans, cut - 1).incoming).toBe(null);
    expect(trackZeroPlan(spans[0], spans, cut - 1).masterAlpha).toBe(1);
  });

  test("holds one loudness across the crossing", () => {
    const spans = soundSpansOf(2, 4, [2]);
    const cut = spans[1].start;
    // Equal power: the two gains square to one everywhere in the window, so
    // the mix neither dips nor swells through the join.
    for (const t of [cut - 2, cut - 1.3, cut - 0.4, cut, cut + 0.6, cut + 1.7, cut + 2]) {
      const going = soundCrossGain(spans, spans[0], t);
      const coming = soundCrossGain(spans, spans[1], t);
      expect(going * going + coming * coming).toBeCloseTo(1, 5);
    }
  });

  test("both sides of a crossing sound past their own footprint", () => {
    const spans = soundSpansOf(2, 4, [2]);
    const cut = spans[1].start;
    // The outgoing clip is still playing — on its handle — after the picture
    // has cut, and the incoming one before it.
    const after = crossHandles(spans, cut + 1);
    expect(after.map((h) => h.span.clip.id)).toEqual([spans[0].clip.id]);
    expect(after[0].gain).toBeCloseTo(Math.cos((0.75 * Math.PI) / 2), 5);
    const before = crossHandles(spans, cut - 1);
    expect(before.map((h) => h.span.clip.id)).toEqual([spans[1].clip.id]);
    expect(before[0].gain).toBeCloseTo(Math.sin((0.25 * Math.PI) / 2), 5);
    // Outside the crossing nothing sounds past its own footprint.
    expect(crossHandles(spans, cut + 2.5)).toEqual([]);
  });

  test("a clip with no handle keeps its side of the crossing inside itself", () => {
    // Both clips run to the ends of their sources: nothing to reach into, so
    // the ramps stay put and only the ramps play.
    const spans = soundSpansOf(2, 4, [2]).map((sp) => ({
      ...sp,
      soundAhead: 0,
      soundBack: 0,
    }));
    expect(crossHandles(spans, spans[1].start + 1)).toEqual([]);
    expect(soundCrossGain(spans, spans[0], spans[1].start)).toBeCloseTo(Math.SQRT1_2, 5);
  });

  test("leaves a run with no cross dissolve at full level", () => {
    const spans = soundSpansOf(2, 4);
    expect(soundCrossGain(spans, spans[0], 3.9)).toBe(1);
    expect(soundCrossGain(spans, spans[1], 4.1)).toBe(1);
  });
});

describe("overlayTransitionFx", () => {
  test("an upper-track cross dissolve moves the level and not the picture", () => {
    const spans = soundSpansOf(2, 4, [2]);
    const cut = spans[1].start;
    const out = overlayTransitionFx(spans[0], undefined, spans[1], cut - 1);
    expect(out.gain).toBeCloseTo(Math.cos((0.25 * Math.PI) / 2), 5);
    expect(out.alpha).toBe(1);
    const inc = overlayTransitionFx(spans[1], spans[0], undefined, cut + 1);
    expect(inc.gain).toBeCloseTo(Math.sin((0.75 * Math.PI) / 2), 5);
    expect(inc.alpha).toBe(1);
  });
});

describe("trackZeroPlan", () => {
  test("reports no transition in the middle of a clip", () => {
    const spans = spansOf(2);
    const plan = trackZeroPlan(spans[0], spans, 2);
    expect(plan.p).toBe(0);
    expect(plan.incoming).toBe(null);
    expect(plan.masterAlpha).toBe(1);
    expect(plan.masterZoom).toBe(1);
  });

  test("ramps a dissolve from 0 to 1 across the blend window before the cut", () => {
    const spans = spansOf(2, 4, [2]);
    const cut = spans[1].start;
    expect(trackZeroPlan(spans[0], spans, cut - 2).p).toBeCloseTo(0, 5);
    expect(trackZeroPlan(spans[0], spans, cut - 1).p).toBeCloseTo(0.5, 5);
    expect(trackZeroPlan(spans[0], spans, cut - 0.001).p).toBeCloseTo(1, 2);
  });

  test("names the incoming clip only while its blend window is live", () => {
    const spans = spansOf(2, 4, [2]);
    const cut = spans[1].start;
    expect(trackZeroPlan(spans[0], spans, cut - 2.1).incoming).toBe(null);
    expect(trackZeroPlan(spans[0], spans, cut - 0.1).incoming).toBe(spans[1]);
  });

  test("fades the outgoing sound across the blend window", () => {
    const spans = spansOf(2, 4, [2]);
    const cut = spans[1].start;
    expect(trackZeroPlan(spans[0], spans, cut - 2).gain).toBeCloseTo(1, 5);
    expect(trackZeroPlan(spans[0], spans, cut - 1).gain).toBeCloseTo(0.5, 5);
  });

  test("pushes the outgoing clip in, holds the incoming one pushed, settles it after the cut", () => {
    const spans = spansOf(2, 4, [2]);
    spans[0].clip.transitionStyle = "crosszoom";
    const cut = spans[1].start;
    const mid = trackZeroPlan(spans[0], spans, cut - 1);
    expect(mid.masterZoom).toBeCloseTo(1 + (TRANSITION_ZOOM - 1) * 0.5, 5);
    expect(mid.incZoom).toBeCloseTo(TRANSITION_ZOOM, 5);
    // Past the cut the incoming clip is the master, settling over its head.
    const after = trackZeroPlan(spans[1], spans, cut + 1);
    expect(after.masterZoom).toBeCloseTo(TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * 0.5, 5);
  });

  test("veils a fade-in from black at the head of the timeline", () => {
    const spans = spansOf(1);
    spans[0].clip.animIn = { style: "fade", seconds: 1 };
    expect(trackZeroPlan(spans[0], spans, 0).veil).toBeCloseTo(1, 5);
    expect(trackZeroPlan(spans[0], spans, 0.5).veil).toBeCloseTo(0.5, 5);
    expect(trackZeroPlan(spans[0], spans, 1).veil).toBe(0);
  });

  test("holds an animation on the side a transition already owns", () => {
    const spans = spansOf(2, 4, [2]);
    // The second clip's entrance sits inside the dissolve, so the dissolve
    // plays there and the animation stands down.
    spans[1].clip.animIn = { style: "fade", seconds: 1 };
    const plan = trackZeroPlan(spans[1], spans, spans[1].start + 0.2);
    expect(plan.veil).toBe(0);
    expect(plan.masterAlpha).toBe(1);
  });

  test("puts the previous clip's frame behind a fade at an abutting cut", () => {
    const spans = spansOf(2);
    spans[1].clip.animIn = { style: "fade", seconds: 1 };
    const plan = trackZeroPlan(spans[1], spans, spans[1].start + 0.2);
    expect(plan.backdrop?.span).toBe(spans[0]);
    // With something behind it the fade blends by alpha rather than to black.
    expect(plan.masterAlpha).toBeLessThan(1);
    expect(plan.veil).toBe(0);
  });

  test("has no backdrop for a zoom, which covers the frame anyway", () => {
    const spans = spansOf(2);
    spans[1].clip.animIn = { style: "zoom", seconds: 1 };
    expect(trackZeroPlan(spans[1], spans, spans[1].start + 0.2).backdrop).toBe(null);
  });

  test("flags the next clip once it is close enough to warm", () => {
    const spans = spansOf(2);
    expect(trackZeroPlan(spans[0], spans, 1).upcoming).toBe(null);
    expect(trackZeroPlan(spans[0], spans, spans[1].start - 0.2).upcoming).toBe(spans[1]);
  });
});

describe("clipAnimFx", () => {
  test("leaves a clip alone outside its animation windows", () => {
    const fx = clipAnimFx(videoClip({ animIn: { style: "fade", seconds: 1 } }), 2, 4);
    expect(fx).toEqual({ alpha: 1, zoom: 1, gain: 1, veil: 0, dxFrac: 0, dyFrac: 0 });
  });

  test("drops the audio with the picture through a fade", () => {
    const fx = clipAnimFx(videoClip({ animIn: { style: "fade", seconds: 2 } }), 0.5, 4);
    expect(fx.gain).toBeCloseTo(0.25, 5);
    expect(fx.veil).toBeCloseTo(0.75, 5);
  });

  test("slides the frame in from the right and out to the left", () => {
    const clip = videoClip({
      animIn: { style: "slideleft", seconds: 1 },
      animOut: { style: "slideleft", seconds: 1 },
    });
    // Enters a full frame to the right, settles at 0, then leaves to the left.
    expect(clipAnimFx(clip, 0, 4).dxFrac).toBeCloseTo(1, 5);
    expect(clipAnimFx(clip, 1, 4).dxFrac).toBeCloseTo(0, 5);
    expect(clipAnimFx(clip, 3.5, 4).dxFrac).toBeCloseTo(-0.5, 5);
    expect(clipAnimFx(clip, 4, 4).dxFrac).toBeCloseTo(-1, 5);
  });

  test("treats a style it does not know as a fade", () => {
    const fx = clipAnimFx(
      videoClip({ animIn: { style: "kaleidoscope" as never, seconds: 2 } }),
      0,
      4
    );
    expect(fx.veil).toBeCloseTo(1, 5);
  });

  test("clamps an animation longer than the clip to the clip", () => {
    const fx = clipAnimFx(videoClip({ animIn: { style: "fade", seconds: 10 } }), 1, 2);
    expect(fx.veil).toBeCloseTo(0.5, 5);
  });
});

describe("duckGainAt", () => {
  const voice = (over: Partial<AudioClip> = {}): AudioClip => ({
    id: "vo",
    assetId: "asset",
    start: 1,
    in: 0,
    out: 3,
    volume: 1,
    duck: 0.2,
    ...over,
  });

  test("is 1 with no ducking clip live", () => {
    expect(duckGainAt([voice()], 0)).toBe(1);
    expect(duckGainAt([voice()], 5)).toBe(1);
  });

  test("drops to the duck while the voiceover speaks", () => {
    expect(duckGainAt([voice()], 2)).toBeCloseTo(0.2, 5);
  });

  test("takes the deepest duck when two overlap", () => {
    expect(duckGainAt([voice(), voice({ id: "b", duck: 0.05 })], 2)).toBeCloseTo(0.05, 5);
  });

  test("ignores a hidden clip", () => {
    expect(duckGainAt([voice({ hidden: true })], 2)).toBe(1);
  });
});

describe("prerollLead", () => {
  // The roll seats the element `lead × speed` of source before the in-point and
  // plays forward for `lead` of timeline, so it arrives exactly at `in` as the
  // cut lands. Both halves come from this one number: hold the roll at a fixed
  // length and the seat has to clamp at 0, which lands the element past `in` and
  // makes the handoff seek backwards — a decoder restart at every join.
  const cases: [number, number][] = [
    [0, 1],
    [0.2, 1],
    [3, 1],
    [0.6, 2],
    [4, 0.5],
  ];

  test("gives a trimmed clip the full lead", () => {
    expect(prerollLead(3, 1)).toBeCloseTo(PREROLL_LEAD_S, 5);
  });

  test("gives an untrimmed clip none — there is no source to roll through", () => {
    expect(prerollLead(0, 1)).toBe(0);
  });

  test("shortens the roll to the source a barely-trimmed clip has", () => {
    expect(prerollLead(0.2, 1)).toBeCloseTo(0.2, 5);
  });

  test("scales with the clip's speed", () => {
    // At 2×, half a second of timeline eats a second of source, so a clip with
    // 0.6s ahead of its in-point can only roll for 0.3s.
    expect(prerollLead(0.6, 2)).toBeCloseTo(0.3, 5);
    expect(prerollLead(4, 2)).toBeCloseTo(PREROLL_LEAD_S, 5);
  });

  test("seats the roll inside the source and lands it on the in-point", () => {
    for (const [inPoint, speed] of cases) {
      const lead = prerollLead(inPoint, speed);
      const seat = inPoint - lead * speed;
      expect(seat).toBeGreaterThanOrEqual(0);
      expect(seat + lead * speed).toBeCloseTo(inPoint, 5);
    }
  });
});
