import { beforeAll, describe, expect, test } from "bun:test";
import { CARET_BLINK_SECONDS, evalOverlayFrame } from "@donkeycut/effects-kit";
import { SubjectMaskCompositor } from "./behindPass";
import { installSkiaRaster } from "./headless/skiaRaster";
import { createRasterCanvas } from "./raster";
import type { TextOverlay } from "./types";

/**
 * Elements behind the speaker type their typewriter entrance and show its
 * caret, the same pictures the front path paints.
 */

const W = 540;
const H = 960;
const title: TextOverlay = {
  id: "cta",
  text: "LINK IN BIO",
  start: 2,
  end: 6,
  x: 0.5,
  y: 0.5,
  size: 80,
  font: "sf",
  weight: 700,
  color: "#ffffff",
  plate: false,
  shadow: false,
  mask: { kind: "subject", invert: true } as TextOverlay["mask"],
  anim: { in: { style: "typewriter", seconds: 1, caret: { blink: true, color: "#ff0000" } } },
};

type Entry = { byWord: Map<number, CanvasImageSource & { width: number; height: number }> };
const entryOf = (pass: SubjectMaskCompositor) =>
  (pass as unknown as { rasters: Map<string, Entry> }).rasters.get(title.id)!;

/** Ink in a picture: how many pixels are white, how many are the red bar,
 * and the rightmost column anything reaches. */
function ink(picture: CanvasImageSource) {
  const c = createRasterCanvas(W, H) as HTMLCanvasElement;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(picture, 0, 0, W, H);
  const d = ctx.getImageData(0, 0, W, H).data;
  let white = 0;
  let red = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    if (d[i] > 200 && d[i + 1] > 200) white++;
    else if (d[i] > 200 && d[i + 1] < 60) red++;
  }
  return { white, red };
}

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

describe("the behind pass types", () => {
  test("a typing moment is a typed picture with the bar lit", async () => {
    const pass = new SubjectMaskCompositor();
    const tLocal = 0.4;
    const ev = evalOverlayFrame(title, tLocal);
    expect(ev.textProgress).toBeLessThan(1);
    await pass.ready([title], W, H, [], title.start + tLocal);
    const typed = [...entryOf(pass).byWord].filter(([k]) => k < 0);
    expect(typed.length).toBe(1);
    const part = ink(typed[0][1]);
    await pass.ready([title], W, H, [], title.start + 0.95);
    const typedLater = [...entryOf(pass).byWord].filter(([k]) => k < 0);
    // One typing picture at a time, and it has typed further.
    expect(typedLater.length).toBe(1);
    const more = ink(typedLater[0][1]);
    expect(more.white).toBeGreaterThan(part.white);
    expect(part.red).toBeGreaterThan(0);
    pass.dispose();
  });

  test("after typing the bar blinks: lit and dark pictures of the whole text", async () => {
    const pass = new SubjectMaskCompositor();
    const after = title.start + 1;
    await pass.ready([title], W, H, [], after + CARET_BLINK_SECONDS * 0.5);
    await pass.ready([title], W, H, [], after + CARET_BLINK_SECONDS * 1.5);
    const whole = [...entryOf(pass).byWord].filter(([k]) => k >= 0);
    expect(whole.map(([k]) => k).sort()).toEqual([0, 1]);
    const dark = ink(whole.find(([k]) => k === 0)![1]);
    const lit = ink(whole.find(([k]) => k === 1)![1]);
    expect(dark.red).toBe(0);
    expect(lit.red).toBeGreaterThan(0);
    expect(lit.white).toBe(dark.white);
    // The typing picture is gone once the whole text lands.
    expect([...entryOf(pass).byWord.keys()].some((k) => k < 0)).toBe(false);
    pass.dispose();
  });

  test("the live pass paints each typed count once, and titles typing together take turns", async () => {
    const pass = new SubjectMaskCompositor();
    const painted: string[] = [];
    const inner = pass as unknown as { drawTyped: (o: TextOverlay, ...rest: unknown[]) => Promise<void> };
    const drawTyped = inner.drawTyped.bind(pass);
    inner.drawTyped = (o, ...rest) => {
      painted.push(o.id);
      return drawTyped(o, ...rest);
    };
    const second: TextOverlay = { ...title, id: "cta2", y: 0.7 };
    const frame = createRasterCanvas(W, H) as HTMLCanvasElement;
    const settle = () => new Promise((r) => setTimeout(r, 200));

    // The same moment asked for on two frames before its picture lands.
    pass.draw(frame, [title], [], title.start + 0.4);
    pass.draw(frame, [title], [], title.start + 0.4);
    await settle();
    expect(painted).toEqual([title.id]);

    // Two titles typing at once, each asking for a new count every frame.
    painted.length = 0;
    for (const t of [0.1, 0.2, 0.3, 0.5, 0.6, 0.7]) pass.draw(frame, [title, second], [], title.start + t);
    await settle();
    expect(painted).toContain(second.id);
    pass.dispose();
  });
});
