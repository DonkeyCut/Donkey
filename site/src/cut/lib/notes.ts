"use client";

/**
 * Synced notes, the desktop half. Notes live in the cloud (/api/cut-cloud/notes)
 * and are written from two places — the iOS app and the Notes tab — so every
 * write carries its own `updatedAt` stamp and the server keeps whichever
 * version is newer (last writer wins). Deletes leave tombstones; the list is
 * filtered here so the UI only ever sees live notes.
 */

import { backendFor } from "./residency";

export interface CutNote {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
  updatedAt: number;
  deletedAt: number | null;
  createdAt: number;
}

/** The note paper palette, shared with the iOS app (NoteColor). Index into it
 * with `colorIndex`. */
export const NOTE_COLORS = [
  { background: "#faefb6", accent: "#f2c94c" }, // butter
  { background: "#fbd8d4", accent: "#ef8b80" }, // blush
  { background: "#d5e8fb", accent: "#7fb2ef" }, // sky
  { background: "#d9f3d6", accent: "#82cf7a" }, // mint
  { background: "#e6dcf7", accent: "#a988e0" }, // lilac
] as const;

export const noteColor = (index: number) =>
  NOTE_COLORS[((index % NOTE_COLORS.length) + NOTE_COLORS.length) % NOTE_COLORS.length];

const notesFetch = (path: string, init?: RequestInit) =>
  backendFor("cloud").fetch(path, init);

/** Every live note, newest first. Tombstones are the phone's concern; the
 * desktop just drops them. */
export async function fetchNotes(): Promise<CutNote[]> {
  const res = await notesFetch("/api/cut/notes");
  if (!res.ok) throw new Error("Could not load notes.");
  const body = (await res.json()) as { notes?: CutNote[] };
  return (body.notes ?? []).filter((n) => n.deletedAt === null);
}

/** Write one note. The server answers with the winning version — this write,
 * or a newer one from the phone. */
export async function saveNote(note: {
  id: string;
  title: string;
  body: string;
  colorIndex: number;
}): Promise<CutNote> {
  const res = await notesFetch(`/api/cut/notes/${encodeURIComponent(note.id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...note, updatedAt: Date.now() }),
  });
  if (!res.ok) throw new Error("Could not save the note.");
  return (await res.json()) as CutNote;
}

export async function deleteNote(id: string): Promise<void> {
  const res = await notesFetch(`/api/cut/notes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Could not delete the note.");
}
