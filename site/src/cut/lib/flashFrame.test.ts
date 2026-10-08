import { describe, expect, test } from "bun:test";
import { clipLen, separateOverlaps } from "./store";
import type { VideoClip } from "./types";

/** A flash frame — a clip one frame long — keeps its length, and the shot
 * after it stays where it was cut. */

const FRAME = 1 / 30;
const clip = (id: string, start: number, len: number): VideoClip => ({
  id,
  assetId: "a",
  track: 0,
  start,
  in: 0,
  out: len,
  muted: true,
});

describe("flash frames", () => {
  test("a one-frame clip is one frame long on the timeline", () => {
    expect(clipLen(clip("pop", 0, FRAME))).toBeCloseTo(FRAME, 6);
  });

  test("the shot after a one-frame clip stays on its cut", () => {
    const doc = { clips: [clip("pop", 3.5, FRAME), clip("next", 3.5 + FRAME, 1)], audioClips: [], overlays: [], cues: [] };
    const next = separateOverlaps(doc).clips.find((c) => c.id === "next")!;
    expect(next.start).toBeCloseTo(3.5 + FRAME, 6);
  });
});
