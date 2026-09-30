import { describe, expect, test } from "bun:test";
import { freeItemName, itemName } from "./itemName";

describe("item names", () => {
  test("a rename is trimmed, capped, and never empty", () => {
    expect(itemName("  Intro  ")).toBe("Intro");
    expect(itemName("x".repeat(100))).toHaveLength(80);
    expect(() => itemName("   ")).toThrow();
  });
  test("a name another item holds is numbered the way an import is", () => {
    expect(freeItemName("clip.mp4", ["Clip.MP4", "clip-1.mp4"])).toBe("clip-2.mp4");
    expect(freeItemName("Brand Sans", ["brand sans"])).toBe("Brand Sans-1");
    expect(freeItemName("Intro", ["Outro"])).toBe("Intro");
  });
});
