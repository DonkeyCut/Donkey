import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { applyEffectToCanvas, burnAt, burnGradient, EFFECT_IDS, effectFilterLines, effectPreviewState, effectRecipe } from "./effects";

type Surface = HTMLCanvasElement;
const W = 36;
const H = 64;
const noGrain = () => null;

function black(): Surface {
  const c = new Canvas(W, H) as unknown as Surface;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, W, H);
  return c;
}

const pixel = (c: Surface, x: number, y: number) => Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);

describe("the light leak's burn course", () => {
  test("a light leak on its burn course draws the burn; drift and other effects keep their own", () => {
    expect(effectRecipe({ effect: "lightleak", leak: "burn" })).toBe("burn");
    expect(effectRecipe({ effect: "lightleak", leak: "drift" })).toBe("lightleak");
    expect(effectRecipe({ effect: "lightleak" })).toBe("lightleak");
    expect(effectRecipe({ effect: "flash", leak: "burn" })).toBe("flash");
    expect(EFFECT_IDS as string[]).not.toContain("burn");
  });
});

describe("the film burn's course", () => {
  test("it climbs from the bottom edge: the top is still clear while the bottom has caught", () => {
    const b = burnAt(0.1, 1, 1);
    const first = b.stops[0];
    const last = b.stops[b.stops.length - 1];
    expect(first.at).toBe(0);
    expect(last.at).toBe(1);
    expect(first.a).toBeGreaterThan(0.9);
    expect(last.a).toBe(0);
  });

  test("it covers the frame near white at the flare and hands the picture back by its end", () => {
    const flare = burnAt(0.45, 1, 1);
    expect(flare.stops.every((s) => s.a === 1)).toBe(true);
    expect(flare.stops[0].rgb[2]).toBeGreaterThan(150);
    expect(burnAt(1, 1, 1).alpha).toBe(0);
  });

  test("it plays across the element's own length", () => {
    expect(effectPreviewState("burn", 1, 0.9, undefined, undefined, 2).burn).toEqual(burnAt(0.9, 2, 1));
  });

  test("the CSS twin carries every stop the canvas draws", () => {
    const b = burnAt(0.15, 1, 1);
    const css = burnGradient(b);
    for (const s of b.stops) expect(css).toContain(`${(s.at * 100).toFixed(2)}%`);
  });
});

describe("the film burn on a frame", () => {
  test("mid-flare the whole frame is the burn's own color", () => {
    const c = black();
    applyEffectToCanvas(c, black(), "burn", 1, 0.45, noGrain, undefined, undefined, 1);
    for (const y of [1, H / 2, H - 2]) {
      const [r, g] = pixel(c, W / 2, y);
      expect(r).toBeGreaterThan(240);
      expect(g).toBeGreaterThan(200);
    }
  });

  test("early on the bottom has caught and the top still shows the picture", () => {
    const c = black();
    applyEffectToCanvas(c, black(), "burn", 1, 0.08, noGrain, undefined, undefined, 1);
    expect(pixel(c, W / 2, H - 2)[0]).toBeGreaterThan(200);
    expect(pixel(c, W / 2, 1)[0]).toBeLessThan(10);
  });
});

describe("the film burn in ffmpeg", () => {
  test("one geq of one size whatever the length, gated to the element", () => {
    const line = (d: number) => effectFilterLines("in", "out", "burn", 1, 2, 2 + d, 1080, 1920, "t")![0];
    expect(line(0.5).match(/geq=/g)!.length).toBe(1);
    expect(line(10).match(/geq=/g)!.length).toBe(1);
    expect(Math.abs(line(10).length - line(0.5).length)).toBeLessThan(40);
    expect(line(0.5)).toContain("enable='gte(t,2)*lt(t,2.5)'");
    expect(line(0.5).startsWith("[in]")).toBe(true);
    expect(line(0.5).endsWith("[out]")).toBe(true);
  });
});
