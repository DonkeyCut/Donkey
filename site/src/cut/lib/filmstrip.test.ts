import { describe, expect, test } from "bun:test";
import {
  FILM_TILE_CAP,
  MIN_SUB_TILE_PX,
  pickThumbTimes,
  planFilmstrip,
  WANT_GRID_S,
} from "./filmstrip";

/** The user's case: a ~24s clip with fast scene cuts carries 12 pre-sampled
 * thumbs, one every ~2s. */
const DURATION = 23.66;
const THUMB_STEP = DURATION / 12;
const thumbs = Array.from({ length: 12 }, (_, i) => `thumb-${i}`);

/** A whole-clip box drawn at `pps`, its width following the zoom the way a
 * real clip's does. */
const plan = (over: Partial<Parameters<typeof planFilmstrip>[0]> = {}) =>
  planFilmstrip({
    thumbs,
    thumbStep: THUMB_STEP,
    duration: DURATION,
    aspect: 16 / 9,
    filmIn: 0,
    w: (over.duration ?? DURATION) * (over.pps ?? 60),
    pps: 60,
    speed: 1,
    tileH: 60,
    minTileW: 26,
    ...over,
  });

describe("planFilmstrip", () => {
  test("tiles cover the drawn width on a source-time grid", () => {
    const tiles = plan();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles[0].left).toBeLessThanOrEqual(0);
    const end = tiles[tiles.length - 1];
    expect(end.left + end.width).toBeGreaterThanOrEqual(DURATION * 60);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i].left).toBeCloseTo(tiles[i - 1].left + tiles[i - 1].width, 6);
    }
  });

  test("each tile shows the pre-sampled thumb nearest its own moment", () => {
    for (const t of plan()) {
      const idx = Number(t.src.slice("thumb-".length));
      const sampledAt = (idx + 0.5) * THUMB_STEP;
      // The end tiles overhang the source and clamp to the last thumb.
      const inSource = Math.min(t.srcT, DURATION);
      expect(Math.abs(sampledAt - inSource)).toBeLessThanOrEqual(THUMB_STEP / 2 + 1e-9);
    }
  });

  test("every tile asks for a capture at its own midpoint, at every zoom", () => {
    // Half the capture grid is the whole allowance: a capture pulled further
    // toward a tile's edge lands on the neighboring scene whenever a cut sits
    // inside the tile, and the strip flips a whole tile early.
    for (const pps of [30, 60, 120, 200, 300, 480, 800]) {
      const tiles = plan({ pps });
      for (const t of tiles) {
        if (t.wantT <= 0 || t.wantT >= DURATION - 0.05) continue;
        expect(Math.abs(t.wantT - t.srcT)).toBeLessThanOrEqual(WANT_GRID_S / 2 + 1e-9);
        expect(t.exact).toBe(false);
      }
    }
  });

  test("capture times land on fine-grid centers, clear of frame boundaries", () => {
    // Grid times keep cache keys stable while the strip scrolls, trims, and
    // re-plans; centers keep captures off the whole- and half-second moments
    // where scene cuts live, so a straddling tile stays on its midpoint's
    // side of the cut.
    for (const t of plan({ pps: 300 })) {
      if (t.wantT <= 0 || t.wantT >= DURATION - 0.05) continue;
      const cells = t.wantT / WANT_GRID_S - 0.5;
      expect(Math.abs(cells - Math.round(cells))).toBeLessThan(1e-6);
    }
  });

  test("a tile whose midpoint sits a hair before a cut stays before it", () => {
    // The regression the timeline showed: a midpoint at ~2.97 must capture
    // below 3.0, never at it — the frame at 3.0 is the next scene's first.
    const pps = 270; // stepT ≈ 0.396 puts a tile midpoint at ~2.972
    const nearCut = plan({ pps }).filter((t) => t.srcT > 2.95 && t.srcT < 3);
    expect(nearCut.length).toBeGreaterThan(0);
    for (const t of nearCut) expect(t.wantT!).toBeLessThan(3);
  });

  test("capture times stay inside the source", () => {
    for (const t of plan({ pps: 800 })) {
      expect(t.wantT!).toBeGreaterThanOrEqual(0);
      expect(t.wantT!).toBeLessThanOrEqual(DURATION - 0.05 + 1e-9);
    }
  });

  test("a captured frame replaces the thumb and marks the tile exact", () => {
    const tiles = plan({ pps: 300, exactFrame: (t) => (t < 12 ? `frame-${t.toFixed(3)}` : null) });
    for (const t of tiles) {
      if (t.wantT! < 12) {
        expect(t.exact).toBe(true);
        expect(t.src).toBe(`frame-${t.wantT!.toFixed(3)}`);
      } else {
        expect(t.exact).toBe(false);
        expect(t.src.startsWith("thumb-")).toBe(true);
      }
    }
  });

  test("a trimmed left edge keeps tiles on the same source grid", () => {
    const pps = 300;
    const whole = plan({ pps });
    const trimmed = plan({ pps, filmIn: 3.2, w: (DURATION - 3.2) * pps });
    const wholeTimes = new Set(whole.map((t) => t.srcT.toFixed(4)));
    for (const t of trimmed) expect(wholeTimes.has(t.srcT.toFixed(4))).toBe(true);
  });

  test("past the tile cap, tiles widen by whole cells and stay capped", () => {
    const tiles = plan({ pps: 800, duration: 600, w: 600 * 800, thumbStep: 600 / 24 });
    expect(tiles.length).toBeLessThanOrEqual(FILM_TILE_CAP + 1);
  });

  test("an empty strip plans nothing", () => {
    expect(plan({ thumbs: [] })).toEqual([]);
  });

  test("a scene cut becomes a tile edge, and each side captures its own scene", () => {
    const pps = 300;
    const cut = 3.0;
    const tiles = plan({ pps, cuts: [cut] });
    const edges = tiles.map((t) => t.left);
    expect(edges.some((x) => Math.abs(x - cut * pps) < 1e-6)).toBe(true);
    for (const t of tiles) {
      const a = t.left / pps;
      const b = (t.left + t.width) / pps;
      if (b <= cut + 1e-9) expect(t.wantT!).toBeLessThan(cut);
      if (a >= cut - 1e-9) expect(t.wantT!).toBeGreaterThan(cut);
    }
  });

  test("cut-aligned tiles still tile the strip without gaps", () => {
    const tiles = plan({ pps: 300, cuts: [1.7, 3.0, 9.13] });
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i].left).toBeCloseTo(tiles[i - 1].left + tiles[i - 1].width, 6);
    }
  });

  test("tiles between two cuts share one width", () => {
    const pps = 300;
    const tiles = plan({ pps, cuts: [3.0, 9.13] });
    const widthsIn = (lo: number, hi: number) =>
      tiles
        .filter((t) => t.left >= lo * pps - 1e-6 && t.left + t.width <= hi * pps + 1e-6)
        .map((t) => t.width);
    for (const ws of [widthsIn(0, 3), widthsIn(3, 9.13), widthsIn(9.13, DURATION)]) {
      expect(ws.length).toBeGreaterThan(1);
      for (const w of ws) expect(w).toBeCloseTo(ws[0], 6);
    }
  });

  test("cuts crowding the ends or each other merge instead of leaving slivers", () => {
    const pps = 300;
    const tiles = plan({ pps, cuts: [0.001, 3.0, 3.005, 23.659] });
    for (const t of tiles) expect(t.width).toBeGreaterThanOrEqual(MIN_SUB_TILE_PX - 1e-6);
    expect(tiles.map((t) => t.left).some((x) => Math.abs(x - 3.0 * pps) < 1e-6)).toBe(true);
  });

  test("zoomed out, cuts still become tile edges and each side captures its own scene", () => {
    // Fast-cut footage keeps its scenes visible at the widest zoom: a scene
    // shorter than the tile grid still gets its own tile and its own frame.
    const pps = 30;
    const cuts = [1.0, 3.0, 6.0, 9.0];
    const tiles = plan({ pps, cuts });
    const edges = tiles.map((t) => t.left);
    for (const c of cuts) expect(edges.some((x) => Math.abs(x - c * pps) < 1e-6)).toBe(true);
    for (const t of tiles) {
      const a = t.left / pps;
      const b = (t.left + t.width) / pps;
      for (const c of cuts) {
        if (b <= c + 1e-9) expect(t.wantT).toBeLessThan(c);
        else if (a >= c - 1e-9) expect(t.wantT).toBeGreaterThan(c);
      }
    }
  });

  test("no cuts leaves the plan unchanged", () => {
    expect(plan({ pps: 300, cuts: [] })).toEqual(plan({ pps: 300 }));
  });
});

describe("pickThumbTimes", () => {
  /** Probes every `at` seconds with scene cuts at the given times. */
  const probesWithCuts = (duration: number, at: number, cuts: number[]) => {
    const out = [];
    for (let t = at / 2; t < duration; t += at) {
      const cut = cuts.some((c) => t - at < c && c <= t);
      out.push({ t, cut });
    }
    return out;
  };

  test("no probes: every bucket grabs its midpoint", () => {
    const times = pickThumbTimes(12, 2, 24, []);
    times.forEach((t, k) => expect(t).toBeCloseTo(Math.min(24 - 0.05, (k + 0.5) * 2), 6));
  });

  test("no cuts: every bucket grabs near its midpoint", () => {
    const times = pickThumbTimes(12, 2, 24, probesWithCuts(24, 0.25, []));
    times.forEach((t, k) => {
      expect(Math.abs(t - (k + 0.5) * 2)).toBeLessThanOrEqual(0.25);
    });
  });

  test("a cut late in a bucket: the grab stays with the dominant scene", () => {
    // The regression the timeline showed: a scene cut at 3.0s inside the
    // bucket [2, 4) — most of the bucket is the first scene, so the thumb
    // must come from before the cut... with the cut at the bucket's own
    // 3/4 point, the run before it is the longer one.
    const times = pickThumbTimes(12, 2, 24, probesWithCuts(24, 0.25, [3.5]));
    const bucket1 = times[1]; // bucket [2, 4)
    expect(bucket1).toBeLessThan(3.5);
    expect(bucket1).toBeGreaterThanOrEqual(2);
  });

  test("a cut early in a bucket: the grab jumps past it", () => {
    const times = pickThumbTimes(12, 2, 24, probesWithCuts(24, 0.25, [2.5]));
    const bucket1 = times[1]; // bucket [2, 4): the scene after 2.5 owns it
    expect(bucket1).toBeGreaterThan(2.5);
    expect(bucket1).toBeLessThan(4);
  });

  test("grabs never land right on a cut", () => {
    const cuts = [3, 6, 9, 12, 15, 18, 21];
    const times = pickThumbTimes(12, 2, 24, probesWithCuts(24, 0.25, cuts));
    for (const t of times) {
      for (const c of cuts) expect(Math.abs(t - c)).toBeGreaterThan(0.1);
    }
  });

  test("grabs stay inside their own bucket, ascending", () => {
    const times = pickThumbTimes(12, 2, 24, probesWithCuts(24, 0.25, [1, 4.2, 17.9]));
    times.forEach((t, k) => {
      expect(t).toBeGreaterThanOrEqual(k * 2);
      expect(t).toBeLessThan((k + 1) * 2);
    });
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });
});
