import { describe, expect, test } from "bun:test";
import { EASE_IDS, easeAt, type EaseId } from "./ease";

describe("easeAt", () => {
  test("every curve starts at 0 and lands on 1", () => {
    for (const id of EASE_IDS) {
      expect(easeAt(id, 0)).toBeCloseTo(0, 9);
      expect(easeAt(id, 1)).toBeCloseTo(1, 9);
    }
  });

  // A stored document can carry a name the list does not have ("back.out"
  // from a hand-written template); its key moves at a constant rate.
  test("an unknown name moves linearly", () => {
    expect(easeAt("back.out" as EaseId, 0.25)).toBe(0.25);
    expect(easeAt("back.out" as EaseId, 1)).toBe(1);
  });
});
