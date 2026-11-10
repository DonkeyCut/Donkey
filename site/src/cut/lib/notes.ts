"use client";

/**
 * Synced notes, the desktop half. Notes live in the cloud (/api/cut-cloud/notes)
 * and are written from two places — the iOS app and the Library — so every
 * write carries its own `updatedAt` stamp and the server keeps whichever
 * version is newer (last writer wins). Deletes leave tombstones; the list is
 * filtered here so the UI only ever sees live notes.
 *
 * On the desktop every note sits in a Library folder (`libraryLocation`). The
 * phone files notes into its own folders (`folderId`); a note that reaches the
 * desktop with no Library placement files into the Library's Notes folder,
 * under the path of its phone folder.
 */

import { NOTE_PLACEMENTS_MAX, noteReadSchema, noteSaveSchema, parseNoteLink, type NoteLocation } from "@/cut/lib/noteReference";
import { creatorNames } from "./defaultNames";
import { folderTrail, settleParents } from "./folderTree";
import { dropPendingNote, flushNote, sendNoteNow, stageNote, withPendingNotes, type NoteWrite } from "./noteOutbox";
import { backendFor } from "./residency";
import { reportSwallowed } from "./report";
import { UserError } from "./userError";
import type { LibraryFolder } from "./library";

export interface CutNote {
  libraryLocation?: NoteLocation | null;
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

export interface CutNoteFolder {
  id: string;
  name: string;
  /** The folder this one is filed in; null is the top level. */
  parentId: string | null;
  updatedAt: number;
  createdAt: number;
}

/** A label notes carry. Like folders, ids are client-generated and one PUT
 * both creates and renames. */
export interface CutNoteLabel {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
}

export interface NotesData {
  notes: CutNote[];
  folders: CutNoteFolder[];
  labels: CutNoteLabel[];
}

/** The note paper palette, shared with the iOS app (NoteColor). Index into it
 * with `colorIndex`. */
export const NOTE_COLORS = [
  { name: "Butter", background: "#faefb6", accent: "#f2c94c" },
  { name: "Blush", background: "#fbd8d4", accent: "#ef8b80" },
  { name: "Sky", background: "#d5e8fb", accent: "#7fb2ef" },
  { name: "Mint", background: "#d9f3d6", accent: "#82cf7a" },
  { name: "Lilac", background: "#e6dcf7", accent: "#a988e0" },
] as const;

export const noteColor = (index: number) =>
  NOTE_COLORS[((index % NOTE_COLORS.length) + NOTE_COLORS.length) % NOTE_COLORS.length];

const notesFetch = (path: string, init?: RequestInit) =>
  backendFor("cloud").fetch(path, init);

const json = (body: unknown): RequestInit => ({
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Every live note, newest first, with the folders they file into. Tombstones
 * are the phone's concern; the desktop just drops them. A folder whose parent
 * the listing does not name reads as top level, so nothing on screen hangs
 * off a folder nobody can open. */
export async function fetchNotes(): Promise<NotesData> {
  const res = await notesFetch("/api/cut/notes");
  if (!res.ok) throw new UserError("notes_load_failed", "Could not load notes.");
  const body = (await res.json()) as Partial<NotesData>;
  return {
    notes: withPendingNotes(body.notes ?? []).filter((n) => n.deletedAt === null),
    folders: settleParents(body.folders ?? []),
    labels: body.labels ?? [],
  };
}

export async function readNote(raw: unknown): Promise<CutNote> {
  const input = noteReadSchema.parse(raw);
  const id = input.id ?? (input.link ? parseNoteLink(input.link) : null);
  if (!id) throw new Error("Provide a note id or a Donkey note link.");
  const res = await notesFetch(`/api/cut/notes/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "This note was deleted or is unavailable." : "Could not read the note.");
  return res.json();
}

export async function writeNoteFromTool(raw: unknown): Promise<CutNote> {
  const input = noteSaveSchema.parse(raw);
  const { id, ...changes } = input;
  const prior = id ? await readNote({ id }) : null;
  if (!prior && !input.title?.trim() && !input.body?.trim()) throw new Error("A new note needs a title or body.");
  const base = { id: prior?.id ?? crypto.randomUUID(), title: prior?.title ?? creatorNames().untitled, body: prior?.body ?? "",
    colorIndex: prior?.colorIndex ?? 0, folderId: prior?.folderId ?? null, labelIds: prior?.labelIds ?? [] };

  // An edit that says nothing about placement leaves the note where it is.
  if (prior && changes.libraryLocation === undefined) {
    return saveNote({ ...base, ...changes });
  }

  // A new note, or one taken out of its Library folder, files into the
  // Library's Notes folder in this same write, so the chat answers with
  // where it landed.
  const libraryLocation = changes.libraryLocation ?? (await notesFolderFor(base.folderId));
  return saveNote({ ...base, ...changes, libraryLocation });
}

/** The Library folder a loose note in phone folder `folderId` files into,
 * made if it is not there yet. */
async function notesFolderFor(folderId: string | null): Promise<NoteLocation> {
  const listing = await fetchNotes();
  const { cloudLibraryFolders } = await import("./library");
  const plan = planNotePlacement({
    notes: [{ id: "", folderId, libraryLocation: null }],
    noteFolders: listing.folders,
    libraryFolders: await cloudLibraryFolders(),
    rootName: creatorNames().notes,
  });
  const idOf = await makePlannedFolders(plan);
  return { residency: "cloud", folderId: idOf(plan.moves[0].folderId) };
}

/** Make a plan's folders, parents first. The answer resolves a folder the
 * plan named — an existing id, or a key it minted — to the id on the shelf. */
async function makePlannedFolders(plan: NotePlacementPlan): Promise<(ref: string | null) => string | null> {
  const { createLibraryFolder } = await import("./library");
  const made = new Map<string, string>();
  const idOf = (ref: string | null) => (ref === null ? null : (made.get(ref) ?? ref));
  for (const f of plan.create) {
    const folder = await createLibraryFolder(f.name, "cloud", idOf(f.parentId));
    made.set(f.key, folder.id);
  }
  return idOf;
}

/** Where loose notes go: the Library folders to make, parents first, and the
 * folder each note files into. A folder is named by an existing folder's id
 * or by the `key` of one this plan makes ("new:0"). */
export interface NotePlacementPlan {
  create: { key: string; name: string; parentId: string | null }[];
  moves: { noteId: string; folderId: string }[];
}

type PlacementInput = {
  notes: Pick<CutNote, "id" | "folderId" | "libraryLocation">[];
  noteFolders: Pick<CutNoteFolder, "id" | "name" | "parentId">[];
  libraryFolders: Pick<LibraryFolder, "id" | "name" | "parentId" | "residency">[];
  /** The Notes folder's name at the cloud Library root. */
  rootName: string;
};

/** Plan where every note with no Library placement goes: the Notes folder at
 * the cloud Library root, under the path of the phone folder it sits in, e.g.
 * a note in Scripts › Hooks lands in Notes › Scripts › Hooks. Folders match by
 * name, so an existing one is reused and a run after this one plans nothing.
 * Placed notes stay where they are. */
export function planNotePlacement(input: PlacementInput): NotePlacementPlan {
  const { notes, noteFolders, libraryFolders, rootName } = input;
  const plan: NotePlacementPlan = { create: [], moves: [] };
  const loose = notes.filter((n) => !n.libraryLocation);
  if (loose.length === 0) {
    return plan;
  }

  // The cloud shelf's folders and the ones this plan makes, looked up by
  // parent and name, so the second note in Scripts finds the folder the first
  // one made.
  const pathKey = (parentId: string | null, name: string) => JSON.stringify([parentId, name]);
  const byPath = new Map<string, string>();
  for (const f of libraryFolders) {
    const key = pathKey(f.parentId ?? null, f.name);
    if (f.residency !== "cloud" || byPath.has(key)) {
      continue;
    }
    byPath.set(key, f.id);
  }
  const folderAt = (parentId: string | null, name: string): string => {
    const key = pathKey(parentId, name);
    const found = byPath.get(key);
    if (found) {
      return found;
    }
    const made = `new:${plan.create.length}`;
    plan.create.push({ key: made, name, parentId });
    byPath.set(key, made);
    return made;
  };

  // Each loose note walks down from Notes along its phone folder's path. A
  // phone folder that is gone leaves the note in Notes itself.
  for (const n of loose) {
    let at = folderAt(null, rootName);
    for (const f of folderTrail(noteFolders, n.folderId)) {
      at = folderAt(at, f.name);
    }
    plan.moves.push({ noteId: n.id, folderId: at });
  }
  return plan;
}

/** A listing with its loose notes filed: how many landed, and how many
 * Library folders were made for them. */
export interface PlacedNotes {
  data: NotesData;
  landed: number;
  madeFolders: number;
}

type PlacementRun = { landed: Map<string, CutNote>; madeFolders: number };

// One placement at a time. A run waiting behind another reads the notes and
// the folders fresh, so it finds what the first one filed and made.
let placementQueue: Promise<unknown> = Promise.resolve();

/** File every note with no Library placement into the Library's Notes
 * folder, and answer with `data` showing where they landed. A listing with
 * nothing loose costs nothing; a failed run is reported and leaves the notes
 * where they were, for the next load to file. */
export async function placeLooseNotes(data: NotesData): Promise<PlacedNotes> {
  if (data.notes.every((n) => !!n.libraryLocation)) {
    return { data, landed: 0, madeFolders: 0 };
  }
  const run = placementQueue.then(runPlacement);
  placementQueue = run.catch(() => null);
  try {
    const { landed, madeFolders } = await run;
    const notes = data.notes.map((n) => {
      const at = landed.get(n.id)?.libraryLocation;
      return at && !n.libraryLocation ? { ...n, libraryLocation: at } : n;
    });
    return { data: { ...data, notes }, landed: landed.size, madeFolders };
  } catch (e) {
    reportSwallowed("Could not file notes into the Library", e);
    return { data, landed: 0, madeFolders: 0 };
  }
}

async function runPlacement(): Promise<PlacementRun> {
  const listing = await fetchNotes();
  if (listing.notes.every((n) => !!n.libraryLocation)) {
    return { landed: new Map(), madeFolders: 0 };
  }
  const { cloudLibraryFolders } = await import("./library");
  const plan = planNotePlacement({
    notes: listing.notes,
    noteFolders: listing.folders,
    libraryFolders: await cloudLibraryFolders(),
    rootName: creatorNames().notes,
  });
  const idOf = await makePlannedFolders(plan);

  // File the notes a batch at a time through the placement route, which
  // sets the Library location alone: the notes keep their stamps, so a
  // phone edit waiting to sync is never overwritten by the filing.
  const byId = new Map(listing.notes.map((n) => [n.id, n]));
  const landed = new Map<string, CutNote>();
  for (let i = 0; i < plan.moves.length; i += NOTE_PLACEMENTS_MAX) {
    const placements = plan.moves.slice(i, i + NOTE_PLACEMENTS_MAX).map((m) => ({
      id: m.noteId,
      libraryLocation: { residency: "cloud" as const, folderId: idOf(m.folderId) },
    }));
    const res = await notesFetch("/api/cut/notes/placements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placements }),
    });
    if (!res.ok) {
      throw new UserError("note_place_failed", "Could not file the notes.");
    }
    const { placed } = (await res.json()) as { placed: string[] };
    const at = new Map(placements.map((p) => [p.id, p.libraryLocation]));
    for (const id of placed) {
      const n = byId.get(id);
      if (n) {
        landed.set(id, { ...n, libraryLocation: at.get(id) ?? null });
      }
    }
  }
  return { landed, madeFolders: plan.create.length };
}

/** Write one note: saved in this browser at once, then sent. The answer is
 * the winning version — this write, or a newer one from the phone — or this
 * write itself while it waits to sync. With no account bound there is no
 * outbox, and the write goes straight to the server. */
export async function saveNote(note: NoteWrite): Promise<CutNote> {
  if (!stageNote(note)) {
    return sendNoteNow(note);
  }
  const saved = await flushNote(note.id);
  if (!saved) throw new UserError("note_save_failed", "Could not save the note.");
  return saved;
}

export async function deleteNote(id: string): Promise<void> {
  dropPendingNote(id);
  const res = await notesFetch(`/api/cut/notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new UserError("note_delete_failed", "Could not delete the note.");
}

/** Delete the notes filed in Library folders on a shelf that keeps no notes
 * of its own — what deleting those folders takes. */
export async function deleteLibraryFolderNotes(residency: "browser" | "local", folderIds: string[]): Promise<void> {
  const res = await notesFetch("/api/cut/notes/library-folders/delete", {
    ...json({ residency, folderIds }),
    method: "POST",
  });
  if (!res.ok) throw new UserError("note_folder_notes_delete_failed", "Could not delete the folder’s notes.");
}

/** Create or rename a label under `id`. A create mints the id here so the
 * new label is on the note before the write returns. */
export async function saveNoteLabel(id: string, name: string): Promise<CutNoteLabel> {
  const res = await notesFetch(
    `/api/cut/notes/labels/${encodeURIComponent(id)}`,
    json({ name }),
  );
  if (!res.ok) throw new UserError("label_save_failed", "Could not save the label.");
  return (await res.json()) as CutNoteLabel;
}

/** Delete a label. Every note carrying it lets it go. */
export async function deleteNoteLabel(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/labels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new UserError("label_delete_failed", "Could not delete the label.");
}
