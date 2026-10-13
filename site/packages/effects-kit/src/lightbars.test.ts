import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { applyEffectToCanvas, EFFECT_IDS, effectFilterLines, effectPreviewState, lightbarBox, lightbarsAt } from "./effects";
import { TEST_FFMPEG } from "./testing/ffmpeg";

type Surface = HTMLCanvasElement;
const W = 192;
const H = 32;
const FPS = 30;
const DUR = 1;
const noGrain = () => null;

function black(): Surface {
  const c = new Canvas(W, H) as unknown as Surface;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  return c;
}

/** The bars drawn by the canvas pass over black, as one row of RGB. */
function canvasRow(tLocal: number): number[][] {
  const c = black();
  applyEffectToCanvas(c, black(), "lightbars", 1, tLocal, noGrain, undefined, undefined, DUR);
  const d = c.getContext("2d")!.getImageData(0, H / 2, W, 1).data;
  return Array.from({ length: W }, (_, x) => [d[x * 4], d[x * 4 + 1], d[x * 4 + 2]]);
}

const mean = (row: number[][], from: number, to: number, c: number) =>
  row.slice(from, to).reduce((s, p) => s + p[c], 0) / (to - from);

describe("the light bars' course", () => {
  test("they are a picture effect of their own", () => {
    expect(EFFECT_IDS as string[]).toContain("lightbars");
    expect(effectPreviewState("lightbars", 1, 0.9, undefined, undefined, 2).bars).toEqual(lightbarsAt(0.9, 2, 1));
  });

  test("they open as one narrow warm column just left of the middle", () => {
    const bars = lightbarsAt(0.02, DUR, 1);
    expect(bars.length).toBeGreaterThan(20);
    for (const b of bars) expect(Math.abs(b.x - 0.46)).toBeLessThan(0.05);
    const light = (c: number) => bars.reduce((s, b) => s + b.rgb[c] * b.alpha * b.w, 0);
    expect(light(0)).toBeGreaterThan(3 * light(2));
  });

  test("they burst out to fill the frame, warm on the left and cool on the right", () => {
    const bars = lightbarsAt(0.3, DUR, 1);
    expect(Math.min(...bars.map((b) => b.x))).toBeLessThan(0.1);
    expect(Math.max(...bars.map((b) => b.x))).toBeGreaterThan(0.9);
    const row = canvasRow(0.45);
    expect(mean(row, 0, W / 4, 0)).toBeGreaterThan(mean(row, 0, W / 4, 2));
    expect(mean(row, (3 * W) / 4, W, 2)).toBeGreaterThan(mean(row, (3 * W) / 4, W, 0));
  });

  test("deeper lines keep flowing out after the burst, the outer ones leaving first", () => {
    const xs = (u: number) => lightbarsAt(u, DUR, 1).map((b) => b.x);
    expect(Math.min(...xs(0.45))).toBeLessThan(0.15);
    expect(Math.max(...xs(0.45))).toBeGreaterThan(0.85);
    expect(lightbarsAt(0.45, DUR, 1).length).toBeGreaterThan(lightbarsAt(0.7, DUR, 1).length);
  });

  test("they close on the one red line, widening as it sweeps off the right edge", () => {
    const at = (u: number) => lightbarsAt(u, DUR, 1);
    expect(at(0.88).length).toBe(1);
    const [mid, late] = [at(0.88)[0], at(0.97)[0]];
    expect(mid.x).toBeGreaterThan(0.5);
    expect(mid.x).toBeLessThan(0.56);
    expect(late.x).toBeGreaterThan(mid.x + 0.1);
    expect(late.w).toBeGreaterThan(mid.w * 3);
    const row = canvasRow(0.88);
    const peak = row.reduce((best, p) => (p[0] > best[0] ? p : best));
    expect(peak[0]).toBeGreaterThan(200);
    expect(peak[1]).toBeLessThan(80);
    expect(peak[2]).toBeLessThan(80);
    expect(at(DUR)).toEqual([]);
  });

  test("the CSS twin places every bar where the canvas draws it, in a box of its own width", () => {
    for (const b of lightbarsAt(0.5, DUR, 1)) {
      const box = lightbarBox(b);
      const left = parseFloat(box.left) / 100;
      const width = parseFloat(box.width) / 100;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + width).toBeLessThanOrEqual(1 + 1e-9);
      expect(width).toBeLessThan(0.5);
      // The profile's peak stop lands on the bar's center.
      const stops = [...box.background.matchAll(/ (-?[\d.]+)%/g)].map((m) => Number(m[1]) / 100);
      expect(Math.abs(left + stops[3] * width - b.x)).toBeLessThan(1e-4);
    }
  });

  test("the canvas pass adds every bar in one composite, however many there are", () => {
    // Over a clear-edged layer each pass is a full-frame mask and draw; one
    // per bar was well over a hundred a frame at the burst.
    const c = black();
    const bars = lightbarsAt(0.3, DUR, 1).length;
    expect(bars).toBeGreaterThan(20);
    const ctx = c.getContext("2d")!;
    let draws = 0;
    const draw = ctx.drawImage.bind(ctx);
    ctx.drawImage = ((...args: Parameters<typeof draw>) => {
      draws++;
      return draw(...args);
    }) as typeof ctx.drawImage;
    applyEffectToCanvas(c, black(), "lightbars", 1, 0.3, noGrain, undefined, undefined, DUR, "keep");
    expect(draws).toBe(1);
  });
});

describe("the light bars in ffmpeg", () => {
  test("a few geqs drawing a single row between them, gated to the element", () => {
    const graph = effectFilterLines("in", "out", "lightbars", 1, 2, 3.6, 1920, 1080, "t")!.join(";");
    expect(graph.match(/geq=/g)!.length).toBeGreaterThan(1);
    expect(graph.match(/geq=/g)!.length).toBeLessThan(6);
    expect(graph.match(/crop=iw:1:0:0/g)!.length).toBe(1);
    expect(graph).toContain("enable='gte(t,2.000000)*lt(t,3.600000)'");
    expect(graph.startsWith("[in]")).toBe(true);
    expect(graph.endsWith("[out]")).toBe(true);
  });

  test("ffmpeg draws the bars the canvas draws", () => {
    const frames = [3, 9, 15, 22, 28];
    const chroma = { pixFmt: "yuv444p", overlay: ":format=yuv444" };
    const lines = effectFilterLines("in", "out", "lightbars", 1, 0, DUR, W, H, "t", undefined, undefined, chroma)!;
    const graph = `color=c=black:s=${W}x${H}:r=${FPS}:d=${DUR},format=yuv444p[in];${lines.join(";")}`;
    const run = spawnSync(TEST_FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {
      maxBuffer: 64 << 20,
    });
    expect(run.status).toBe(0);
    const out = run.stdout as Buffer;
    for (const f of frames) {
      const base = f * W * H * 3 + (H / 2) * W * 3;
      const ours = canvasRow(f / FPS);
      let diff = 0;
      for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) diff += Math.abs(out[base + x * 3 + c] - ours[x][c]);
      expect(diff / (W * 3)).toBeLessThan(6);
    }
  });
});
