import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { applyClipEffects, applyEffectToCanvas, type ClipEffect } from "./effects";

type Surface = HTMLCanvasElement;
const S = 64;

/** An opaque grey square in the middle of a transparent canvas — a logo. */
function logo(): Surface {
  const c = new Canvas(S, S) as unknown as Surface;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(16, 16, 32, 32);
  return c;
}
const scratch = () => new Canvas(S, S) as unknown as Surface;
const pixel = (c: Surface, x: number, y: number) => Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);
const noGrain = () => null;

describe("a clip's effects over a transparent picture", () => {
  for (const effect of ["vignette", "flash", "lightleak", "grain"] as const) {
    test(`${effect} paints the picture and leaves the clear corners clear`, () => {
      const c = logo();
      applyClipEffects(c, scratch(), [{ effect, amount: 1 }], 0, noGrain);
      expect(pixel(c, 2, 2)[3]).toBe(0);
      expect(pixel(c, S / 2, S / 2)[3]).toBe(255);
    });
  }
});

describe("filter effects in a row", () => {
  test("draw as one joined filter with the result of drawing each in turn", () => {
    const list: ClipEffect[] = [{ effect: "negative" }, { effect: "huecycle", amount: 0.5 }];
    const joined = logo();
    applyClipEffects(joined, scratch(), list, 0.4, noGrain);
    const each = logo();
    for (const e of list) applyEffectToCanvas(each, scratch(), e.effect, e.amount, 0.4, noGrain);
    const a = pixel(joined, S / 2, S / 2);
    const b = pixel(each, S / 2, S / 2);
    for (let i = 0; i < 4; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(2);
    expect(pixel(joined, 2, 2)[3]).toBe(0);
  });
});
