import { expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { paintElement, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";
import { wordDrawsAt, wordFaceDraws } from "./words";

/**
 * A word set apart in its own face: the painter measures and fills it in that
 * face, the rest of the line in the line's, and the effect's accent still
 * blends from the word's own fill.
 */

const frame = { width: 1080, height: 1920, scale: 1 };
const env: RenderEnv = {
  fontStack: (id) => (id === "serif" ? "Georgia" : "Arial"),
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
};
const line: TextOverlay = {
  id: "t",
  text: "get Donkey free",
  start: 0,
  end: 2,
  x: 0.5,
  y: 0.5,
  size: 60,
  font: "sf",
  weight: 700,
  color: "#FFFFFF",
  plate: false,
  shadow: false,
};
const face = { font: "serif", italic: true, weight: 400 as const, color: "#FFFF00", scale: 1.2 };

test("each word is filled in its own face and color", async () => {
  const canvas = new Canvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  const fills: { text: string; font: string; color: string }[] = [];
  const fill = ctx.fillText.bind(ctx);
  ctx.fillText = (text: string, x: number, y: number) => {
    fills.push({ text, font: ctx.font, color: String(ctx.fillStyle) });
    fill(text, x, y);
  };
  const draws = wordFaceDraws(line.text, line.color, [undefined, face]);
  await paintElement(ctx, { ...line, wordDraw: draws }, frame, env);
  expect(fills.map((f) => f.text)).toEqual(["get", "Donkey", "free"]);
  expect(fills[0].font).toContain("Arial");
  expect(fills[0].font).not.toContain("italic");
  expect(fills[1].font).toContain("italic");
  expect(fills[1].font).toContain("Georgia");
  expect(fills[1].font).toContain("72px");
  expect(fills[1].color.toLowerCase()).toContain("ffff00");
  expect(fills[2].font).toBe(fills[0].font);
});

test("the accent blends from the face's color, and the face rides every pose", () => {
  const draws = wordDrawsAt("one two", { style: "color", color: "#FF0000" }, "#FFFFFF", 2, 0.1, [face]);
  expect(draws[0]).toMatchObject({ font: "serif", italic: true, weight: 400 });
  expect(draws[0].scale).toBeCloseTo(1.2);
  expect(draws[0].color.toLowerCase()).not.toBe("#ffff00"); // on its moment: the accent
  expect(draws[1].font).toBeUndefined();
  const rest = wordDrawsAt("one two", { style: "color", color: "#FF0000" }, "#FFFFFF", 2, 1.9, [face]);
  expect(rest[0].color.toLowerCase()).toBe("#ffff00");
});
