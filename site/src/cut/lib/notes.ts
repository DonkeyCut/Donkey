"use client";

/**
 * Synced notes, the desktop half. Notes live in the cloud (/api/cut-cloud/notes)
 * and are written from two places — the iOS app and the Notes tab — so every
 * write carries its own `updatedAt` stamp and the server keeps whichever
 * version is newer (last writer wins). Deletes leave tombstones; the list is
 * filtered here so the UI only ever sees live notes.
 *
 * Notes file into folders, the same way the library's do, and folders file
 * into folders. Folder ids are client-generated so the phone can make one
 * offline, and the one PUT creates, renames and moves.
 */

import { backendFor } from "./residency";

export interface CutNote {
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
  if (!res.ok) throw new Error("Could not load notes.");
  const body = (await res.json()) as Partial<NotesData>;
  const folders = body.folders ?? [];
  const known = new Set(folders.map((f) => f.id));
  return {
    notes: (body.notes ?? []).filter((n) => n.deletedAt === null),
    folders: folders.map((f) => ({
      ...f,
      parentId: f.parentId && known.has(f.parentId) ? f.parentId : null,
    })),
    labels: body.labels ?? [],
  };
}

/** Whether `folderId` is `ancestorId` or filed somewhere under it. */
export function folderWithin(
  folders: readonly CutNoteFolder[],
  folderId: string | null,
  ancestorId: string,
): boolean {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  let cur = folderId;
  for (let steps = 0; cur && steps <= folders.length; steps++) {
    if (cur === ancestorId) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
}

/** The folders from the top level down to `folderId`, the open one last. */
export function folderTrail(
  folders: readonly CutNoteFolder[],
  folderId: string | null,
): CutNoteFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: CutNoteFolder[] = [];
  let cur = folderId ? byId.get(folderId) : undefined;
  while (cur && trail.length <= folders.length) {
    trail.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return trail;
}

/** Write one note. The server answers with the winning version — this write,
 * or a newer one from the phone. */
export async function saveNote(note: {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  labelIds: string[];
}): Promise<CutNote> {
  const res = await notesFetch(
    `/api/cut/notes/${encodeURIComponent(note.id)}`,
    json({ ...note, updatedAt: Date.now() }),
  );
  if (!res.ok) throw new Error("Could not save the note.");
  return (await res.json()) as CutNote;
}

export async function deleteNote(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the note.");
}

/** Create, rename or move a folder under `id`. A create mints the id here so
 * the new folder is on screen before the write returns. The server answers
 * with the folder as stored: a parent it could not honor reads back as the
 * top level. */
export async function saveNoteFolder(
  id: string,
  folder: { name: string; parentId: string | null },
): Promise<CutNoteFolder> {
  const res = await notesFetch(
    `/api/cut/notes/folders/${encodeURIComponent(id)}`,
    json(folder),
  );
  if (!res.ok) throw new Error("Could not save the folder.");
  return (await res.json()) as CutNoteFolder;
}

/** Delete a folder. What it held comes up one level. */
export async function deleteNoteFolder(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the folder.");
}

/** Create or rename a label under `id`. A create mints the id here so the
 * new label is on the note before the write returns. */
export async function saveNoteLabel(id: string, name: string): Promise<CutNoteLabel> {
  const res = await notesFetch(
    `/api/cut/notes/labels/${encodeURIComponent(id)}`,
    json({ name }),
  );
  if (!res.ok) throw new Error("Could not save the label.");
  return (await res.json()) as CutNoteLabel;
}

/** Delete a label. Every note carrying it lets it go. */
export async function deleteNoteLabel(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/labels/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the label.");
}
