import { describe, expect, test } from "bun:test";
import { refFromLibrary } from "./assetRef";
import { refsToParts } from "./refMedia";
import type { LibraryAsset } from "./library";

const row = (a: Pick<LibraryAsset, "id" | "fileName" | "type"> & Partial<LibraryAsset>): LibraryAsset => ({
  name: a.fileName,
  duration: 0,
  addedAt: 1,
  residency: "cloud",
  ...a,
});

describe("Library files in chat references", () => {
  test("a LUT file reaches the model as the set_color_lut call that uses it", async () => {
    const ref = refFromLibrary(row({ id: "l1", fileName: "Teal.cube", name: "Teal", type: "lut", contentKey: "abc123" }));
    expect(ref.use).toEqual({ noun: "LUT file", tool: "set_color_lut", args: { lut: "lut:abc123" } });
    expect(ref.fileType).toBe("lut");
    const { parts, visuals } = await refsToParts([ref]);
    expect(visuals).toHaveLength(0);
    expect(parts).toEqual([
      { text: 'Referenced LUT file "Teal" in the Library. Use it with set_color_lut: {"lut":"lut:abc123"}' },
    ]);
  });

  test("a LUT row with no content key has no id to hand chat", () => {
    expect(refFromLibrary(row({ id: "l2", fileName: "old.cube", type: "lut" })).use).toBeUndefined();
  });
});
