import { describe, expect, test } from "bun:test";

import { favoritesFirst, ownTemplatesPending, pageWindow, withFavorite } from "./templateGallery";

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

describe("favoritesFirst", () => {
  const id = (s: string) => s;

  test("starred items lead, the latest star first, the rest keep their order", () => {
    expect(favoritesFirst(["a", "b", "c", "d"], id, ["d", "b"])).toEqual(["d", "b", "a", "c"]);
  });

  test("no stars leaves the list as it was", () => {
    expect(favoritesFirst(["a", "b"], id, null)).toEqual(["a", "b"]);
    expect(favoritesFirst(["a", "b"], id, [])).toEqual(["a", "b"]);
  });

  test("a star on an item the list lacks changes nothing", () => {
    expect(favoritesFirst(["a", "b"], id, ["z", "b"])).toEqual(["b", "a"]);
  });
});

describe("withFavorite", () => {
  test("a new star leads and a removed one leaves the rest alone", () => {
    expect(withFavorite(["a"], "b", "add")).toEqual(["b", "a"]);
    expect(withFavorite(["b", "a"], "b", "remove")).toEqual(["a"]);
  });

  test("a star already there, or already gone, changes nothing", () => {
    expect(withFavorite(["b", "a"], "a", "add")).toEqual(["b", "a"]);
    expect(withFavorite(["a"], "z", "remove")).toEqual(["a"]);
  });

  test("taking back one failed star keeps a later one", () => {
    // A then B are starred; A's request fails and only A comes off.
    const both = withFavorite(withFavorite([], "a", "add"), "b", "add");
    expect(withFavorite(both, "a", "remove")).toEqual(["b"]);
  });
});

describe("ownTemplatesPending", () => {
  const read = { isPending: false };
  const reading = { isPending: true };

  test("waits while the gate has yet to say whether this Mac's shelf exists", () => {
    expect(ownTemplatesPending("unsettled", [read])).toBe(true);
  });

  test("waits while any shelf is still being read", () => {
    expect(ownTemplatesPending("settled", [read, reading])).toBe(true);
  });

  test("knows once the gate settled and every shelf answered", () => {
    expect(ownTemplatesPending("settled", [read, read])).toBe(false);
  });
});
