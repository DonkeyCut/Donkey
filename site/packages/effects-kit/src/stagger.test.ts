import { describe, expect, test } from "bun:test";
import { edgeStagger, evalOverlayAnim, glyphStateAt } from "./anim";

// A six-letter title dropping in over 1.6s.
const LETTERS = 6;

/** The moment letter `i` first moves off its start pose, in seconds. */
function firstMove(stagger: number | undefined, i: number): number {
  const anim = { in: { style: "drop" as const, seconds: 1.6, ...(stagger !== undefined ? { stagger } : {}) } };
  for (let t = 0; t <= 1.6; t += 1 / 120) {
    const g = glyphStateAt(evalOverlayAnim(anim, t, 4, true), i, LETTERS);
    if (g.alpha > 0.001) {
      return t;
    }
  }
  return Infinity;
}

describe("an edge's letter hand-off", () => {
  test("the slot's stagger spaces the letters evenly across its share of the ramp", () => {
    // At 0.8 the hand-off takes 1.28s: a letter every 0.256s.
    const starts = [...Array(LETTERS).keys()].map((i) => firstMove(0.8, i));
    for (let i = 1; i < LETTERS; i++) {
      expect(starts[i] - starts[i - 1]).toBeCloseTo(0.256, 1);
    }
  });

  test("absent, the style's own spread plays", () => {
    expect(edgeStagger({ style: "drop", seconds: 1 })).toBe(0.6);
    expect(edgeStagger({ style: "drop", seconds: 1, stagger: 0.2 })).toBe(0.2);
    expect(edgeStagger({ style: "fade", seconds: 1 })).toBeUndefined();
    expect(firstMove(undefined, 5)).toBeCloseTo(0.96, 1);
  });
});
