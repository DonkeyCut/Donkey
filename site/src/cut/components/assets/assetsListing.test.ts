import { describe, expect, test } from "bun:test";
import type { LibraryAsset, LibraryData, LibraryFolder, LibraryTemplateItem } from "@/cut/lib/library";
import type { ProjectSummary } from "@/cut/lib/types";
import { assetEntries, cardArea, cardBox, entryOnTab, folderItemCount, mergeFolders, nameMatches } from "./assetsListing";

const folder = (id: string, residency: LibraryFolder["residency"] = "cloud"): LibraryFolder => ({
  id,
  name: id,
  parentId: null,
  createdAt: 1,
  residency,
});

const asset = (id: string, type: LibraryAsset["type"], addedAt: number): LibraryAsset =>
  ({ id, fileName: `${id}.bin`, name: id, type, duration: 1, addedAt, residency: "cloud" }) as LibraryAsset;

const project = (id: string, updatedAt: number, extra: Partial<ProjectSummary> = {}): ProjectSummary =>
  ({ id, name: id, createdAt: 0, updatedAt, duration: 1, ...extra }) as ProjectSummary;

const template = (id: string, addedAt: number): LibraryTemplateItem =>
  ({ id, name: id, addedAt, duration: 1, media: [], layers: [], audio: [], texts: [], cues: [], residency: "cloud" }) as LibraryTemplateItem;

describe("Assets listing", () => {
  test("library folders are the tree; an old engine's project folders join it once", () => {
    const merged = mergeFolders([folder("a"), folder("b", "local")], [
      { residency: "local", projects: [], folders: [{ id: "b", name: "b", createdAt: 1 }, { id: "p", name: "p", createdAt: 1 }] },
    ]);

    expect(merged.map((f) => [f.id, f.store, f.residency])).toEqual([
      ["a", "library", "cloud"],
      ["b", "library", "local"],
      ["p", "projects", "local"],
    ]);
  });

  test("projects, files and templates share one list, newest first, templates-as-projects left out", () => {
    const library: LibraryData = { assets: [asset("clip", "video", 30)], folders: [], templates: [template("tpl", 10)] };
    const shelves = [{ residency: "cloud" as const, folders: [], projects: [project("p1", 20), project("t1", 99, { kind: "template" })] }];

    expect(assetEntries(library, shelves).map((e) => e.id)).toEqual(["clip", "p1", "tpl"]);
  });

  test("type tabs: projects, each media type, and templates on All only", () => {
    const library: LibraryData = {
      assets: [asset("v", "video", 1), asset("i", "image", 1), asset("a", "audio", 1), asset("f", "font", 1), asset("l", "lut", 1)],
      folders: [],
      templates: [template("t", 1)],
    };
    const entries = assetEntries(library, [{ residency: "cloud", folders: [], projects: [project("p", 1)] }]);
    const on = (tab: Parameters<typeof entryOnTab>[1]) => entries.filter((e) => entryOnTab(e, tab)).map((e) => e.id).sort();

    expect(on("all")).toEqual(["a", "f", "i", "l", "p", "t", "v"]);
    expect(on("projects")).toEqual(["p"]);
    expect(on("videos")).toEqual(["v"]);
    expect(on("images")).toEqual(["i"]);
    expect(on("audio")).toEqual(["a"]);
    expect(on("fonts")).toEqual(["f"]);
    expect(on("notes")).toEqual([]);
  });

  test("search ignores case and accents", () => {
    expect(nameMatches("Café Opener", "cafe")).toBe(true);
    expect(nameMatches("Beach", " BEA ")).toBe(true);
    expect(nameMatches("Beach", "sea")).toBe(false);
  });

  test("a wide card is as wide as a tall card is tall", () => {
    expect(cardBox({ w: 9, h: 16 })).toEqual({ width: 180, height: 320 });
    expect(cardBox({ w: 16, h: 9 })).toEqual({ width: 320, height: 180 });
    expect(cardBox(null)).toEqual({ width: 180, height: 320 });

    // The library card sizes by area; the area lands on the same box.
    const width = (frame: { w: number; h: number }) => Math.round(Math.sqrt((cardArea(frame) * frame.w) / frame.h));
    expect(width({ w: 16, h: 9 })).toBe(320);
    expect(width({ w: 9, h: 16 })).toBe(180);
  });
});

// A folder's count is what opening it shows: its cards, its subfolders, and
// the notes filed in it on its own shelf.
test("a folder counts its cards, subfolders and notes", () => {
  const folder = { id: "f1", residency: "cloud" as const };
  const count = folderItemCount(folder, {
    entries: [{ folderId: "f1" }, { folderId: "f1" }, { folderId: null }],
    folders: [{ id: "f2", parentId: "f1" }, { id: "f3", parentId: null }],
    notes: [
      { libraryLocation: { folderId: "f1", residency: "cloud" } },
      { libraryLocation: { folderId: "f1", residency: "local" } },
      { libraryLocation: null },
    ],
  });
  expect(count).toBe(4);
});
