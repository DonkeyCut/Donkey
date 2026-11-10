import { describe, expect, test } from "bun:test";
import { planNotePlacement, type CutNote, type CutNoteFolder } from "./notes";
import type { LibraryFolder } from "./library";

// Every note lives in the Library. A note with no placement files into the
// Library's Notes folder, under the path of the phone folder it sits in.

const ROOT = "Notes";

const note = (id: string, folderId: string | null, libraryLocation: CutNote["libraryLocation"] = null) =>
  ({ id, folderId, libraryLocation });
const noteFolder = (id: string, name: string, parentId: string | null = null): CutNoteFolder =>
  ({ id, name, parentId, createdAt: 1, updatedAt: 1 });
const shelfFolder = (id: string, name: string, parentId: string | null = null, residency: LibraryFolder["residency"] = "cloud") =>
  ({ id, name, parentId, residency });

describe("planNotePlacement", () => {
  test("plans nothing when every note is in the Library", () => {
    const plan = planNotePlacement({
      notes: [note("a", null, { folderId: null, residency: "cloud" }), note("b", "f1", { folderId: "lib", residency: "cloud" })],
      noteFolders: [noteFolder("f1", "Scripts")],
      libraryFolders: [],
      rootName: ROOT,
    });
    expect(plan).toEqual({ create: [], moves: [] });
  });

  test("makes the Notes folder at the cloud Library root for a loose note", () => {
    const plan = planNotePlacement({ notes: [note("a", null)], noteFolders: [], libraryFolders: [], rootName: ROOT });
    expect(plan.create).toEqual([{ key: "new:0", name: ROOT, parentId: null }]);
    expect(plan.moves).toEqual([{ noteId: "a", folderId: "new:0" }]);
  });

  test("reuses the Notes folder at the cloud root and nowhere else", () => {
    const plan = planNotePlacement({
      notes: [note("a", null)],
      noteFolders: [],
      libraryFolders: [
        shelfFolder("nested", ROOT, "brand"),
        shelfFolder("browser", ROOT, null, "browser"),
        shelfFolder("root", ROOT),
      ],
      rootName: ROOT,
    });
    expect(plan.create).toEqual([]);
    expect(plan.moves).toEqual([{ noteId: "a", folderId: "root" }]);
  });

  test("mirrors the phone folder tree under Notes by name", () => {
    const plan = planNotePlacement({
      notes: [note("a", "scripts"), note("b", "hooks"), note("c", "hooks"), note("d", "ideas")],
      noteFolders: [noteFolder("scripts", "Scripts"), noteFolder("hooks", "Hooks", "scripts"), noteFolder("ideas", "Ideas")],
      libraryFolders: [shelfFolder("notes", ROOT), shelfFolder("lib-scripts", "Scripts", "notes")],
      rootName: ROOT,
    });
    expect(plan.create).toEqual([
      { key: "new:0", name: "Hooks", parentId: "lib-scripts" },
      { key: "new:1", name: "Ideas", parentId: "notes" },
    ]);
    expect(plan.moves).toEqual([
      { noteId: "a", folderId: "lib-scripts" },
      { noteId: "b", folderId: "new:0" },
      { noteId: "c", folderId: "new:0" },
      { noteId: "d", folderId: "new:1" },
    ]);
  });

  test("creates each new folder once, parents first", () => {
    const plan = planNotePlacement({
      notes: [note("deep", "c"), note("top", "a")],
      noteFolders: [noteFolder("a", "A"), noteFolder("b", "B", "a"), noteFolder("c", "C", "b")],
      libraryFolders: [],
      rootName: ROOT,
    });
    expect(plan.create).toEqual([
      { key: "new:0", name: ROOT, parentId: null },
      { key: "new:1", name: "A", parentId: "new:0" },
      { key: "new:2", name: "B", parentId: "new:1" },
      { key: "new:3", name: "C", parentId: "new:2" },
    ]);
    expect(plan.moves).toEqual([
      { noteId: "deep", folderId: "new:3" },
      { noteId: "top", folderId: "new:1" },
    ]);
  });

  test("files a note whose phone folder is gone into Notes itself", () => {
    const plan = planNotePlacement({
      notes: [note("a", "deleted")],
      noteFolders: [],
      libraryFolders: [shelfFolder("notes", ROOT)],
      rootName: ROOT,
    });
    expect(plan).toEqual({ create: [], moves: [{ noteId: "a", folderId: "notes" }] });
  });

  test("leaves placed notes where they are", () => {
    const plan = planNotePlacement({
      notes: [
        note("root", "scripts", { folderId: null, residency: "cloud" }),
        note("filed", "scripts", { folderId: "brand", residency: "cloud" }),
        note("loose", "scripts"),
      ],
      noteFolders: [noteFolder("scripts", "Scripts")],
      libraryFolders: [shelfFolder("notes", ROOT), shelfFolder("brand", "Brand")],
      rootName: ROOT,
    });
    expect(plan.moves).toEqual([{ noteId: "loose", folderId: "new:0" }]);
    expect(plan.create).toEqual([{ key: "new:0", name: "Scripts", parentId: "notes" }]);
  });
});
