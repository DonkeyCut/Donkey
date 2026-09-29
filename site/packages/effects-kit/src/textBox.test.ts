import { expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { measureElementBounds, paintElement, textWrapRoom, wrapTextToRoom, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";

const frame = { width: 1080, height: 1920, scale: 1 };
const env: RenderEnv = { fontStack: () => "Arial", createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement };
const title: TextOverlay = { id: "title", text: "POV: refreshing GitHub until I get my 300th star", start: 0, end: 4, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 700, color: "#fff", plate: false, shadow: false };

test("narrowing the box wraps lines and grows height at the same font size", async () => {
  const wide = await measureElementBounds({ ...title, wrapWidth: 0.8 }, frame, env, { pad: false });
  const narrow = await measureElementBounds({ ...title, wrapWidth: 0.3 }, frame, env, { pad: false });
  expect(wide.w).toBeCloseTo(864);
  expect(narrow.w).toBeCloseTo(324);
  expect(narrow.h).toBeGreaterThan(wide.h);
});

test("stored glyph stretch no longer changes painting or bounds", async () => {
  const saved = { ...title, stretchX: 0.4, stretchY: 2 };
  expect(await measureElementBounds(saved, frame, env)).toEqual(await measureElementBounds(title, frame, env));
  const paint = async (o: TextOverlay) => {
    const canvas = new Canvas(frame.width, frame.height);
    await paintElement(canvas.getContext("2d") as unknown as CanvasRenderingContext2D, o, frame, env);
    return canvas.toBuffer("png");
  };
  expect(await paint(saved)).toEqual(await paint(title));
});

test("proportional scaling grows a wrapped box equally on both axes", async () => {
  const o = { ...title, wrapWidth: 0.35 };
  const before = await measureElementBounds(o, frame, env, { pad: false });
  const after = await measureElementBounds({ ...o, size: o.size * 2, wrapWidth: o.wrapWidth * 2 }, frame, env, { pad: false });
  expect(after.w / before.w).toBeCloseTo(2);
  expect(after.h / before.h).toBeCloseTo(2);
});

test("explicit wrapping width stays fixed when the box moves", () => {
  expect(textWrapRoom({ x: 0.02, wrapWidth: 0.4 }, 1080)).toBe(432);
  expect(textWrapRoom({ x: 0.5, wrapWidth: 0.4 }, 1080)).toBe(432);
  const wrap = (width: number) => wrapTextToRoom("one two three four", width, (line) => line.length * 10);
  expect(wrap(textWrapRoom({ x: 0.5, wrapWidth: 0.1 }, 1000))).toBe("one two\nthree four");
});
