import { describe, expect, test } from "bun:test";
import { TOUCH_FLOOR, touchAlpha, wandAlpha, type WandScratch } from "./touchMask";

/** A confidence field painted from rectangles: [x0, y0, x1, y1, conf]. */
function field(w: number, h: number, rects: [number, number, number, number, number][]) {
  const conf = new Float32Array(w * h);
  for (const [x0, y0, x1, y1, c] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) conf[y * w + x] = c;
  }
  return conf;
}

const opaque = (a: Uint8ClampedArray | null, x: number, y: number, w: number) =>
  !!a && a[y * w + x] > 128;

describe("touchAlpha", () => {
  test("keeps the touched blob and drops a disconnected one", () => {
    const conf = field(20, 10, [
      [1, 1, 6, 6, 0.95],
      [12, 1, 18, 6, 0.95],
    ]);
    const a = touchAlpha(conf, 20, 10, [{ x: 3 / 20, y: 3 / 10 }]);
    expect(opaque(a, 3, 3, 20)).toBe(true);
    expect(opaque(a, 14, 3, 20)).toBe(false);
  });

  test("a confident stroke sheds connected low-confidence bleed", () => {
    // The touched backdrop reads 0.95; the model bleeds 0.5 onto the
    // adjoining subject. The floor alone would keep the bleed.
    const conf = field(20, 10, [
      [0, 0, 10, 10, 0.95],
      [10, 0, 20, 10, 0.5],
    ]);
    const a = touchAlpha(conf, 20, 10, [{ x: 4 / 20, y: 5 / 10 }]);
    expect(opaque(a, 4, 5, 20)).toBe(true);
    expect(opaque(a, 15, 5, 20)).toBe(false);
  });

  test("a tap the model won't anchor returns null for the wand to take", () => {
    // The model put nothing on the touched spot but found an object nearby.
    const conf = field(20, 10, [[12, 1, 18, 6, 0.9]]);
    expect(touchAlpha(conf, 20, 10, [{ x: 2 / 20, y: 8 / 10 }])).toBeNull();
  });

  test("nothing above the floor registers as null", () => {
    const conf = field(20, 10, [[0, 0, 20, 10, TOUCH_FLOOR - 0.1]]);
    expect(touchAlpha(conf, 20, 10, [{ x: 0.5, y: 0.5 }])).toBeNull();
  });

  test("a stroke keeps its first-touch anchor as later samples drag the median down", () => {
    // The drag starts on a confident object and runs far into low-confidence
    // ground: the tier holds — the object stays picked — and the pick never
    // flips to the wand mid-stroke.
    const conf = field(20, 10, [
      [0, 0, 6, 10, 0.95],
      [6, 0, 20, 10, 0.2],
    ]);
    const a = touchAlpha(conf, 20, 10, [
      { x: 2 / 20, y: 5 / 10 },
      { x: 8 / 20, y: 5 / 10 },
      { x: 12 / 20, y: 5 / 10 },
      { x: 16 / 20, y: 5 / 10 },
    ]);
    expect(opaque(a, 2, 5, 20)).toBe(true);
    expect(opaque(a, 12, 5, 20)).toBe(false);
  });

  test("a scribble anchors on its median confidence", () => {
    // One stroke point grazes the 0.55 bleed; the median holds at 0.95 and
    // the bleed still drops.
    const conf = field(20, 10, [
      [0, 0, 10, 10, 0.95],
      [10, 0, 20, 10, 0.55],
    ]);
    const a = touchAlpha(conf, 20, 10, [
      { x: 3 / 20, y: 5 / 10 },
      { x: 5 / 20, y: 5 / 10 },
      { x: 11 / 20, y: 5 / 10 },
    ]);
    expect(opaque(a, 4, 5, 20)).toBe(true);
    expect(opaque(a, 16, 5, 20)).toBe(false);
  });
});

/** An rgba image painted per pixel. */
function image(w: number, h: number, colorAt: (x: number, y: number) => [number, number, number]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

describe("wandAlpha", () => {
  test("a flat region selects whole and stops at the boundary", () => {
    const rgba = image(24, 12, (x) => (x < 12 ? [20, 20, 40] : [180, 150, 130]));
    const a = wandAlpha(rgba, 24, 12, [{ x: 4 / 24, y: 6 / 12 }]);
    expect(opaque(a, 1, 1, 24)).toBe(true);
    expect(opaque(a, 10, 10, 24)).toBe(true);
    expect(opaque(a, 16, 6, 24)).toBe(false);
  });

  test("a smooth gradient stays on-signature, a strong edge does not", () => {
    const rgba = image(24, 12, (x) => (x < 12 ? [20 + x, 20 + x, 40] : [200, 60, 60]));
    const a = wandAlpha(rgba, 24, 12, [{ x: 2 / 24, y: 6 / 12 }]);
    expect(opaque(a, 11, 6, 24)).toBe(true);
    expect(opaque(a, 14, 6, 24)).toBe(false);
  });

  test("the same color across a wide bright gap stays out", () => {
    const rgba = image(30, 12, (x) => (x < 10 || x >= 20 ? [30, 30, 30] : [200, 200, 200]));
    const a = wandAlpha(rgba, 30, 12, [{ x: 5 / 30, y: 6 / 12 }]);
    expect(opaque(a, 8, 6, 30)).toBe(true);
    expect(opaque(a, 15, 6, 30)).toBe(false);
    expect(opaque(a, 25, 6, 30)).toBe(false);
  });

  test("thin off-signature grooves are bridged, the far side joins", () => {
    // A slatted wall: faces of 40 with 2px grooves of 8. One tap on a face
    // takes the grooves and the faces beyond them.
    const face = (x: number) => (x % 8 < 6 ? 40 : 8);
    const rgba = image(32, 12, (x) => [face(x), face(x), face(x)]);
    const a = wandAlpha(rgba, 32, 12, [{ x: 2 / 32, y: 6 / 12 }]);
    expect(opaque(a, 7, 6, 32)).toBe(true);
    expect(opaque(a, 20, 6, 32)).toBe(true);
    expect(opaque(a, 30, 6, 32)).toBe(true);
  });

  test("a scratch reuses the tone field across moves of one stroke", () => {
    const rgba = image(24, 12, (x) => (x < 12 ? [20, 20, 40] : [180, 150, 130]));
    const scratch: WandScratch = {};
    const first = wandAlpha(rgba, 24, 12, [{ x: 4 / 24, y: 6 / 12 }], scratch);
    const heldTone = scratch.tone;
    expect(heldTone).toBeDefined();
    const second = wandAlpha(
      rgba,
      24,
      12,
      [
        { x: 4 / 24, y: 6 / 12 },
        { x: 8 / 24, y: 6 / 12 },
      ],
      scratch
    );
    expect(scratch.tone).toBe(heldTone!);
    expect([...second!]).toEqual([...first!]);
  });

  test("a scribble across two tones adds both signatures", () => {
    const tone = (x: number) => (Math.floor(x / 6) % 2 === 0 ? 40 : 100);
    const rgba = image(24, 12, (x) => [tone(x), tone(x), tone(x)]);
    const tap = wandAlpha(rgba, 24, 12, [{ x: 3 / 24, y: 6 / 12 }]);
    expect(opaque(tap, 15, 6, 24)).toBe(false);
    const scribble = wandAlpha(rgba, 24, 12, [
      { x: 3 / 24, y: 6 / 12 },
      { x: 8 / 24, y: 6 / 12 },
    ]);
    expect(opaque(scribble, 15, 6, 24)).toBe(true);
  });
});
