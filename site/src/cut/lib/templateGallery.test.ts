import { describe, expect, test } from "bun:test";

import { pageWindow } from "./templateGallery";

describe("pageWindow", () => {
  test("a short run shows every page", () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3]);
  });

  test("a long run keeps the ends and the current page's neighbors", () => {
    expect(pageWindow(6, 10)).toEqual([1, null, 5, 6, 7, null, 10]);
    expect(pageWindow(1, 10)).toEqual([1, 2, null, 10]);
    expect(pageWindow(10, 10)).toEqual([1, null, 9, 10]);
  });

  test("a single skipped page still reads as a gap", () => {
    expect(pageWindow(4, 6)).toEqual([1, null, 3, 4, 5, 6]);
  });
});
