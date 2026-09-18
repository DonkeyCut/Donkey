import { describe, expect, test } from "bun:test";

import { textSpots } from "./textPlace";
import { TEXT_GRID } from "./watch/signatures";

const FULL = { x: 0, y: 0, w: 1, h: 1 };

/** A frame whose edge energy sits only in the rows between `from` and `to`,
 * as fractions of the frame's height — a subject, a sign, a caption track. */
const busyRows = (from: number, to: number, energy = 60): Float32Array => {
  const g = new Float32Array(TEXT_GRID * TEXT_GRID);
  for (let row = Math.round(from * TEXT_GRID); row < Math.round(to * TEXT_GRID); row++)
    for (let col = 0; col < TEXT_GRID; col++) g[row * TEXT_GRID + col] = energy;
  return g;
};

describe("textSpots", () => {
  test("a card goes where the picture is quiet", () => {
    // Everything happens in the top third: a head and shoulders high in frame.
    const [best] = textSpots([busyRows(0, 1 / 3)], FULL);
    expect(best.y).toBeGreaterThanOrEqual(0.33);
    expect(best.clear).toBeGreaterThan(0.9);
  });

  test("footage with its own captions leaves that band alone", () => {
    // The source burns its own text across the lower third.
    const spots = textSpots([busyRows(2 / 3, 1)], FULL, 5);
    const lower = spots.find((s) => s.where.includes("lower third"))!;
    const top = spots.find((s) => s.where.includes("top third"))!;
    expect(top.clear).toBeGreaterThan(lower.clear);
    expect(spots[0].where).not.toContain("lower third");
  });

  test("a band is only as clear as the busiest frame of the stretch", () => {
    // Quiet at the bottom for most of the stretch, and busy there in one
    // frame. A card sits still while the picture moves, so that one frame
    // decides it.
    const spots = textSpots([busyRows(0, 1 / 3), busyRows(0, 1 / 3), busyRows(2 / 3, 1)], FULL, 5);
    const lower = spots.find((s) => s.where.includes("lower third"))!;
    expect(lower.clear).toBeLessThan(0.5);
  });

  test("every spot stays inside the safe area", () => {
    // A short-form frame keeps the phone's UI clear; nothing may reach into it.
    const safe = { x: 0.06, y: 0.12, w: 0.88, h: 0.66 };
    for (const spot of textSpots([busyRows(0, 0.2)], safe, 5)) {
      expect(spot.x).toBeGreaterThanOrEqual(safe.x);
      expect(spot.y).toBeGreaterThanOrEqual(safe.y - 0.001);
      expect(spot.x + spot.w).toBeLessThanOrEqual(safe.x + safe.w + 0.001);
      expect(spot.y + spot.h).toBeLessThanOrEqual(safe.y + safe.h + 0.001);
    }
  });

  test("with no frames measured the safe area is the whole answer", () => {
    const safe = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    expect(textSpots([], safe)).toEqual([{ ...safe, where: "anywhere inside the safe area", clear: 1 }]);
  });
});
