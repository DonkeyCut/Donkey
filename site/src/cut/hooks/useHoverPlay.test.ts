import { describe, expect, test } from "bun:test";

import { isRealHover } from "./useHoverPlay";

const MOVE = { pointerType: "mouse", movementX: 3, movementY: 0 } as const;

describe("isRealHover", () => {
  test("a moving mouse over a focused page plays", () => {
    expect(isRealHover(MOVE, true)).toBe(true);
  });

  test("a pointer crossing an unfocused window stays still", () => {
    expect(isRealHover(MOVE, false)).toBe(false);
  });

  test("a tile sliding under a parked pointer stays still", () => {
    expect(isRealHover({ ...MOVE, movementX: 0, movementY: 0 }, true)).toBe(false);
  });

  test("a touch stays still", () => {
    expect(isRealHover({ ...MOVE, pointerType: "touch" }, true)).toBe(false);
  });
});
