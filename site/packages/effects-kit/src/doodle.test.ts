import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { DOODLE_FPS, doodleBeat } from "./doodle";
import { evalOverlayFrame, isOverlayAnimated } from "./keys";
import { elementAtMoment, planAnimatedLayers, renderElementCanvas, renderOverlayFrames, type RenderEnv } from "./render";
import type { ShapeOverlay } from "./types";

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

// A doodle over the middle of a square frame for two seconds, in a red fill
// and a green ink.
const doodle: ShapeOverlay = {
  id: "d",
  kind: "shape",
  shape: "doodle",
  start: 1,
  end: 3,
  x: 0.5,
  y: 0.5,
  w: 0.6,
  h: 0.6,
  fill: "#ff0000",
  inks: ["#00ff00"],
};

const SIZE = 300;

/** The inked pixels of a picture: count, and how many fall outside the
 * doodle's box grown by 4%. */
function ink(c: HTMLCanvasElement): { n: number; outside: number; reds: number; greens: number } {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
  const lo = (0.5 - 0.3 - 0.04) * SIZE;
  const hi = (0.5 + 0.3 + 0.04) * SIZE;
  let n = 0;
  let outside = 0;
  let reds = 0;
  let greens = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) {
      continue;
    }
    n++;
    const x = (i / 4) % c.width;
    const y = Math.floor(i / 4 / c.width);
    if (x < lo || x > hi || y < lo || y > hi) {
      outside++;
    }
    if (d[i] > d[i + 1] + 60) {
      reds++;
    }
    if (d[i + 1] > d[i] + 60) {
      greens++;
    }
  }
  return { n, outside, reds, greens };
}

/** A picture's bytes, to compare two deals. */
const bytes = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.join(",");

describe("graffiti doodles", () => {
  test("a doodle is drawn through the per-frame path", () => {
    expect(isOverlayAnimated(doodle)).toBe(true);
    expect(isOverlayAnimated({ ...doodle, shape: "rect" })).toBe(false);
  });

  test("each beat paints one mark inside the box, the same in every render", async () => {
    const seen = new Set<string>();
    let reds = 0;
    let greens = 0;
    for (let beat = 0; beat < 12; beat++) {
      const a = await renderElementCanvas(doodle, SIZE, SIZE, env, { doodle: beat });
      const b = await renderElementCanvas(doodle, SIZE, SIZE, env, { doodle: beat });
      expect(bytes(a)).toBe(bytes(b));
      const m = ink(a);
      expect(m.n).toBeGreaterThan(80);
      expect(m.outside).toBe(0);
      reds += m.reds;
      greens += m.greens;
      seen.add(bytes(a));
    }
    // Every beat deals its own mark, in the fill and the inks both.
    expect(seen.size).toBe(12);
    expect(reds).toBeGreaterThan(0);
    expect(greens).toBeGreaterThan(0);
  });

  test("a tall box keeps marks inside and lets the upright ones stand its height", async () => {
    // A full 9:16 frame: some beat paints from near the top to near the bottom.
    const tall: ShapeOverlay = { ...doodle, w: 1, h: 1 };
    const [W, H] = [180, 320];
    let reach = 0;
    for (let beat = 0; beat < 40; beat++) {
      const c = await renderElementCanvas(tall, W, H, env, { doodle: beat });
      const d = c.getContext("2d")!.getImageData(0, 0, W, H).data;
      let top = H;
      let bottom = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] >= 40) {
          const y = Math.floor(i / 4 / W);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
      }
      reach = Math.max(reach, (bottom - top) / H);
    }
    expect(reach).toBeGreaterThan(0.6);
  });

  test("the paint stays see-through", async () => {
    // Over the beats, most inked pixels let the footage show through.
    let inked = 0;
    let solid = 0;
    for (let beat = 0; beat < 12; beat++) {
      const d = (await renderElementCanvas(doodle, SIZE, SIZE, env, { doodle: beat })).getContext("2d")!.getImageData(0, 0, SIZE, SIZE).data;
      for (let i = 3; i < d.length; i += 4) {
        if (d[i] >= 40) {
          inked++;
          solid += d[i] > 240 ? 1 : 0;
        }
      }
    }
    expect(solid / inked).toBeLessThan(0.5);
  });

  test("two doodles deal apart", async () => {
    const a = await renderElementCanvas(doodle, SIZE, SIZE, env, { doodle: 3 });
    const b = await renderElementCanvas({ ...doodle, id: "e" }, SIZE, SIZE, env, { doodle: 3 });
    expect(bytes(a)).not.toBe(bytes(b));
  });

  test("the canvas export cuts a window per beat, each drawn on its beat", () => {
    const layers = planAnimatedLayers(doodle, doodle.end);
    expect(layers.length).toBe(2 * DOODLE_FPS);
    layers.forEach((l, i) => {
      expect(l.phase?.doodle).toBe(i);
      expect(l.end - l.start).toBeCloseTo(1 / DOODLE_FPS, 6);
    });
  });

  test("the frame sequences deal on the same beats", async () => {
    const at = 0.73;
    const { phase } = elementAtMoment(doodle, at, evalOverlayFrame(doodle, at, 1));
    expect(phase?.doodle).toBe(doodleBeat(at));
    const set = await renderOverlayFrames(doodle, SIZE, SIZE, 30, env);
    // Thirty frames a second for two seconds, three frames to a beat.
    expect(set.entries.length).toBe(60);
    expect(set.images.length).toBe(60);
  });
});
