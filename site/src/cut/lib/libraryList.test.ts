import { expect, test } from "bun:test";
import type { LibraryAsset, LibraryFolder } from "./library";
import { findLibraryAsset, LIBRARY_PAGE_DEFAULT, libraryMatchKey, listLibrary } from "./libraryList";

const folder = (id: string, name: string, parentId?: string): LibraryFolder => ({ id, name, parentId, createdAt: 0, residency: "cloud" });
const asset = (id: string, name: string, extra: Partial<LibraryAsset> = {}): LibraryAsset =>
  ({ id, name, fileName: `${name}.mp4`, type: "video", duration: 12.345, addedAt: 0, residency: "cloud", ...extra });

const folders = [folder("tv", "Template videos"), folder("desk", "Desk", "tv"), folder("phone", "Camera Roll")];
const assets = [
  asset("a1", "computer-desk-raw", { folderId: "desk" }),
  asset("a2", "Computer Desk Edit", { folderId: "tv" }),
  asset("a3", "IMG_2041", { folderId: "phone", title: "Laptop on a desk", origin: "camera" }),
  asset("a4", "beat", { type: "audio", fileName: "beat.mp3" }),
  ...Array.from({ length: 100 }, (_, i) => asset(`p${i}`, `phone clip ${i}`, { folderId: "phone", origin: "camera" })),
];
const lib = { folders, assets, templates: [{ id: "t1", name: "Laptop intro", duration: 3, parts: 4, folderId: "tv" }] };

/** A listing that found its folder; an unknown folder fails the test. */
const page = (opts: Parameters<typeof listLibrary>[1]) => {
  const out = listLibrary(lib, opts);
  if (!("items" in out)) throw new Error(out.error);
  return out;
};
const ids = (opts: Parameters<typeof listLibrary>[1]) => page(opts).items.map((i) => i.id);

test("names match without case, hyphens or spaces", () => {
  expect(libraryMatchKey("Computer-Desk_raw")).toBe(libraryMatchKey("computer desk raw"));
});

test("a whole shelf comes back a page at a time", () => {
  const first = page({});
  expect(first.items).toHaveLength(LIBRARY_PAGE_DEFAULT);
  expect(first.total).toBe(105);
  expect(first.next).toBe(LIBRARY_PAGE_DEFAULT);
  expect(page({ offset: 100 }).next).toBeUndefined();
});

test("a query finds an asset by words in its name, file or title", () => {
  expect(ids({ query: "computer desk raw" })).toEqual(["a1"]);
  expect(ids({ query: "laptop desk" })).toEqual(["a3"]);
});

test("a folder narrows to it and the folders inside it, by name or id", () => {
  expect(ids({ folder: "template videos" })).toEqual(["a1", "a2", "t1"]);
  expect(ids({ folder: "desk", kind: "video" })).toEqual(["a1"]);
  expect("error" in listLibrary(lib, { folder: "Nope" })).toBe(true);
});

test("a kind narrows to that kind", () => {
  expect(ids({ kind: "audio" })).toEqual(["a4"]);
  expect(ids({ kind: "template" })).toEqual(["t1"]);
});

test("library_add finds an asset by id or by name", () => {
  expect(findLibraryAsset(assets, "a1")).toEqual({ asset: assets[0] });
  expect(findLibraryAsset(assets, "Computer Desk Raw")).toEqual({ asset: assets[0] });
  expect(findLibraryAsset(assets, "computer-desk-raw.mp4")).toEqual({ asset: assets[0] });
  expect(findLibraryAsset(assets, "keyboard-laptop-key")).toBeUndefined();
});

test("several assets with one name come back as candidates", () => {
  const twins = [asset("x", "intro"), asset("y", "Intro", { folderId: "tv" })];
  expect(findLibraryAsset(twins, "intro")).toEqual({ candidates: [{ id: "x", name: "intro" }, { id: "y", name: "Intro", folderId: "tv" }] });
});
