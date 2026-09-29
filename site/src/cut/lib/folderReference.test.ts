import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { runAiTool } from "@/cut/lib/aiTools";
import * as notes from "@/cut/lib/notes";
import * as media from "@/cut/lib/media";
import * as library from "@/cut/lib/library";
import * as linkedLibrary from "@/cut/lib/linkedLibrary/registry";
import { collectRefs, normalizeRef, refToken } from "@/cut/lib/assetRef";
import { readFolder } from "@/cut/lib/folderBrowse";
import { folderRef, libraryFolderRefs, parseFolderLink, projectFolderRef } from "@/cut/lib/folderReference";
import { backendFor } from "@/cut/lib/residency";
import { useEditor } from "@/cut/lib/store";
import { attachedAssetsBlock, AI_TOOLS } from "@/cut/server/ai/catalog";
import { READ_COMMANDS } from "@/clients/chatgpt/server/catalog";
import type { LibraryData, LibraryFolder } from "@/cut/lib/library";
import type { MediaAsset } from "@/cut/lib/types";

const folder = { id: "brand", name: "Brand assets", createdAt: 1 };
const token = "abcdefghijklmnopqrstuvwx12345678";
const originalState = useEditor.getState();
afterEach(() => useEditor.setState(originalState, true));

describe("folder references", () => {
  test("mentions keep identity through duplicate names, renames and saved chats", () => {
    const first = projectFolderRef(folder, "project1");
    const second = projectFolderRef({ ...folder, id: "other" }, "project1");
    const library = folderRef({ scope: "library", folderId: "brand", residency: "cloud" }, first.name);
    const restored = normalizeRef(JSON.parse(JSON.stringify(second)))!;
    const renamed = projectFolderRef({ ...folder, id: "other", name: "Renamed" }, "project1");
    expect(collectRefs(refToken(restored), [restored], [first, renamed, library]).refs).toEqual([restored]);
    expect(new Set([first.id, second.id, library.id]).size).toBe(3);
    expect(normalizeRef({ ...first, folder: { scope: "project", folderId: "brand" } })).toBeNull();
  });

  test("folder names with quotes and line breaks remain mentionable", () => {
    const ref = projectFolderRef({ ...folder, name: 'Our "Brand"\nAssets' }, "p1");
    expect(collectRefs(refToken(ref), [], [ref]).refs).toEqual([ref]);
  });

  test("library paths distinguish parents and shelves, including cyclic data", () => {
    const folders: LibraryFolder[] = [
      { ...folder, id: "root", name: "Client", residency: "cloud" },
      { ...folder, parentId: "root", residency: "cloud" },
      { ...folder, residency: "browser" },
      { ...folder, id: "loop", parentId: "loop", residency: "local" },
    ];
    const refs = libraryFolderRefs(folders);
    expect(refs[1].name).toBe("Library · Cloud / Client / Brand assets");
    expect(refs[2].name).toBe("Library · Browser / Brand assets");
    expect(refs[3].folder?.folderId).toBe("loop");
  });

  test("folder URLs accept known routes and reject lookalikes", () => {
    expect(parseFolderLink("donkeycut.com/app/library?folder=brand")).toEqual({ scope: "library", folderId: "brand" });
    expect(parseFolderLink("http://cut.localhost:3000/cut/app/p/p1?folder=brand")).toEqual({ scope: "project", projectId: "p1", folderId: "brand" });
    expect(parseFolderLink(`https://donkeycut.com/s/library/${token}?folder=child`)).toEqual({ scope: "shared", shareToken: token, folderId: "child" });
    for (const url of ["https://evil.test/app/library?folder=brand", "https://donkeycut.com/app/library", "https://donkeycut.com/app/p/p1", "javascript:alert(1)", "https://donkeycut.com/s/library/invalid"]) {
      expect(parseFolderLink(url)).toBeNull();
    }
  });

  test("all clients expose a read-only tool and the prompt carries its typed reference", () => {
    expect(AI_TOOLS.some((t) => t.name === "read_folder")).toBe(true);
    expect(READ_COMMANDS.has("read_folder")).toBe(true);
    const ref = projectFolderRef(folder, "p1");
    const text = attachedAssetsBlock([ref]);
    expect(text).toContain('"reference":{"scope":"project","folderId":"brand","projectId":"p1"}');
    expect(text).toContain("read_folder");
    expect(text).not.toContain("data:text");
  });

  test("reads current project contents in bounded pages and reports deleted folders", async () => {
    const assets = ["a", "b", "c"].map((id) => ({ id, name: id, type: "image", duration: 0, folderId: "brand" }) as MediaAsset);
    useEditor.setState({ projectId: "p1", mediaFolders: [folder], assets, templates: [] });
    const reference = { scope: "project", projectId: "p1", folderId: "brand" };
    const first = await readFolder({ reference, limit: 2 });
    expect(first).toMatchObject({ entries: [{ id: "a" }, { id: "b" }], next: 2, total: 3 });
    expect(await readFolder({ reference, limit: 2, offset: 2 })).toMatchObject({ entries: [{ id: "c" }], next: null });
    useEditor.setState({ mediaFolders: [{ ...folder, name: "Updated" }], assets: assets.slice(1) });
    expect(await readFolder({ reference, limit: 2 })).toMatchObject({ name: "Updated", total: 2 });
    useEditor.setState({ mediaFolders: [] });
    await expect(readFolder({ reference, limit: 2 })).rejects.toThrow("deleted or is unavailable");
  });

  for (const residency of ["browser", "local", "cloud"] as const) {
    test(`library folder reads use the ${residency} backend and expose child references`, async () => {
      const lib: LibraryData = { folders: [{ ...folder, residency }, { ...folder, id: "child", parentId: "brand", residency }], assets: [], templates: [] };
      const fetch = spyOn(backendFor(residency), "fetch").mockResolvedValue(Response.json(lib));
      const noteFetch = spyOn(notes, "fetchNotes").mockResolvedValue({ notes: [], folders: [], labels: [] });
      try {
        expect(await readFolder({ reference: { scope: "library", folderId: "brand", residency }, limit: 10 })).toMatchObject({ entries: [{ kind: "folder", reference: { scope: "library", folderId: "child", residency } }] });
        expect(fetch.mock.calls[0][0]).toBe("/api/cut/library");
      } finally { fetch.mockRestore(); noteFetch.mockRestore(); }
    });
  }

  test("shared folders retain pagination and grant identity for selective imports", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ name: "Brand", kind: "folder", trail: [{ id: "root", name: "Brand" }], folders: [{ id: "child", name: "Logos" }], assets: [], templates: [], next: 40 }));
    try {
      expect(await readFolder({ link: `https://donkeycut.com/s/library/${token}`, limit: 10 })).toMatchObject({ next: 40, folder_id: "root", share_link: `https://donkeycut.com/s/library/${token}`, folders: [{ reference: { scope: "shared", shareToken: token, folderId: "child" } }] });
      fetch.mockResolvedValue(new Response(null, { status: 403 }));
      await expect(readFolder({ link: `https://donkeycut.com/s/library/${token}`, limit: 10 })).rejects.toThrow("403");
    } finally { fetch.mockRestore(); }
  });
  for (const template of [false, true]) test(`a shared ${template ? "template file" : "asset"} registers and downloads without account headers`, async () => {
    useEditor.setState({ projectId: "p1", loaded: true, assets: [], clips: [], audioClips: [], overlays: [] });
    const source = { id: "logo", name: "Logo", type: "image", duration: 0, fileName: "logo.png" };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("?resolve=1")) return Response.json({ url: "https://media.test/logo.png" });
      if (url === "https://media.test/logo.png") {
        expect(init).toBeUndefined();
        return new Response("image");
      }
      return Response.json({ name: "Brand", kind: "folder", trail: [], folders: [], assets: template ? [] : [source], templates: template ? [{ id: "logo", name: "Brand intro", files: [source] }] : [], next: null });
    });
    const imported = spyOn(media, "importFileToProject").mockResolvedValue({ ...source, id: "copied", type: "image", url: "/logo.png" });
    const enrich = spyOn(media, "enrichAsset").mockResolvedValue(undefined);
    try {
      expect(await runAiTool("library_add", { share_link: `https://donkeycut.com/s/library/${token}`, id: "logo", ...(template ? { template_file: "logo.png" } : {}) })).toMatchObject({ assetId: "copied", addedToTimeline: false });
      expect(useEditor.getState().assets.map((a) => a.id)).toEqual(["copied"]);
      expect(useEditor.getState().clips).toEqual([]);
    } finally { fetch.mockRestore(); imported.mockRestore(); enrich.mockRestore(); }
  });

  for (const kind of ["font", "lut"] as const) test(`shared ${kind} files become usable linked assets`, async () => {
    useEditor.setState({ projectId: "p1", loaded: true, assets: [] });
    const source = { id: "source", name: "Brand", type: kind, duration: 0, fileName: kind === "font" ? "brand.ttf" : "brand.cube" };
    const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("?resolve=1")) return Response.json({ url: "https://media.test/file" });
      if (url === "https://media.test/file") return new Response("bytes");
      return Response.json({ name: "Brand", kind: "folder", trail: [], folders: [], assets: [source], templates: [], next: null });
    });
    const linkedType = spyOn(linkedLibrary, "isLinkedType").mockReturnValue(true);
    const upload = spyOn(linkedLibrary, "uploadLinkedFile").mockResolvedValue(`${kind}:key`);
    try {
      const result = await runAiTool("library_add", { share_link: `https://donkeycut.com/s/library/${token}`, id: "source" });
      expect(result).toMatchObject(kind === "font" ? { fontId: "font:key" } : { lutId: "lut:key" });
      expect(upload.mock.calls.length).toBe(1);
      expect(useEditor.getState().assets).toEqual([]);
    } finally { fetch.mockRestore(); upload.mockRestore(); linkedType.mockRestore(); }
  });

  test("owned fonts resolve the registry id used by the editor", async () => {
    useEditor.setState({ projectId: "p1", loaded: true });
    const listing = spyOn(library, "fetchLibrary").mockResolvedValue({ assets: [{ id: "row", name: "Brand font", fileName: "brand.ttf", type: "font", duration: 0, addedAt: 1, residency: "cloud" }], folders: [], templates: [] });
    const sync = spyOn(linkedLibrary, "syncLinkedLibrary").mockResolvedValue(undefined);
    const resolve = spyOn(linkedLibrary, "linkIdForAsset").mockReturnValue("font:content-key");
    try {
      expect(await runAiTool("library_add", { id: "row" })).toMatchObject({ fontId: "font:content-key" });
    } finally { listing.mockRestore(); sync.mockRestore(); resolve.mockRestore(); }
  });

});
