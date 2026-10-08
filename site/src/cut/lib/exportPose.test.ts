import { beforeAll, expect, test } from "bun:test";
import type { OverlayKey, ShapeOverlay } from "@donkeycut/effects-kit";
import { installSkiaRaster } from "./headless/skiaRaster";
import { renderProjectFrame } from "./exportRender";
import { createRasterCanvas, decodeRasterImage } from "./raster";
import { renderElementFrames } from "./textRender";
import type { ExportDoc } from "./renderSnapshot";

const size = { width: 320, height: 180 };

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const shape = (over: Partial<ShapeOverlay>, kf: Omit<OverlayKey, "t">): ShapeOverlay => ({
  id: "s", kind: "shape", shape: "rect", start: 0, end: 2,
  x: 0.5, y: 0.5, w: 0.5, h: 0.5, fill: "#ffffff",
  kf: [{ t: 0, ...kf }, { t: 2, ...kf }],
  ...over,
});

const docOf = (o: ShapeOverlay): ExportDoc => ({
  aspect: "16:9", assets: [], clips: [], audioClips: [], overlays: [o],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
});

type Alpha = (x: number, y: number) => number;

/** The element's alpha at one moment, through both renderers: the in-tab
 * export frame and the sampled frame sequence the ffmpeg path overlays. */
async function bothRenderers(o: ShapeOverlay, t: number): Promise<Alpha[]> {
  const frame = await renderProjectFrame(docOf(o), t, size, () => "");
  const fctx = frame.getContext("2d") as CanvasRenderingContext2D;
  const exported = fctx.getImageData(0, 0, size.width, size.height).data;
  frame.width = frame.height = 1;

  const frames = await renderElementFrames(o, size.width, size.height, 30);
  const image = await decodeRasterImage(frames.images[Math.min(frames.images.length - 1, Math.round(t * 30))]);
  expect(image).not.toBeNull();
  const sheet = createRasterCanvas(size.width, size.height);
  const sctx = sheet.getContext("2d") as CanvasRenderingContext2D;
  sctx.drawImage(image!.source, frames.x, frames.y);
  const sampled = sctx.getImageData(0, 0, size.width, size.height).data;
  sheet.width = sheet.height = 1;

  // The export composites over a black frame, so its ink reads as luma.
  return [
    (x, y) => exported[(y * size.width + x) * 4],
    (x, y) => sampled[(y * size.width + x) * 4 + 3],
  ];
}

// An element bigger than the frame, keyed down to fit: its ink past the
// frame edge must survive the shrink (no flat sides where the frame cut it).
test("a keyed-down oversize ellipse keeps its round sides", async () => {
  const o = shape({ shape: "ellipse", w: 1.6, h: 1.6 }, { x: 0.5, y: 0.5, scale: 0.4, rotation: 0, opacity: 1 });
  for (const alpha of await bothRenderers(o, 1)) {
    // 0.4 × 512 px wide: the rim sits 102 px right of center, so x 240 is
    // inside; a stamp cut at the frame edge would end at x 224.
    expect(alpha(240, 90)).toBeGreaterThan(200);
    expect(alpha(275, 90)).toBeLessThan(30);
  }
});

// scaleY squashes the height alone: a 90 px tall box keyed to 0.2 is 18 px.
test("scaleY squashes one axis", async () => {
  const o = shape({}, { x: 0.5, y: 0.5, scale: 1, scaleY: 0.2, rotation: 0, opacity: 1 });
  for (const alpha of await bothRenderers(o, 1)) {
    expect(alpha(160, 90)).toBeGreaterThan(200);
    expect(alpha(100, 90)).toBeGreaterThan(200);
    expect(alpha(160, 110)).toBeLessThan(30);
  }
});

// tiltX tips the top edge away: in perspective the top row draws narrower
// than the bottom one.
test("tiltX draws the box in perspective", async () => {
  const o = shape({ w: 0.6, h: 0.8 }, { x: 0.5, y: 0.5, scale: 1, rotation: 0, tiltX: 60, opacity: 1 });
  for (const alpha of await bothRenderers(o, 1)) {
    const width = (y: number) => {
      let n = 0;
      for (let x = 0; x < size.width; x++) {
        if (alpha(x, y) > 128) {
          n++;
        }
      }
      return n;
    };
    // Rows a quarter of the way in from each edge of the tipped box.
    const top = width(70);
    const bottom = width(110);
    expect(top).toBeGreaterThan(20);
    expect(bottom).toBeGreaterThan(top + 6);
    // Turned 60°, the 144 px tall box shows about half its height.
    expect(alpha(160, 30)).toBeLessThan(30);
  }
});

/** Where a point (x, y) px from the box center lands under CSS's
 * perspective(depth) rotateX(tx) rotateY(ty): turned about y, then about x,
 * then divided by the depth it sits at. */
function cssTilt(x: number, y: number, tx: number, ty: number, depth: number): [number, number] {
  const a = (tx * Math.PI) / 180;
  const b = (ty * Math.PI) / 180;
  const X = x * Math.cos(b);
  const Y = y * Math.cos(a) + x * Math.sin(a) * Math.sin(b);
  const Z = y * Math.sin(a) - x * Math.cos(a) * Math.sin(b);
  const f = depth / (depth - Z);
  return [160 + X * f, 90 + Y * f];
}

/** The keyed perspective at this test's 180 px short side. */
const DEPTH = (1600 * 180) / 1080;

// tiltY turns the right edge away, as CSS rotateY does: the right end of a
// tall box draws shorter than the left.
test("tiltY turns the right edge away", async () => {
  const o = shape({ w: 0.5, h: 0.6 }, { x: 0.5, y: 0.5, scale: 1, rotation: 0, tiltY: 50, opacity: 1 });
  for (const alpha of await bothRenderers(o, 1)) {
    const height = (x: number) => {
      let n = 0;
      for (let y = 0; y < size.height; y++) {
        if (alpha(x, y) > 128) {
          n++;
        }
      }
      return n;
    };
    const [left] = cssTilt(-60, 0, 0, 50, DEPTH);
    const [right] = cssTilt(60, 0, 0, 50, DEPTH);
    expect(height(Math.round(left))).toBeGreaterThan(height(Math.round(right)) + 10);

    // The top edge stays one straight line: neighboring columns start
    // within a pixel of each other, with no sawtooth between tiles.
    const top = (x: number) => {
      for (let y = 0; y < size.height; y++) {
        if (alpha(x, y) > 128) {
          return y;
        }
      }
      return -1;
    };
    for (let x = Math.round(left) + 1; x < Math.round(right); x++) {
      expect(Math.abs(top(x) - top(x - 1))).toBeLessThanOrEqual(1);
    }
  }
});

// Both tilts compose the way CSS does: turned about y first, a wide bar's
// ends sit at different depths, so turning it about x sends one end up and
// the other down — the bar runs diagonally.
test("tiltX and tiltY together tip a wide bar diagonally, as CSS composes them", async () => {
  const o = shape({ w: 0.8, h: 0.1 }, { x: 0.5, y: 0.5, scale: 1, rotation: 0, tiltX: 60, tiltY: 30, opacity: 1 });
  for (const alpha of await bothRenderers(o, 1)) {
    for (const x of [-100, -50, 50, 100]) {
      const [px, py] = cssTilt(x, 0, 60, 30, DEPTH);
      expect(alpha(Math.round(px), Math.round(py))).toBeGreaterThan(128);
      // The flat bar's row at that x stays clear.
      expect(alpha(Math.round(px), 90 + Math.sign(x) * -Math.round(Math.abs(py - 90)))).toBeLessThan(30);
    }
  }
});
