import { describe, expect, test } from "bun:test";
import { hullRing, sampleOf } from "./tracking";

/** A hand of 21 landmarks with the wrist and the thumb and index tips placed;
 * the rest sit on the wrist. */
const hand = (wrist: number, thumb: [number, number], index: [number, number]) => {
  const l = Array.from({ length: 21 }, () => ({ x: wrist, y: 0.6, z: 0, visibility: 1 }));
  l[4] = { x: thumb[0], y: thumb[1], z: 0, visibility: 1 };
  l[8] = { x: index[0], y: index[1], z: 0, visibility: 1 };
  return l;
};

describe("the window between the hands", () => {
  test("its corners are the four fingertips, the left index tip first", () => {
    const left = hand(0.3, [0.35, 0.55], [0.35, 0.45]);
    const right = hand(0.7, [0.65, 0.55], [0.65, 0.45]);
    const s = sampleOf("hands_gap", [right, left], 1, null)!;
    expect(s.outline[0]).toEqual({ x: 0.35, y: 0.45 });
    expect(s.outline).toHaveLength(4);
    expect(s.center.x).toBeCloseTo(0.5, 6);
  });

  test("needs both hands", () => {
    expect(sampleOf("hands_gap", [hand(0.3, [0.35, 0.55], [0.35, 0.45])], 1, null)).toBeNull();
  });
});

describe("hull rings", () => {
  test("resample a hull to the same corner count at even angles", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 0.5, y: 0.5 },
    ];
    const ring = hullRing(pts, 0)!;
    expect(ring).toHaveLength(24);
    // The first corner points straight up from the middle, onto the top edge.
    expect(ring[0].x).toBeCloseTo(0.5, 6);
    expect(ring[0].y).toBeCloseTo(0, 6);
  });
});
