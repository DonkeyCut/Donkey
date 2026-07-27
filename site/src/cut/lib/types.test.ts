import { describe, expect, test } from "bun:test";
import { migrateLegacyTransitions, normalizeAspect, TRANSITION_STYLE_IDS, type VideoClip } from "./types";

/** A minimal track-0 clip; legacy docs carry retired transitionStyle strings. */
function clip(
  id: string,
  start: number,
  patch: Omit<Partial<VideoClip>, "transitionStyle"> & { transitionStyle?: string } = {}
): VideoClip {
  return {
    id,
    assetId: `asset-${id}`,
    track: 0,
    start,
    in: 0,
    out: 4,
    muted: false,
    ...patch,
  } as VideoClip;
}

describe("migrateLegacyTransitions", () => {
  test("docs without legacy styles pass through untouched", () => {
    const clips = [clip("a", 0, { transition: 0.5 }), clip("b", 4)];
    expect(migrateLegacyTransitions(clips)).toBe(clips);
  });

  test("fadeout/zoomin become the leading clip's exit animation", () => {
    const out = migrateLegacyTransitions([
      clip("a", 0, { transition: 0.8, transitionStyle: "fadeout" }),
      clip("b", 4, { transition: 0.6, transitionStyle: "zoomin" }),
      clip("c", 8),
    ]);
    expect(out[0].animOut).toEqual({ style: "fade", seconds: 0.8 });
    expect(out[0].transition).toBeUndefined();
    expect(out[0].transitionStyle).toBeUndefined();
    expect(out[1].animOut).toEqual({ style: "zoom", seconds: 0.6 });
  });

  test("fadein/zoomout become the following clip's entrance animation", () => {
    const out = migrateLegacyTransitions([
      clip("a", 0, { transition: 0.5, transitionStyle: "fadein" }),
      clip("b", 4, { transition: 0.4, transitionStyle: "zoomout" }),
      clip("c", 8),
    ]);
    expect(out[1].animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(out[2].animIn).toEqual({ style: "zoom", seconds: 0.4 });
    expect(out[0].transition).toBeUndefined();
  });

  test("fadein on a track's last clip drops (no next clip to enter)", () => {
    const out = migrateLegacyTransitions([
      clip("a", 0),
      clip("b", 4, { transition: 0.5, transitionStyle: "fadein" }),
    ]);
    expect(out.every((c) => !c.animIn && !c.animOut)).toBe(true);
    expect(out[1].transition).toBeUndefined();
  });

  test("migration stays within each track", () => {
    const out = migrateLegacyTransitions([
      clip("a0", 0, { transition: 0.5, transitionStyle: "fadein" }),
      clip("b1", 1, { track: 1 }),
      clip("c0", 4),
    ]);
    expect(out.find((c) => c.id === "c0")?.animIn).toEqual({ style: "fade", seconds: 0.5 });
    expect(out.find((c) => c.id === "b1")?.animIn).toBeUndefined();
  });

  test("an existing animation is never overwritten", () => {
    const out = migrateLegacyTransitions([
      clip("a", 0, {
        transition: 0.5,
        transitionStyle: "fadeout",
        animOut: { style: "pop", seconds: 0.3 },
      }),
      clip("b", 4),
    ]);
    expect(out[0].animOut).toEqual({ style: "pop", seconds: 0.3 });
  });

  test("unknown styles clear to a hard cut", () => {
    const out = migrateLegacyTransitions([
      clip("a", 0, { transition: 0.5, transitionStyle: "sparkle-explosion" }),
      clip("b", 4),
    ]);
    expect(out[0].transition).toBeUndefined();
    expect(out[0].transitionStyle).toBeUndefined();
    expect(out[0].animOut).toBeUndefined();
  });

  test("current style ids are never treated as legacy", () => {
    for (const id of TRANSITION_STYLE_IDS) {
      const clips = [clip("a", 0, { transition: 0.5, transitionStyle: id }), clip("b", 4)];
      expect(migrateLegacyTransitions(clips)).toBe(clips);
    }
  });
});

describe("normalizeAspect", () => {
  test("reduces a frame size to its ratio", () => {
    // Typing the dimensions you know is a legal way to say a ratio; before, a
    // four-digit side was trimmed to three and applied as something else.
    expect(normalizeAspect("1280:720")).toBe("16:9");
    expect(normalizeAspect("1920:1080")).toBe("16:9");
    expect(normalizeAspect("1080:1920")).toBe("9:16");
  });

  test("keeps the single canonical spelling", () => {
    expect(normalizeAspect("18:32")).toBe("9:16");
    expect(normalizeAspect("09:16")).toBe("9:16");
    expect(normalizeAspect("1.85:1")).toBe("37:20");
  });

  test("rejects what can't be a frame", () => {
    expect(normalizeAspect("0:9")).toBe(null);
    expect(normalizeAspect("16:0")).toBe(null);
    // Past the 8:1 shape cap.
    expect(normalizeAspect("100:1")).toBe(null);
    // Reduces to sides that don't fit the stored form.
    expect(normalizeAspect("1000:999")).toBe(null);
    expect(normalizeAspect("16")).toBe(null);
    expect(normalizeAspect("16:9:2")).toBe(null);
    expect(normalizeAspect("1.855:1")).toBe(null);
    expect(normalizeAspect("")).toBe(null);
    expect(normalizeAspect(null)).toBe(null);
  });
});
