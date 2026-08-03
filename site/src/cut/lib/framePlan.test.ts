import { describe, expect, test } from "bun:test";
import { clipAnimFx, duckGainAt, prerollLead, PREROLL_LEAD_S, trackZeroPlan } from "./framePlan";
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
    });
    at += len; // clips abut — a transition is a blend at the cut, never overlap
  }
  return spans;
}

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
