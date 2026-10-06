import { describe, expect, spyOn, test } from "bun:test";
import { collectRefs, normalizeRef, refToken } from "@/cut/lib/assetRef";
import { noteInLibraryFolder, noteInNotesFolder, noteRef, parseNoteLink } from "@/cut/lib/noteReference";
import { readNote, writeNoteFromTool, type CutNote } from "@/cut/lib/notes";
import * as notes from "@/cut/lib/notes";
import { backendFor } from "@/cut/lib/residency";
import { readFolder } from "@/cut/lib/folderBrowse";
import { attachedAssetsBlock, AI_TOOLS } from "@/cut/server/ai/catalog";
import { READ_COMMANDS, COMMAND_NAMES } from "@/clients/chatgpt/server/catalog";
const note: CutNote = { id: "script", title: 'Brand "Voice"', body: "First draft", colorIndex: 2, folderId: "phone-folder", labelIds: ["brand"], createdAt: 1, updatedAt: 1, deletedAt: null, libraryLocation: { folderId: "assets", residency: "browser" } };
describe("note references", () => {
  test("Library root notes retain explicit placement; existing Notes stay in Notes", () => {
    expect(noteInLibraryFolder({ libraryLocation: null }, null)).toBe(false);
    expect(noteInLibraryFolder({}, null)).toBe(false);
    for (const residency of ["browser", "local", "cloud"] as const) {
      const root = { libraryLocation: { folderId: null, residency } };
      expect(noteInLibraryFolder(root, null)).toBe(true);
      expect(noteInLibraryFolder(root, null, residency)).toBe(true);
      expect(noteInLibraryFolder(root, "assets", residency)).toBe(false);
      const filed = { libraryLocation: { folderId: "assets", residency } };
      expect(noteInLibraryFolder(filed, null)).toBe(false);
      expect(noteInLibraryFolder(filed, "assets", residency)).toBe(true);
      expect(noteInLibraryFolder(filed, "assets", residency === "cloud" ? "browser" : "cloud")).toBe(false);
    }
  });
  test("Library notes stay out of Notes", () => {
    expect(noteInNotesFolder({ folderId: null, libraryLocation: null }, null)).toBe(true);
    expect(noteInNotesFolder({ folderId: "plans" }, "plans")).toBe(true);
    expect(noteInNotesFolder({ folderId: "plans" }, null)).toBe(false);
    expect(noteInNotesFolder({ folderId: null, libraryLocation: { folderId: null, residency: "cloud" } }, null)).toBe(false);
    expect(noteInNotesFolder({ folderId: "plans", libraryLocation: { folderId: "assets", residency: "browser" } }, "plans")).toBe(false);
  });
  test("saved mentions retain identity through renaming and duplicate titles", () => {
    const ref = noteRef(note);
    const restored = normalizeRef(JSON.parse(JSON.stringify(ref)))!;
    expect(collectRefs(refToken(restored), [restored], [noteRef({ ...note, title: "Renamed" }), noteRef({ ...note, id: "other" })]).refs).toEqual([restored]);
    expect(restored.id).toBe(note.id);
    expect(normalizeRef({ ...ref, id: "../other" })).toBeNull();
    expect(attachedAssetsBlock([ref])).toContain("read_note");
    expect(attachedAssetsBlock([ref])).not.toContain("First draft");
  });
  test("URLs resolve only known routes and valid identities", () => {
    expect(parseNoteLink("donkeycut.com/app/notes?note=script")).toBe("script");
    expect(parseNoteLink("http://localhost:3000/cut/app/library?folder=assets&note=script")).toBe("script");
    for (const url of ["https://evil.test/app/notes?note=script", "https://donkeycut.com/app/notes", "https://donkeycut.com/app/p/p1?note=script", "https://donkeycut.com/app/notes?note=../secret"]) expect(parseNoteLink(url)).toBeNull();
  });
  test("reads current text and surfaces deleted or inaccessible notes", async () => {
    let body = note.body;
    const fetch = spyOn(backendFor("cloud"), "fetch").mockImplementation(async () => Response.json({ ...note, body }));
    try {
      expect((await readNote({ id: note.id })).body).toBe("First draft");
      body = "Revised on phone";
      expect((await readNote({ link: "https://donkeycut.com/app/notes?note=script" })).body).toBe(body);
      expect(fetch.mock.calls.map((c) => c[0])).toEqual(["/api/cut/notes/script", "/api/cut/notes/script"]);
      fetch.mockImplementation(async () => new Response(null, { status: 404 }));
      await expect(readNote({ id: note.id })).rejects.toThrow("deleted or is unavailable");
      fetch.mockImplementation(async () => new Response(null, { status: 403 }));
      await expect(readNote({ id: note.id })).rejects.toThrow("Could not read");
    } finally { fetch.mockRestore(); }
  });
  test("tool edits preserve phone folders, labels, colors, and placement", async () => {
    let saved: unknown;
    const fetch = spyOn(backendFor("cloud"), "fetch").mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") { saved = JSON.parse(String(init.body)); return Response.json(saved); }
      return Response.json(note);
    });
    try {
      await writeNoteFromTool({ id: note.id, body: "New words" });
      expect(saved).toMatchObject({ id: note.id, title: note.title, body: "New words", folderId: note.folderId, labelIds: note.labelIds, colorIndex: 2 });
      expect(Object.prototype.hasOwnProperty.call(saved, "libraryLocation")).toBe(false);
      await writeNoteFromTool({ title: "New script", body: "Hello", libraryLocation: null });
      expect(saved).toMatchObject({ title: "New script", body: "Hello", folderId: null, libraryLocation: null });
      await expect(writeNoteFromTool({})).rejects.toThrow("title or body");
    } finally { fetch.mockRestore(); }
  });
  for (const residency of ["browser", "local", "cloud"] as const) test(`${residency} folder lists its notes`, async () => {
    const fetch = spyOn(backendFor(residency), "fetch").mockImplementation(async () => Response.json({ folders: [{ id: "assets", name: "Brand", residency }], assets: [], templates: [] }));
    const read = spyOn(notes, "fetchNotes").mockResolvedValue({ notes: [{ ...note, libraryLocation: { folderId: "assets", residency } }, { ...note, id: "other", libraryLocation: { folderId: "elsewhere", residency } }], folders: [], labels: [] });
    try {
      expect(await readFolder({ reference: { scope: "library", folderId: "assets", residency }, limit: 1 })).toMatchObject({ entries: [{ kind: "note", id: note.id, tool: "read_note" }], total: 1, next: null });
    } finally { fetch.mockRestore(); read.mockRestore(); }
  });
  test("clients expose note tools with correct read classification", () => {
    expect(AI_TOOLS.some((t) => t.name === "read_note")).toBe(true);
    expect(COMMAND_NAMES).toContain("note_save");
    expect(READ_COMMANDS.has("read_note")).toBe(true);
    expect(READ_COMMANDS.has("note_save")).toBe(false);
  });
});
