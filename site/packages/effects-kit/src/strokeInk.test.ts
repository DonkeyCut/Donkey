import { describe, expect, test } from "bun:test";
import { traceMatteContours } from "./strokeInk";

/** An alpha mask as ImageData, solid inside the listed boxes. */
function mask(w: number, h: number, boxes: { x0: number; y0: number; x1: number; y1: number }[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (const b of boxes)
    for (let y = b.y0; y < b.y1; y++)
      for (let x = b.x0; x < b.x1; x++) data[(y * w + x) * 4 + 3] = 255;
  return { width: w, height: h, data, colorSpace: "srgb" } as ImageData;
}

describe("matte contours", () => {
  test("a solid block traces one ring along its boundary", () => {
    const loops = traceMatteContours(mask(32, 32, [{ x0: 8, y0: 8, x1: 24, y1: 24 }]));
    expect(loops.length).toBe(1);
    const ring = loops[0];
    // Every traced point sits on the block's boundary, none inside.
    for (const p of ring) {
      expect(p.x).toBeGreaterThanOrEqual(8);
      expect(p.x).toBeLessThanOrEqual(23);
      expect(p.y).toBeGreaterThanOrEqual(8);
      expect(p.y).toBeLessThanOrEqual(23);
      const onEdge = p.x === 8 || p.x === 23 || p.y === 8 || p.y === 23;
      expect(onEdge).toBe(true);
    }
    // A 16×16 block's boundary ring is its perimeter minus the shared corners.
    expect(ring.length).toBe(60);
  });

  test("separate blobs come back as separate loops, largest first", () => {
    const loops = traceMatteContours(
      mask(48, 24, [
        { x0: 2, y0: 2, x1: 20, y1: 20 },
        { x0: 30, y0: 8, x1: 40, y1: 16 },
      ])
    );
    expect(loops.length).toBe(2);
    expect(loops[0].length).toBeGreaterThan(loops[1].length);
  });

  test("specks are dropped", () => {
    expect(traceMatteContours(mask(16, 16, [{ x0: 5, y0: 5, x1: 6, y1: 6 }]))).toEqual([]);
  });
});
