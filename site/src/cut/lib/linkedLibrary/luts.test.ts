import { describe, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import type { LibraryAsset, LibraryData } from "../library";
import type { ProjectDoc } from "../types";

/** A 2-node identity cube, as a shelf would serve it. */
const CUBE = [
  "LUT_3D_SIZE 2",
  "0 0 0", "1 0 0", "0 1 0", "1 1 0",
  "0 0 1", "1 0 1", "0 1 1", "1 1 1",
].join("\n");

const shelf: LibraryAsset[] = [
  {
    id: "l1",
    fileName: "look.cube",
    name: "Look",
    type: "lut",
    duration: 0,
    addedAt: 1,
    residency: "cloud",
    contentKey: "abc123",
    lut: { kind: "3d", size: 2 },
  },
];

const fetched: string[] = [];
await stubModule<typeof import("../library")>("../library", import.meta.url, {
  fetchLibrary: async (): Promise<LibraryData> => ({ assets: shelf, folders: [], templates: [] }),
});
await stubModule<typeof import("../residency")>("../residency", import.meta.url, {
  backendFor: (() => ({
    fetch: async (path: string) => {
      fetched.push(path);
      return new Response(CUBE);
    },
  })) as never,
});
const requested: string[] = [];
await stubModule<typeof import("../backend/cloud")>("../backend/cloud", import.meta.url, {
  cloudRequest: async (path: string) => {
    requested.push(path);
    return new Response(CUBE);
  },
});
await stubModule<typeof import("../cache")>("../cache", import.meta.url, {
  readSnapshot: async () => null,
  writeSnapshot: () => {},
});

const { linkedIdsIn, syncLinkedLibrary } = await import("./registry");
const { cachedLut, listLutChoices, loadLibraryLut, loadLibraryLutFile, lutIdOf, lutKind, lutLabel } = await import("./luts");
const { BUILTIN_LUTS } = await import("../builtinLuts");

const grade = (id: string) => ({ lut: { id } }) as unknown as NonNullable<ProjectDoc["clips"][number]["grade"]>;

describe("the LUT kind", () => {
  test("files a new LUT where it was dropped, like any Library file", () => {
    expect(lutKind.homeFolder).toBeUndefined();
  });

  test("extracts the LUTs clips, template layers and saved grades name", () => {
    const doc = {
      clips: [
        { id: "c1", grade: grade("lut:aaa") },
        { id: "c2", grade: grade("lut:aaa") },
        { id: "c3", grade: { exposure: 1 } },
        { id: "c4" },
      ],
      templates: [
        { id: "t1", grade: grade("lut:bbb"), layers: [{ grade: grade("lut:ccc") }, {}] },
        { id: "t2", layers: [] },
      ],
    } as unknown as ProjectDoc;
    expect(linkedIdsIn(doc).filter((id) => id.startsWith("lut:")).sort()).toEqual([
      "lut:aaa",
      "lut:bbb",
      "lut:ccc",
    ]);
    expect(lutIdOf(grade("font:zzz"))).toBeNull();
    expect(lutIdOf(undefined)).toBeNull();
  });

  test("reads a LUT's bytes once, on demand, and keeps the parsed table", async () => {
    await syncLinkedLibrary();
    expect(fetched).toEqual([]);
    expect(cachedLut("lut:abc123")).toBeUndefined();
    const lut = await loadLibraryLut("lut:abc123");
    expect(lut.cube?.size).toBe(2);
    expect(fetched).toEqual(["/api/cut/library/media/look.cube"]);
    expect(await loadLibraryLut("lut:abc123")).toBe(lut);
    expect(cachedLut("lut:abc123")).toBe(lut);
    expect(fetched.length).toBe(1);
    await expect(loadLibraryLut("lut:missing")).rejects.toThrow(/not in the library/);
  });

  test("reads a built-in LUT off the site and lists it before the shelf's own", async () => {
    const vivid = BUILTIN_LUTS.find((l) => l.id === "vivid")!;
    const id = `lut:${vivid.key}`;
    const file = await loadLibraryLutFile(id);
    expect(file.fileName).toBe("vivid.cube");
    expect(requested).toEqual([vivid.file]);
    expect((await loadLibraryLut(id)).cube?.size).toBe(2);
    expect(lutLabel(id)).toBe("Vivid");
    const choices = listLutChoices();
    expect(choices.slice(0, BUILTIN_LUTS.length).every((c) => c.builtIn)).toBe(true);
    expect(choices.at(-1)).toEqual({ id: "lut:abc123", label: "Look", builtIn: false });
  });
});
