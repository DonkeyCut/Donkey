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

describe("settled channel", () => {
  // A "caption" lands on a static scene and stays: 1px rows of ink — thin
  // enough that every cell mean stays inside the global and action
  // tolerances, so only the settled channel can see it.
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
    expect(d.verdict).toBe("keep-settled");
    expect(d.globalDist).toBeLessThanOrEqual(8);
    expect(d.settledScore).toBeGreaterThan(d.settledGate!);
  });

  test("change still in flight waits for the settled state", () => {
    // The stroke keeps moving every frame; only the final state (nothing
    // after it to prove motion) can take a settled keep.
    const moving = (y: number) => paint(GRAY, [{ x: 24, y, w: 144, h: 1, color: BLACK }]);
    const r = select([paint(GRAY), moving(60), moving(90), moving(120)]);
    expect(r.decisions[1].verdict).toBe("drop");
    expect(r.decisions[2].verdict).toBe("drop");
    expect(r.decisions[3].verdict).toBe("keep-settled");
  });

  test("soft-contrast drift dies at the strict tolerance", () => {
    // A faint wash (Δ90: over the soft tolerance, under the strict 105) must
    // not take a frame — smoke and fades live there.
    const wash = paint(GRAY, [
      { x: 24, y: 150, w: 144, h: 1, color: [210, 210, 210] },
      { x: 24, y: 156, w: 144, h: 1, color: [210, 210, 210] },
      { x: 24, y: 162, w: 144, h: 1, color: [210, 210, 210] },
    ]);
    const r = select([paint(GRAY), paint(GRAY), wash, wash, wash]);
    expect(r.decisions[2].verdict).toBe("drop");
  });

  test("the cooldown delays a settled keep right after another", () => {
    const frames = [paint(GRAY), paint(GRAY), caption(BLACK), caption(BLACK)];
    // A second small settled change (a new white stroke) lands right after
    // the caption's keep.
    const second = paint(GRAY, [
      { x: 24, y: 150, w: 144, h: 1, color: BLACK },
      { x: 24, y: 156, w: 144, h: 1, color: BLACK },
      { x: 24, y: 162, w: 144, h: 1, color: BLACK },
      { x: 24, y: 30, w: 144, h: 1, color: WHITE },
    ]);
    const r = select([...frames, second, second, second]);
    // Judged against the raised gate, the immediate follow-up waits...
    expect(r.decisions[4].verdict).toBe("drop");
    expect(r.decisions[4].settledGate!).toBeGreaterThan(6.8);
    // ...and the state is kept once the gate decays back down.
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
