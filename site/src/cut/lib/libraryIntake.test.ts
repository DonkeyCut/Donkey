import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import * as library from "@/cut/lib/library";
import * as linked from "@/cut/lib/linkedLibrary";
import { libraryKey, libraryScope } from "@/cut/lib/queries";
import * as cache from "@/cut/lib/cache";
import { importLibraryFiles, importLibraryLink, resumeLibraryLinks, useLibraryImports } from "@/cut/lib/libraryIntake";
import type { Residency } from "@/cut/lib/residency";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  useLibraryImports.setState({ items: [] });
});

function setup() {
  const client = new QueryClient();
  client.setQueryData(libraryKey(libraryScope()), { assets: [], folders: [], templates: [] });
  const upload = spyOn(library, "uploadToLibrary").mockImplementation(async (file, residency) => ({
    id: file.name, fileName: file.name, name: file.name, type: "video", duration: 1, addedAt: 0, residency: residency!,
  }));
  const move = spyOn(library, "moveLibraryItem").mockResolvedValue(undefined);
  const sync = spyOn(linked, "syncLinkedLibrary").mockResolvedValue(undefined);
  restores.push(() => { upload.mockRestore(); move.mockRestore(); sync.mockRestore(); client.clear(); });
  return { client, upload, move };
}

describe("shared Library file intake", () => {
  for (const residency of ["browser", "local", "cloud"] as Residency[]) {
    test(`${residency} publishes every supported file before storage starts and keeps its folder`, async () => {
      const h = setup();
      const lut = new File(["LUT_3D_SIZE 2"], "look.cube");
      const files = [
        new File(["video"], "phone.mov", { type: "video/quicktime" }),
        new File(["image"], "photo.jpg", { type: "image/jpeg" }),
        new File(["audio"], "song.wav", { type: "audio/wav" }),
        new File(["font"], "face.woff2", { type: "font/woff2" }),
        ...(linked.linkedTypeOfFile(lut) ? [lut] : []),
      ];
      const done = importLibraryFiles(files, { residency, folderId: "folder" }, h.client);
      expect(useLibraryImports.getState().items.map((item) => item.file)).toEqual(files);
      expect(h.upload).not.toHaveBeenCalled();
      await done;
      expect(h.upload.mock.calls.map((call) => call[1])).toEqual(files.map(() => residency));
      expect(h.move.mock.calls.map((call) => call[2])).toEqual(files.map(() => "folder"));
      expect(useLibraryImports.getState().items).toEqual([]);
      const data = h.client.getQueryData<library.LibraryData>(libraryKey(libraryScope()))!;
      expect(data.assets).toHaveLength(files.length);
      expect(data.assets.every((asset) => asset.folderId === "folder")).toBe(true);
    });
  }

  test("a failed folder write retries the saved asset without another upload", async () => {
    const h = setup();
    let first = true;
    h.move.mockImplementation(async () => { if (first) { first = false; throw new Error("Folder write failed"); } });
    await importLibraryFiles([new File(["video"], "phone.mov")], { residency: "cloud", folderId: "folder" }, h.client);
    const item = useLibraryImports.getState().items[0];
    expect(item.error).toBe("Folder write failed");
    await Promise.all([item.run(), item.run()]);
    expect(h.upload.mock.calls.length).toBe(1);
    expect(h.move.mock.calls.length).toBe(2);
    expect(useLibraryImports.getState().items).toEqual([]);
  });

  test("a failed file stays retryable while the rest of the drop lands", async () => {
    const h = setup();
    h.upload.mockImplementation(async (file, residency) => {
      if (file.name === "a.mp4") throw new Error("Storage unavailable");
      return { id: file.name, fileName: file.name, name: file.name, type: "video", duration: 1, addedAt: 0, residency: residency! };
    });
    await importLibraryFiles([new File(["a"], "a.mp4"), new File(["b"], "b.mp4")], { residency: "cloud", folderId: null }, h.client);
    expect(useLibraryImports.getState().items.map((item) => item.name)).toEqual(["a.mp4"]);
    expect(useLibraryImports.getState().items[0].error).toBe("Storage unavailable");
    expect(h.upload.mock.calls.length).toBe(2);
  });

  test("an archive appears immediately and its children keep the drop's folder", async () => {
    const h = setup();
    const archive = new File(["archive"], "fonts.zip", { type: "application/zip" });
    const font = new File(["font"], "face.ttf");
    const expand = spyOn(linked, "expandLinkedFiles").mockImplementation(async ([file]) => file === archive ? [font] : [file]);
    restores.push(() => expand.mockRestore());
    const done = importLibraryFiles([archive], { residency: "browser", folderId: "fonts" }, h.client);
    expect(useLibraryImports.getState().items[0].file).toBe(archive);
    await done;
    expect(h.upload.mock.calls[0]?.[0]).toBe(font);
    expect(h.move.mock.calls[0]).toEqual(["browser", "face.ttf", "fonts"]);
  });
});

describe("Library link intake", () => {
  test("a link import outlives the page that started it and picks up its own job", async () => {
    const h = setup();
    const saved = new Map<string, unknown>();
    const write = spyOn(cache, "writeSnapshot").mockImplementation((key, value) => void saved.set(key, value));
    const read = spyOn(cache, "readSnapshot").mockImplementation(async (key) => saved.has(key) ? { value: saved.get(key) as never, at: Date.now() } : null);
    const keys: (string | undefined)[] = [];
    let land: ((assets: library.LibraryAsset[]) => void) | undefined;
    const fetchLink = spyOn(library, "importUrlToLibrary").mockImplementation((_url, _r, _stage, key) => {
      keys.push(key);
      return new Promise((resolve) => { land = resolve; });
    });
    restores.push(() => { write.mockRestore(); read.mockRestore(); fetchLink.mockRestore(); });

    void importLibraryLink("https://www.youtube.com/watch?v=abc", { residency: "cloud", folderId: null }, h.client);
    const id = useLibraryImports.getState().items[0].id;
    await new Promise((r) => setTimeout(r, 0));

    // The page reloads: the tile is gone from memory, the job is still running.
    useLibraryImports.setState({ items: [] });
    await resumeLibraryLinks(h.client);
    expect(useLibraryImports.getState().items.map((item) => item.id)).toEqual([id]);
    await new Promise((r) => setTimeout(r, 0));
    expect(keys).toEqual([id, id]);

    land!([{ id: "yt", fileName: "yt.mp4", name: "Video", type: "video", duration: 1, addedAt: 0, residency: "cloud" }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(useLibraryImports.getState().items).toEqual([]);
    expect(h.client.getQueryData<library.LibraryData>(libraryKey(libraryScope()))!.assets.map((a) => a.id)).toEqual(["yt"]);
    await resumeLibraryLinks(h.client);
    expect(keys).toEqual([id, id]);
  });

  test("a landed link the listing already shows is not listed twice", async () => {
    const h = setup();
    const asset: library.LibraryAsset = { id: "yt", fileName: "yt.mp4", name: "Video", type: "video", duration: 1, addedAt: 0, residency: "cloud" };
    h.client.setQueryData(libraryKey(libraryScope()), { assets: [asset], folders: [], templates: [] });
    const fetchLink = spyOn(library, "importUrlToLibrary").mockResolvedValue([asset]);
    restores.push(() => fetchLink.mockRestore());
    await importLibraryLink("https://www.youtube.com/watch?v=abc", { residency: "cloud", folderId: null }, h.client);
    expect(h.client.getQueryData<library.LibraryData>(libraryKey(libraryScope()))!.assets).toHaveLength(1);
  });
});
