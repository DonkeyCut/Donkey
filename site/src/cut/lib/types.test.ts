import { describe, expect, test } from "bun:test";
import { animStyleOfTransition, AUDIO_TRANSITION_STYLES, clipCovers, contentRect, migrateLegacyTransitions, normalizeAspect, TRANSITION_STYLE_GROUPS, TRANSITION_STYLE_IDS, TRANSITION_STYLE_LABELS, type VideoClip } from "./types";

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

  test("every style a bar can carry is a style the tools can name", () => {
    // The picker groups are the Transitions tab's layout, and the sound
    // styles are picked elsewhere — so the id list is the groups plus them,
    // never the groups alone (the tool enum and the doc validator read it).
    for (const id of AUDIO_TRANSITION_STYLES) {
      expect(TRANSITION_STYLE_IDS).toContain(id);
      expect(TRANSITION_STYLE_GROUPS.flatMap((g) => g.ids)).not.toContain(id);
      expect(TRANSITION_STYLE_LABELS[id]).toBeTruthy();
      // A sound handover has no picture blend to fall back to on an open edge.
      expect(animStyleOfTransition(id)).toBeNull();
    }
    expect(new Set(TRANSITION_STYLE_IDS).size).toBe(TRANSITION_STYLE_IDS.length);
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

describe("contentRect", () => {
  // A vertical frame and a landscape source: the shape every phone shot has to
  // be framed into.
  const box = { x: 0, y: 0, w: 720, h: 1280 };
  const src = { w: 1920, h: 1080 };
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01);

  test("a fitted picture is centered, with margins", () => {
    const r = contentRect(box, src.w, src.h, false);
    near(r.w, 720);
    near(r.h, 405);
    near(r.x, 0);
    near(r.y, (1280 - 405) / 2);
  });

  test("a fitted picture ignores the pan on an axis with nothing to spare", () => {
    const r = contentRect(box, src.w, src.h, false, 1, -1, -1);
    near(r.x, 0);
    near(r.y, (1280 - 405) / 2);
  });

  test("a covering picture fills the box and crops the rest", () => {
    const r = contentRect(box, src.w, src.h, true);
    near(r.w, 1280 * (16 / 9));
    near(r.h, 1280);
    // Centered: the same slice hangs off each side.
    near(r.x, (720 - r.w) / 2);
  });

  test("panning a covering picture slides the box to the picture's edge", () => {
    const left = contentRect(box, src.w, src.h, true, 1, -1, 0);
    near(left.x, 0);
    const right = contentRect(box, src.w, src.h, true, 1, 1, 0);
    near(right.x, 720 - right.w);
  });

  test("zoom scales the picture about the box and starts cropping", () => {
    const r = contentRect(box, src.w, src.h, false, 2);
    near(r.w, 1440);
    near(r.h, 810);
    // Half the picture's width now hangs outside the box, evenly split.
    near(r.x, -360);
    // The short axis still fits, so it stays centered.
    near(r.y, (1280 - 810) / 2);
  });

  test("a zoomed pan reaches the picture's edge, matching the export crop", () => {
    const r = contentRect(box, src.w, src.h, false, 2, 1, 0);
    near(r.x, 720 - 1440);
  });
});

describe("clipCovers", () => {
  const base = { id: "c", assetId: "a", start: 0, in: 0, out: 4, muted: false };
  test("track 0 letterboxes until it is told to fill", () => {
    expect(clipCovers({ ...base, track: 0 } as VideoClip)).toBe(false);
    expect(clipCovers({ ...base, track: 0, fit: "fill" } as VideoClip)).toBe(true);
  });

  test("a full-frame upper track covers, a regioned one fits", () => {
    expect(clipCovers({ ...base, track: 1 } as VideoClip)).toBe(true);
    expect(
      clipCovers({ ...base, track: 1, frame: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } } as VideoClip)
    ).toBe(false);
  });
});
