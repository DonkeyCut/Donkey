"use client";

/**
 * Synced notes, the desktop half. Notes live in the cloud (/api/cut-cloud/notes)
 * and are written from two places — the iOS app and the Notes tab — so every
 * write carries its own `updatedAt` stamp and the server keeps whichever
 * version is newer (last writer wins). Deletes leave tombstones; the list is
 * filtered here so the UI only ever sees live notes.
 *
 * Notes file into folders, the same way the library's do. Folder ids are
 * client-generated so the phone can make one offline, and the one PUT both
 * creates and renames.
 */

import { backendFor } from "./residency";

export interface CutNote {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

export interface CutNoteFolder {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
}

export interface NotesData {
  notes: CutNote[];
  folders: CutNoteFolder[];
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
 * are the phone's concern; the desktop just drops them. */
export async function fetchNotes(): Promise<NotesData> {
  const res = await notesFetch("/api/cut/notes");
  if (!res.ok) throw new Error("Could not load notes.");
  const body = (await res.json()) as Partial<NotesData>;
  return {
    notes: (body.notes ?? []).filter((n) => n.deletedAt === null),
    folders: body.folders ?? [],
  };
}

/** Write one note. The server answers with the winning version — this write,
 * or a newer one from the phone. */
export async function saveNote(note: {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  folderId: string | null;
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

/** Create or rename a folder under `id`. A create mints the id here so the
 * new folder is on screen before the write returns. */
export async function saveNoteFolder(id: string, name: string): Promise<CutNoteFolder> {
  const res = await notesFetch(
    `/api/cut/notes/folders/${encodeURIComponent(id)}`,
    json({ name }),
  );
  if (!res.ok) throw new Error("Could not save the folder.");
  return (await res.json()) as CutNoteFolder;
}

/** Delete a folder. Its notes come back to the top level. */
export async function deleteNoteFolder(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/folders/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the folder.");
}
