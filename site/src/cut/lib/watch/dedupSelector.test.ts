import { describe, expect, test } from "bun:test";

import { createDedupSelector } from "./dedupSelector";
import { frameSig, settledCellScores } from "./signatures";
import { type RgbFrame, SIGNATURE_SIZE } from "./types";

const S = SIGNATURE_SIZE;

/** A solid frame, optionally with painted rectangles. */
function paint(
  base: [number, number, number],
  rects: { x: number; y: number; w: number; h: number; color: [number, number, number] }[] = []
): RgbFrame {
  const data = new Uint8Array(S * S * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = base[0];
    data[i + 1] = base[1];
    data[i + 2] = base[2];
  }
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * S + x) * 3;
        data[i] = r.color[0];
        data[i + 1] = r.color[1];
        data[i + 2] = r.color[2];
      }
    }
  }
  return { width: S, height: S, channels: 3, data };
}

function select(frames: RgbFrame[], maxFrames = 36) {
  const sel = createDedupSelector({ maxFrames });
  for (const f of frames) sel.push(f);
  return sel.finish();
}

const GRAY: [number, number, number] = [120, 120, 120];
const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [10, 10, 10];

describe("global channel", () => {
  test("an identical stream keeps only the first frame", () => {
    const r = select(Array.from({ length: 10 }, () => paint(GRAY)));
    expect(r.kept).toEqual([0]);
    expect(r.decisions[0].verdict).toBe("first");
    expect(r.decisions.slice(1, -1).every((d) => d.verdict === "drop")).toBe(true);
    expect(r.candidateCount).toBe(10);
  });

  test("a hard cut keeps the new shot", () => {
    const r = select([paint(BLACK), paint(BLACK), paint(WHITE), paint(WHITE)]);
    expect(r.kept).toEqual([0, 2]);
    expect(r.decisions[2].verdict).toBe("keep-global");
  });

  test("the window blocks A-B-A alternation", () => {
    const a = () => paint(BLACK);
    const b = () => paint(WHITE);
    const r = select([a(), b(), a(), b(), a()]);
    // Both shots enter once; their reappearances match the kept window.
    expect(r.kept).toEqual([0, 1]);
  });
});

describe("action channel", () => {
  test("a small hard-moving subject keeps its frames", () => {
    // A 12px dot crossing a static scene: ~0.4% of pixels, far under the
    // global threshold, but hard change in a few 32-grid cells.
    const dot = (x: number) =>
      paint(GRAY, [{ x, y: 90, w: 12, h: 12, color: BLACK }]);
    const r = select([dot(20), dot(80), dot(140)]);
    expect(r.kept).toEqual([0, 1, 2]);
    expect(r.decisions[1].verdict).toBe("keep-action");
  });
});

describe("text channel", () => {
  // A "caption" lands on a static scene and stays: 1px rows of ink — thin
  // enough that every cell mean stays inside the global and action
  // tolerances, so only a local channel can see it at all.
  const caption = (color: [number, number, number]) =>
    paint(GRAY, [
      { x: 24, y: 150, w: 144, h: 1, color },
      { x: 24, y: 156, w: 144, h: 1, color },
      { x: 24, y: 162, w: 144, h: 1, color },
    ]);

  test("a caption appearing on a static scene is kept", () => {
    const r = select([paint(GRAY), paint(GRAY), caption(BLACK), caption(BLACK), caption(BLACK)]);
    expect(r.kept.includes(2)).toBe(true);
    const d = r.decisions[2];
    expect(d.verdict).toBe("keep-text");
    expect(d.globalDist).toBeLessThanOrEqual(8);
  });

  test("the last candidate of a pass gets no text keep", () => {
    // The settle test needs a frame after this one. Without it, motion caught
    // mid-stride reads as a state that landed, which is what the channel is
    // built to reject — so the pass ends and the settled channel judges it.
    const r = select([paint(GRAY), paint(GRAY), caption(BLACK)]);
    expect(r.decisions[2].verdict).not.toBe("keep-text");
  });

  // The reason this channel exists. A caption whose colour sits near its
  // ground — white type over a cream wall, a light serif over a white dress —
  // moves no cell mean worth the name, and a channel that tests contrast
  // cannot see it. Edge energy reads it by its strokes, so it lands the same
  // as ink on paper.
  test("a low-contrast caption is kept like any other", () => {
    const pale: [number, number, number] = [150, 150, 150]; // Δ30 on GRAY
    const r = select([paint(GRAY), paint(GRAY), caption(pale), caption(pale), caption(pale)]);
    expect(r.decisions[2].verdict).toBe("keep-text");
  });

  test("change still in flight waits for the settled state", () => {
    // The stroke keeps moving every frame; only the final state (nothing
    // after it to prove motion) can take a keep.
    const moving = (y: number) => paint(GRAY, [{ x: 24, y, w: 144, h: 1, color: BLACK }]);
    const r = select([paint(GRAY), moving(60), moving(90), moving(120)]);
    expect(r.decisions[1].verdict).toBe("drop");
    expect(r.decisions[2].verdict).toBe("drop");
    expect(r.decisions[3].verdict).not.toBe("drop");
  });

  test("a mark too narrow to be a line of type is left to the settled channel", () => {
    // A blob one cell across has no run behind it: an eye, a mouth, a cursor.
    const blob = paint(GRAY, [{ x: 100, y: 100, w: 6, h: 6, color: BLACK }]);
    const r = select([paint(GRAY), paint(GRAY), blob, blob, blob]);
    expect(r.decisions[2].verdict).toBe("keep-settled");
  });

  test("a wash across the whole frame is not type", () => {
    // A fade moves most of the grid at once. Locality is what separates a
    // caption from the light changing, and the global channel owns the rest.
    const wash = (v: number) =>
      paint(GRAY, [{ x: 0, y: 0, w: S, h: S, color: [v, v, v] }]);
    const r = select([paint(GRAY), wash(126), wash(132), wash(138), wash(144)]);
    expect(r.decisions.slice(1).some((d) => d.verdict === "keep-text")).toBe(false);
  });

  test("every state of a caption track is kept", () => {
    // What the channel is for: a line swaps, holds, swaps again, and each
    // state comes back as its own frame. A track read one state short is a
    // line of the source nobody can quote.
    const ys = [30, 30, 60, 60, 90, 90, 120, 120, 150, 150];
    const r = select([
      paint(GRAY),
      ...ys.map((y) => paint(GRAY, [{ x: 24, y, w: 144, h: 1, color: BLACK }])),
      paint(GRAY),
    ]);
    expect(r.decisions.filter((d) => d.verdict === "keep-text").length).toBe(5);
  });

  test("a second state landing on the next frame waits for the bar to fall", () => {
    // Each keep raises the tolerance, so a fainter change arriving right
    // behind one does not take a frame of its own until the bar decays.
    const line = (y: number, color: [number, number, number]) =>
      paint(GRAY, [{ x: 24, y, w: 144, h: 1, color }]);
    const r = select([
      paint(GRAY),
      line(30, BLACK),
      line(30, BLACK),
      paint(GRAY, [
        { x: 24, y: 30, w: 144, h: 1, color: BLACK },
        { x: 24, y: 150, w: 144, h: 1, color: [150, 150, 150] },
      ]),
      paint(GRAY, [
        { x: 24, y: 30, w: 144, h: 1, color: BLACK },
        { x: 24, y: 150, w: 144, h: 1, color: [150, 150, 150] },
      ]),
      paint(GRAY),
    ]);
    expect(r.decisions[1].verdict).toBe("keep-text");
    expect(r.decisions[2].verdict).toBe("drop");
  });
});

describe("settled channel", () => {
  // A settled change that is not a line: thin ink, a cursor, a UI dot.
  const mark = (color: [number, number, number], y = 100) =>
    paint(GRAY, [{ x: 100, y, w: 6, h: 6, color }]);

  test("soft-contrast drift dies at the strict tolerance", () => {
    // A faint blob (Δ90: over the soft tolerance, under the strict 105) must
    // not take a frame — smoke and fades live there.
    const r = select([paint(GRAY), paint(GRAY), mark([210, 210, 210]), mark([210, 210, 210])]);
    expect(r.decisions[2].verdict).toBe("drop");
  });

  test("the cooldown delays a settled keep right after another", () => {
    // A second, slighter mark lands one frame behind the first. Judged against
    // the raised gate it waits; once the gate decays it takes its frame. This
    // is what stops sustained settling motion from keeping every candidate.
    const first = mark(BLACK);
    const both = paint(GRAY, [
      { x: 100, y: 100, w: 6, h: 6, color: BLACK },
      { x: 100, y: 30, w: 3, h: 4, color: WHITE },
    ]);
    const r = select([paint(GRAY), paint(GRAY), first, first, both, both, both]);
    expect(r.decisions[2].verdict).toBe("keep-settled");
    expect(r.decisions[4].verdict).toBe("drop");
    expect(r.decisions[4].settledScore!).toBeLessThan(r.decisions[4].settledGate!);
    expect(r.decisions[4].settledGate!).toBeGreaterThan(6.8);
    expect(r.decisions[5].verdict).toBe("keep-settled");
  });
});

describe("cap thinning", () => {
  test("survivors thin evenly and are marked", () => {
    // 12 hard cuts alternating far-apart colors in distinct positions.
    const frames = Array.from({ length: 12 }, (_, i) =>
      paint(i % 2 === 0 ? BLACK : WHITE, [
        { x: (i * 13) % 150, y: 8, w: 30, h: 30, color: [200, 40, 40] },
      ])
    );
    const r = select(frames, 4);
    expect(r.kept.length).toBe(4);
    expect(r.kept[0]).toBe(0);
    const thinned = r.decisions.filter((d) => d.verdict === "thinned");
    expect(thinned.length).toBeGreaterThan(0);
  });
});

describe("streaming contract", () => {
  test("decisions stream one frame behind push and flush on finish", () => {
    const seen: number[] = [];
    const sel = createDedupSelector({ maxFrames: 36, onDecision: (d) => seen.push(d.index) });
    sel.push(paint(BLACK));
    expect(seen).toEqual([]);
    sel.push(paint(WHITE));
    expect(seen).toEqual([0]);
    sel.finish();
    expect(seen).toEqual([0, 1]);
  });

  test("RGB and RGBA inputs agree", () => {
    const rgb = paint(GRAY, [{ x: 10, y: 10, w: 40, h: 40, color: BLACK }]);
    const rgba = new Uint8ClampedArray(S * S * 4);
    for (let p = 0, i = 0, o = 0; p < S * S; p++, i += 3, o += 4) {
      rgba[o] = rgb.data[i];
      rgba[o + 1] = rgb.data[i + 1];
      rgba[o + 2] = rgb.data[i + 2];
      rgba[o + 3] = 255;
    }
    const a = frameSig(rgb);
    const b = frameSig({ width: S, height: S, channels: 4, data: rgba });
    expect(Array.from(a.fine)).toEqual(Array.from(b.fine));
    expect(Array.from(a.g16)).toEqual(Array.from(b.g16));
  });

  test("the shift tolerance absorbs a one-pixel jitter", () => {
    const a = paint(GRAY, [{ x: 40, y: 40, w: 50, h: 50, color: BLACK }]);
    const b = paint(GRAY, [{ x: 41, y: 40, w: 50, h: 50, color: BLACK }]);
    const scores = settledCellScores(frameSig(b).fine, [frameSig(a).fine], null, 80);
    expect(Math.max(...scores)).toBe(0);
  });
});
