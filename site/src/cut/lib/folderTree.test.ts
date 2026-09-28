import { describe, expect, test } from "bun:test";
import { childrenOf, folderWithin, resolveParent, subtreeOf } from "./folderTree";

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
