import { describe, expect, test } from "bun:test";
import { flatBackdropAlpha, keepLargestSubject } from "./cutout";

/** A picture with a flat backdrop and a solid block in the middle. */
function scene(
  w: number,
  h: number,
  bg: [number, number, number],
  subject: [number, number, number],
  box: { x0: number; y0: number; x1: number; y1: number },
  noise = 0
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1;
      const c = inside ? subject : bg;
      // Deterministic dither, so "a slightly noisy backdrop" is reproducible.
      const n = inside ? 0 : ((x * 7 + y * 13) % 3) * noise;
      const i = (y * w + x) * 4;
      data[i] = c[0] + n;
      data[i + 1] = c[1] + n;
      data[i + 2] = c[2] + n;
      data[i + 3] = 255;
    }
  }
  return data;
}

const at = (alpha: Float32Array, w: number, x: number, y: number) => alpha[y * w + x];

describe("flat backdrop knockout", () => {
  test("drops the backdrop and keeps the subject", () => {
    const w = 40;
    const h = 40;
    const data = scene(w, h, [208, 208, 208], [220, 120, 40], { x0: 12, y0: 12, x1: 28, y1: 28 });
    const alpha = flatBackdropAlpha(data, w, h)!;
    expect(alpha).not.toBe(null);
    expect(at(alpha, w, 1, 1)).toBe(0); // corner: backdrop
    expect(at(alpha, w, 20, 20)).toBe(1); // middle: subject
  });

  test("a light subject on a light backdrop survives, edge included", () => {
    // The case that matters for stickers: a white outline against a gray
    // sweep. A generous threshold would eat the outline and then the subject.
    const w = 40;
    const h = 40;
    const data = scene(w, h, [208, 208, 208], [255, 255, 255], { x0: 12, y0: 12, x1: 28, y1: 28 });
    const alpha = flatBackdropAlpha(data, w, h)!;
    expect(at(alpha, w, 20, 20)).toBe(1);
    expect(at(alpha, w, 12, 20)).toBe(1); // the outermost white pixel stays
    expect(at(alpha, w, 1, 20)).toBe(0);
  });

  test("backdrop-coloured pixels inside the subject are kept", () => {
    // The fill spreads from the border, so an enclosed pocket of backdrop
    // colour — a gray eye on a gray-free face — is never punched out.
    const w = 40;
    const h = 40;
    const data = scene(w, h, [40, 40, 40], [230, 90, 30], { x0: 8, y0: 8, x1: 32, y1: 32 });
    for (const [x, y] of [
      [19, 19],
      [19, 20],
      [20, 19],
      [20, 20],
    ]) {
      const i = (y * w + x) * 4;
      data[i] = 40;
      data[i + 1] = 40;
      data[i + 2] = 40;
    }
    const alpha = flatBackdropAlpha(data, w, h)!;
    expect(at(alpha, w, 20, 20)).toBe(1);
  });

  test("a noisy backdrop still reads as flat", () => {
    const w = 40;
    const h = 40;
    const data = scene(w, h, [200, 200, 200], [10, 90, 200], { x0: 14, y0: 14, x1: 26, y1: 26 }, 4);
    const alpha = flatBackdropAlpha(data, w, h)!;
    expect(alpha).not.toBe(null);
    expect(at(alpha, w, 1, 1)).toBeLessThan(0.5);
    expect(at(alpha, w, 20, 20)).toBe(1);
  });

  test("a backdrop that drifts across the frame is still one backdrop", () => {
    // What a generator actually paints when asked for a solid sweep: a slow
    // ramp corner to corner. Measured against one global colour the far side
    // reads as a subject; measured against the colour beside it, it does not.
    const w = 64;
    const h = 64;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const inside = x >= 24 && x < 40 && y >= 24 && y < 40;
        const ramp = 150 + Math.round(((x + y) / (w + h - 2)) * 70); // 150 → 220
        const i = (y * w + x) * 4;
        data[i] = inside ? 250 : ramp;
        data[i + 1] = inside ? 250 : ramp;
        data[i + 2] = inside ? 250 : ramp;
        data[i + 3] = 255;
      }
    }
    const alpha = flatBackdropAlpha(data, w, h)!;
    expect(alpha).not.toBe(null);
    expect(at(alpha, w, 1, 1)).toBe(0); // dark corner
    expect(at(alpha, w, w - 2, h - 2)).toBe(0); // light corner, 70 off the other
    expect(at(alpha, w, 32, 32)).toBe(1); // the subject survives both
  });

  test("no flat backdrop, no answer", () => {
    const w = 40;
    const h = 40;
    // A photograph's border wanders; the guess would be wrong, so it declines
    // and a real matte gets asked instead.
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = (i * 37) % 255;
      data[i * 4 + 1] = (i * 53) % 255;
      data[i * 4 + 2] = (i * 91) % 255;
      data[i * 4 + 3] = 255;
    }
    expect(flatBackdropAlpha(data, w, h) === null).toBe(true);
  });

  test("a picture that is all backdrop declines too", () => {
    const w = 24;
    const h = 24;
    const data = scene(w, h, [128, 128, 128], [128, 128, 128], { x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(flatBackdropAlpha(data, w, h) === null).toBe(true);
  });
});

/** A stand-in canvas: `keepLargestSubject` only ever reads and writes alpha. */
function alphaCanvas(w: number, h: number, opaque: (x: number, y: number) => boolean) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = opaque(x, y) ? 255 : 0;
    }
  }
  const image = { data, width: w, height: h };
  const ctx = {
    getImageData: () => image,
    putImageData: () => {},
  } as unknown as CanvasRenderingContext2D;
  const canvas = { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { canvas, alphaAt: (x: number, y: number) => data[(y * w + x) * 4 + 3] };
}

describe("keep the largest subject", () => {
  test("drops the strokes and specks around a sticker", () => {
    const w = 80;
    const h = 80;
    const body = (x: number, y: number) => x >= 24 && x < 56 && y >= 24 && y < 56;
    // A hairline stroke arcing past the body and a speck off in the corner —
    // what a generator scribbles around what it was asked for.
    const stroke = (x: number, y: number) => y === 12 && x >= 10 && x < 70;
    const speck = (x: number, y: number) => x >= 70 && x < 73 && y >= 70 && y < 73;
    const { canvas, alphaAt } = alphaCanvas(
      w,
      h,
      (x, y) => body(x, y) || stroke(x, y) || speck(x, y)
    );
    expect(keepLargestSubject(canvas)).toBe(true);
    expect(alphaAt(40, 40)).toBe(255); // the sticker stays
    expect(alphaAt(30, 12)).toBe(0); // the stroke goes
    expect(alphaAt(71, 71)).toBe(0); // the speck goes
  });

  test("a stroke touching the sticker goes with the rest", () => {
    // Erosion is what makes this separable: the thread is thinner than the
    // radius, so it parts from the body before the regions are counted.
    const w = 80;
    const h = 80;
    const body = (x: number, y: number) => x >= 20 && x < 60 && y >= 20 && y < 60;
    const tail = (x: number, y: number) => y === 40 && x >= 60 && x < 78;
    const { canvas, alphaAt } = alphaCanvas(w, h, (x, y) => body(x, y) || tail(x, y));
    expect(keepLargestSubject(canvas)).toBe(true);
    expect(alphaAt(40, 40)).toBe(255);
    expect(alphaAt(74, 40)).toBe(0);
  });

  test("one clean subject is left alone", () => {
    const w = 60;
    const h = 60;
    const { canvas, alphaAt } = alphaCanvas(
      w,
      h,
      (x, y) => x >= 15 && x < 45 && y >= 15 && y < 45
    );
    expect(keepLargestSubject(canvas)).toBe(false);
    expect(alphaAt(30, 30)).toBe(255);
    expect(alphaAt(16, 16)).toBe(255); // the true edge is never trimmed
  });

  test("an all-hairline picture is left alone", () => {
    // Nothing survives the erosion, so there is no body to judge strays
    // against; better to ship the matte as it came than to blank it.
    const w = 60;
    const h = 60;
    const { canvas, alphaAt } = alphaCanvas(w, h, (x, y) => y % 10 === 0 && x > 4 && x < 56);
    expect(keepLargestSubject(canvas)).toBe(false);
    expect(alphaAt(30, 10)).toBe(255);
  });
});
