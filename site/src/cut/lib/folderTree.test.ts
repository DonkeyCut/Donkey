import { describe, expect, test } from "bun:test";
import { childrenOf, folderWithin, resolveParent, subtreeItems, subtreeOf, subtreeTotals } from "./folderTree";

// A shelf three deep, with a branch beside the one being deleted.
const folders = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
  { id: "d", parentId: "a" },
  { id: "e", parentId: null },
];

describe("what a folder delete takes", () => {
  test("the folder and everything filed under it, however deep", () => {
    expect(subtreeOf(folders, "a").sort()).toEqual(["a", "b", "c", "d"]);
    expect(subtreeOf(folders, "b")).toEqual(["b", "c"]);
  });

  test("a folder beside it is left standing", () => {
    expect(subtreeOf(folders, "a")).not.toContain("e");
    expect(subtreeOf(folders, "e")).toEqual(["e"]);
  });

  test("a loop two offline devices made is walked once", () => {
    const looped = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(subtreeOf(looped, "x").sort()).toEqual(["x", "y"]);
  });
});

describe("where a folder may file", () => {
  test("never under itself or anything inside it", () => {
    expect(folderWithin(folders, "c", "a")).toBe(true);
    expect(resolveParent(folders, "a", "c")).toBeNull();
    expect(resolveParent(folders, "d", "b")).toBe("b");
  });

  test("the top level lists only the folders filed there", () => {
    expect(childrenOf(folders, null).map((f) => f.id)).toEqual(["a", "e"]);
  });
});

describe("what a folder holds", () => {
  test("every item filed under it, however deep", () => {
    const items = [
      { id: 1, folderId: "a" },
      { id: 2, folderId: "c" },
      { id: 3, folderId: "d" },
      { id: 4, folderId: "e" },
      { id: 5, folderId: null },
      { id: 6 },
    ];
    expect(subtreeItems(folders, items, "a").map((i) => i.id)).toEqual([1, 2, 3]);
    expect(subtreeItems(folders, items, "b").map((i) => i.id)).toEqual([2]);
  });
});

describe("what every folder weighs", () => {
  test("each item counts toward its folder and every folder above it", () => {
    const items = [
      { folderId: "a", sizeBytes: 1 },
      { folderId: "c", sizeBytes: 10 },
      { folderId: "d", sizeBytes: 100 },
      { folderId: "e", sizeBytes: 1000 },
      { folderId: null, sizeBytes: 10000 },
    ];
    const totals = subtreeTotals(folders, items, (i) => i.sizeBytes);
    expect(Object.fromEntries(totals)).toEqual({ a: 111, b: 10, c: 10, d: 100, e: 1000 });
  });

  test("a loop two offline devices made counts each item once per folder", () => {
    const looped = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    const totals = subtreeTotals(looped, [{ folderId: "x", sizeBytes: 5 }], (i) => i.sizeBytes);
    expect(Object.fromEntries(totals)).toEqual({ x: 5, y: 5 });
  });
});
