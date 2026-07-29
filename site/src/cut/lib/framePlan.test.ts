import { describe, expect, test } from "bun:test";
import { clipAnimFx, duckGainAt, trackZeroPlan } from "./framePlan";
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
      clip: videoClip({ start: at, out: len }),
      asset,
      start: at,
      len,
      transitionOut,
    });
    at += len - transitionOut;
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

  test("ramps a dissolve from 0 to 1 across the overlap", () => {
    const spans = spansOf(2, 4, [2]);
    const start = spans[1].start;
    expect(trackZeroPlan(spans[0], spans, start).p).toBeCloseTo(0, 5);
    expect(trackZeroPlan(spans[0], spans, start + 1).p).toBeCloseTo(0.5, 5);
    expect(trackZeroPlan(spans[0], spans, start + 2).p).toBeCloseTo(1, 5);
  });

  test("names the incoming clip only while its overlap is live", () => {
    const spans = spansOf(2, 4, [2]);
    expect(trackZeroPlan(spans[0], spans, spans[1].start - 0.1).incoming).toBe(null);
    expect(trackZeroPlan(spans[0], spans, spans[1].start + 0.1).incoming).toBe(spans[1]);
  });

  test("pushes the outgoing clip in and settles the incoming one on a cross zoom", () => {
    const spans = spansOf(2, 4, [2]);
    spans[0].clip.transitionStyle = "crosszoom";
    const mid = trackZeroPlan(spans[0], spans, spans[1].start + 1);
    expect(mid.masterZoom).toBeCloseTo(1 + (TRANSITION_ZOOM - 1) * 0.5, 5);
    expect(mid.incZoom).toBeCloseTo(TRANSITION_ZOOM - (TRANSITION_ZOOM - 1) * 0.5, 5);
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
