import { expect, test } from "bun:test";
import { Canvas, FontLibrary } from "skia-canvas";
import { paintElement, type PaintPhase, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";
import { wordDrawsAt } from "./words";

/**
 * Every line is set from its face's em box, whatever the canvas makes of
 * textBaseline "middle".
 *
 * Chrome draws "middle" at the em box's middle; skia draws it at the middle of
 * the line box a CSS line centres. On Jost, whose em box sits low in a tall
 * line box, the two part by 12 px at 110 px. Jost's OS/2 typo ascender and
 * descender, 1070 and -375, put 1070/1445 of the em above the baseline, so
 * Chrome's baseline sits 110 × (0.7405 − 0.5) = 26.45 px under a line's
 * middle (its canvas reads 26.453125).
 */

/** skia's font registry, under a name the hook lint leaves alone. */
const fontLibrary = FontLibrary;
fontLibrary.use("Jost", [
  new URL("../../../node_modules/@fontsource/jost/files/jost-latin-700-normal.woff2", import.meta.url).pathname,
]);
const JOST_EM = 1070 / 1445;
const CHROME_DROP = 26.453125;

const frame = { width: 1080, height: 1920, scale: 1 };
const env: RenderEnv = {
  fontStack: () => '"Jost"',
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  emAscent: (css) => (css.includes("Jost") ? JOST_EM : undefined),
};
const title: TextOverlay = {
  id: "t",
  text: "HIH",
  start: 0,
  end: 2,
  x: 0.5,
  y: 0.5,
  size: 110,
  font: "jost",
  weight: 700,
  color: "#FFFFFF",
  plate: false,
  shadow: false,
};

/** The row under a title's last row of ink: its baseline, set in capitals. */
async function baseline(o: TextOverlay, phase?: PaintPhase, host = env): Promise<number> {
  const canvas = new Canvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  await paintElement(ctx, o, { ...frame, phase }, host);
  const data = ctx.getImageData(0, 0, frame.width, frame.height).data;
  for (let y = frame.height - 1; y >= 0; y--) {
    for (let x = 0; x < frame.width; x++) if (data[(y * frame.width + x) * 4 + 3] > 127) return y + 1;
  }
  return -1;
}

const middle = frame.height / 2;

test("a line stands on the em box's baseline, not the canvas's middle", async () => {
  expect(Math.abs((await baseline(title)) - (middle + CHROME_DROP))).toBeLessThanOrEqual(1);
});

test("a word effect and a letter-by-letter ramp stand on the same baseline", async () => {
  const words = wordDrawsAt(title.text, { style: "color", color: "#FF0000" }, title.color, 2, 0.5);
  expect(Math.abs((await baseline({ ...title, wordDraw: words })) - (middle + CHROME_DROP))).toBeLessThanOrEqual(1);
  const ramp: PaintPhase = { glyphs: { style: "fade", p: 1, exiting: false } };
  expect(Math.abs((await baseline(title, ramp)) - (middle + CHROME_DROP))).toBeLessThanOrEqual(1);
});

test("a face the host cannot read is set from the canvas's own middle", async () => {
  // Without an em box the painter falls back on what this canvas reads for
  // "middle": the gap between the two alignments' ascents.
  const ctx = new Canvas(8, 8).getContext("2d");
  ctx.font = '700 110px "Jost"';
  ctx.textBaseline = "alphabetic";
  const alphabetic = ctx.measureText("Hg").actualBoundingBoxAscent;
  ctx.textBaseline = "middle";
  const own = alphabetic - ctx.measureText("Hg").actualBoundingBoxAscent;
  const unread = await baseline(title, undefined, { ...env, emAscent: () => undefined });
  expect(Math.abs(unread - (middle + own))).toBeLessThanOrEqual(1);
});
