import { beforeAll, describe, expect, test } from "bun:test";
import { evalOverlayFrame } from "@donkeycut/effects-kit";
import { SubjectMaskCompositor } from "./behindPass";
import { installSkiaRaster } from "./headless/skiaRaster";
import { createRasterCanvas } from "./raster";
import type { TextOverlay } from "./types";

/**
 * Elements behind the speaker disintegrate and crackle like the front path:
 * a moment of an exit or a zap hit is its own picture with the phase painted.
 */

const W = 540;
const H = 960;
const title: TextOverlay = {
  id: "soon",
  text: "SOON",
  start: 1,
  end: 4,
  x: 0.5,
  y: 0.5,
  size: 160,
  font: "sf",
  weight: 900,
  color: "#ffffff",
  plate: false,
  shadow: false,
  mask: { kind: "subject", invert: true } as TextOverlay["mask"],
  anim: { out: { style: "disintegrate", seconds: 0.6 }, hit: { style: "zap", at: 0.5, seconds: 0.6 } },
};

type Entry = { byWord: Map<number, CanvasImageSource> };
const pictures = (pass: SubjectMaskCompositor) =>
  [...(pass as unknown as { rasters: Map<string, Entry> }).rasters.get(title.id)!.byWord.values()];

/** White ink and blue arc pixels in a picture. */
function ink(picture: CanvasImageSource) {
  const c = createRasterCanvas(W, H) as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(picture, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let white = 0;
  let blue = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 120) continue;
    if (d[i] > 220 && d[i + 1] > 220 && d[i + 2] > 220) white++;
    else if (d[i + 2] > 180 && d[i] < 200) blue++;
  }
  return { white, blue };
}

/** The one picture the pass holds for the element at `tLocal`. */
async function pictureAt(tLocal: number) {
  const pass = new SubjectMaskCompositor();
  await pass.ready([title], W, H, [], title.start + tLocal);
  const all = pictures(pass);
  expect(all.length).toBe(1);
  const out = ink(all[0]);
  pass.dispose();
  return out;
}

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

describe("the behind pass paints phases", () => {
  test("a disintegrating moment eats the ink", async () => {
    const tLocal = 3 - 0.3 + 0.3 / 2;
    expect(evalOverlayFrame(title, tLocal).erode ?? 0).toBeGreaterThan(0.2);
    const rest = await pictureAt(1.5);
    const eaten = await pictureAt(tLocal);
    expect(eaten.white).toBeLessThan(rest.white * 0.85);
  });

  test("a zap moment crackles", async () => {
    const tLocal = 0.7;
    expect(evalOverlayFrame(title, tLocal).zap ?? 0).toBeGreaterThan(0);
    const rest = await pictureAt(1.5);
    const lit = await pictureAt(tLocal);
    expect(rest.blue).toBe(0);
    expect(lit.blue).toBeGreaterThan(50);
  });
});
