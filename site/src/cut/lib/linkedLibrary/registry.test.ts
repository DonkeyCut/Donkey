import { afterAll, describe, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { LibraryAsset, LibraryData } from "../library";

/**
 * A lazy kind is keyed off its shelf row. Listing the account's LUTs reads no
 * bytes; the eager kinds beside them are still read and keyed by content.
 */

const row = (a: Partial<LibraryAsset> & Pick<LibraryAsset, "id" | "fileName" | "type">): LibraryAsset => ({
  name: a.fileName,
  duration: 0,
  addedAt: 1,
  residency: "cloud",
  ...a,
});

const shelf: LibraryAsset[] = [
  row({ id: "l1", fileName: "look.cube", type: "lut", contentKey: "abc123" }),
  // The same LUT on a second shelf: one item, two copies.
  row({ id: "l2", fileName: "look-copy.cube", type: "lut", contentKey: "abc123", residency: "browser" }),
  // Shelved before the row carried a key: nothing to list it by.
  row({ id: "l3", fileName: "unkeyed.cube", type: "lut" }),
  row({ id: "f1", fileName: "Inter.ttf", type: "font" }),
];

const fetched: string[] = [];
await stubModule<typeof import("../library")>("../library", import.meta.url, {
  fetchLibrary: async (): Promise<LibraryData> => ({ assets: shelf, folders: [], templates: [] }),
});
await stubModule<typeof import("../residency")>("../residency", import.meta.url, {
  backendFor: (() => ({
    fetch: async (path: string) => {
      fetched.push(path);
      return new Response(new Uint8Array([1, 2, 3]));
    },
  })) as never,
});
await stubModule<typeof import("../cache")>("../cache", import.meta.url, {
  readSnapshot: async () => null,
  writeSnapshot: () => {},
});

const { registerLinkedKind, syncLinkedLibrary, listLinked, linkedAccept, linkedTypeOfFile } = await import(
  "./registry"
);

// The kinds below stand in for the real ones under the same prefixes; the
// real registrations come back once this file is done.
afterAll(async () => {
  const [{ lutKind }, { fontKind }] = await Promise.all([import("./luts"), import("./fonts")]);
  registerLinkedKind(lutKind);
  registerLinkedKind(fontKind);
});

const used: string[] = [];
registerLinkedKind({
  prefix: "lut",
  type: "lut",
  lazy: true,
  matches: (f) => /\.cube$/i.test(f.name),
  accept: ".cube",
  extract: () => [],
});
registerLinkedKind({
  prefix: "font",
  type: "font",
  matches: (f) => /\.ttf$/i.test(f.name),
  accept: ".ttf",
  extract: () => [],
  use: async (key) => {
    used.push(key);
  },
});

describe("syncLinkedLibrary", () => {
  test("keys a lazy kind off its rows and reads no bytes for it", async () => {
    await syncLinkedLibrary();
    // Only the font came down: one read, one key made from its bytes.
    expect(fetched).toEqual(["/api/cut/library/media/Inter.ttf"]);
    expect(used.length).toBe(1);
    const luts = listLinked("lut");
    expect(luts.map((i) => i.key)).toEqual(["abc123"]);
    // The cloud copy names the item; both shelves hold it.
    expect(luts[0].label).toBe("look.cube");
    expect(luts[0].copies.map((c) => c.assetId).sort()).toEqual(["l1", "l2"]);
  });
});

describe("kind lookups", () => {
  test("a picker can ask for one kind's accept", () => {
    expect(linkedAccept("lut")).toBe(".cube");
    expect(linkedAccept()).toBe(".cube,.ttf");
  });

  test("a dropped file names the kind that shelves it", () => {
    expect(linkedTypeOfFile(new File([""], "grade.cube"))).toBe("lut");
    expect(linkedTypeOfFile(new File([""], "clip.mp4"))).toBeNull();
  });
});
