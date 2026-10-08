import { beforeAll, expect, test } from "bun:test";
import { installSkiaRaster } from "./headless/skiaRaster";
import { renderProjectFrame } from "./exportRender";
import { createRasterCanvas, decodeRasterImage } from "./raster";
import { renderElementFrames } from "./textRender";
import type { ExportDoc } from "./renderSnapshot";
import type { TextOverlay } from "./types";

/**
 * A typewriter types each letter where the whole title puts it: a centered
 * title half typed starts at the same left edge as the finished title.
 */

const size = { width: 540, height: 960 };

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const title: TextOverlay = {
  id: "t",
  text: "COMING SOON",
  start: 0,
  end: 3,
  x: 0.5,
  y: 0.5,
  size: 90,
  font: "archivo-black",
  weight: 400,
  color: "#ffffff",
  plate: false,
  shadow: false,
  anim: { in: { style: "typewriter", seconds: 1 } },
};

const doc: ExportDoc = {
  aspect: "9:16", assets: [], clips: [], audioClips: [], overlays: [title],
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
};

/** The leftmost and rightmost columns with ink on the title's middle band. */
function inkSpan(read: (x: number, y: number) => number): { left: number; right: number } {
  let left = size.width;
  let right = -1;
  for (let y = size.height / 2 - 20; y < size.height / 2 + 20; y++) {
    for (let x = 0; x < size.width; x++) {
      if (read(x, y) > 128) {
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
  }
  return { left, right };
}

/** The title's ink at `t` through the in-tab export frame. */
async function exported(t: number) {
  const frame = await renderProjectFrame(doc, t, size, () => "");
  const data = (frame.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, size.width, size.height).data;
  frame.width = frame.height = 1;
  return inkSpan((x, y) => data[(y * size.width + x) * 4]);
}

/** The title's ink at `t` through the sampled frames the ffmpeg path overlays. */
async function sampled(t: number) {
  const frames = await renderElementFrames(title, size.width, size.height, 30);
  let at = 0;
  let index = frames.entries[0].image;
  for (const e of frames.entries) {
    if (at > t + 1e-6) {
      break;
    }
    index = e.image;
    at += e.duration;
  }
  const image = await decodeRasterImage(frames.images[index]);
  const sheet = createRasterCanvas(size.width, size.height);
  const ctx = sheet.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(image!.source, frames.x, frames.y);
  const data = ctx.getImageData(0, 0, size.width, size.height).data;
  sheet.width = sheet.height = 1;
  return inkSpan((x, y) => data[(y * size.width + x) * 4 + 3]);
}

test("a half-typed centered title starts where the finished title starts", async () => {
  for (const read of [exported, sampled]) {
    const done = await read(2);
    const half = await read(0.5);
    expect(half.right).toBeLessThan(done.right - 60);
    expect(Math.abs(half.left - done.left)).toBeLessThanOrEqual(2);
  }
});
