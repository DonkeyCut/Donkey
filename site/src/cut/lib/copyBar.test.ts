import { describe, expect, test } from "bun:test";
import { copyBarShare } from "./copyBar";

describe("a template copy's bar", () => {
  test("never moves back as the copy goes from starting to counted", () => {
    // Before a count arrives the bar holds a sliver; the first count, 0 of
    // 11, must not draw it shorter than that.
    const steps = [copyBarShare(0, 0), copyBarShare(0, 11), copyBarShare(1, 11), copyBarShare(10, 11), copyBarShare(11, 11)];
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    }
    expect(steps[0]).toBeGreaterThan(0);
    expect(steps.at(-1)).toBe(1);
  });
});
