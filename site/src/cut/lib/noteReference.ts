import { z } from "zod";
import { NOTE_LABELS_MAX } from "@/cut/lib/types";
import type { AssetRef } from "@/cut/lib/assetRef";
import type { CutNote } from "@/cut/lib/notes";
import { normalizeLink } from "@/cut/lib/link";
import { NOTE_BODY_FORMAT } from "@/cut/lib/noteMarkdown";

export const noteIdSchema = z.string().regex(/^[\w-]{1,64}$/);
export const noteLocationSchema = z.object({
  folderId: z.string().min(1).max(128).nullable(),
  residency: z.enum(["browser", "local", "cloud"]),
});
export type NoteLocation = z.infer<typeof noteLocationSchema>;
export const NOTE_LIBRARY_LOCATION_DESCRIPTION = "Library placement requires a residency and folderId; folderId:null selects that shelf's Library root. libraryLocation:null keeps the note in Notes without Library placement.";
export function noteInLibraryFolder(note: Pick<CutNote, "libraryLocation">, folderId: string | null, residency?: NoteLocation["residency"]): boolean {
  const location = note.libraryLocation;
  return !!location && location.folderId === folderId && (!residency || location.residency === residency);
}
// A note placed in the Library lives there alone; Notes shows only the rest.
export function noteInNotesFolder(note: Pick<CutNote, "folderId" | "libraryLocation">, folderId: string | null): boolean {
  if (note.libraryLocation) {
    return false;
  }
  return (note.folderId ?? null) === folderId;
}
export const noteLibraryFoldersSchema = z.object({ residency: z.enum(["browser", "local", "cloud"]), folderIds: z.array(z.string().min(1).max(128)).max(10000) });
export const noteReadSchema = z.object({ id: noteIdSchema.optional(), link: z.string().optional() });
export const noteSaveSchema = z.object({
  id: noteIdSchema.optional().describe("Existing note id; omit to create a note"),
  title: z.string().max(200).optional(),
  body: z.string().max(20_000).optional().describe(NOTE_BODY_FORMAT),
  colorIndex: z.number().int().optional(),
  labelIds: z.array(noteIdSchema).max(NOTE_LABELS_MAX).optional(),
  libraryLocation: noteLocationSchema.nullable().optional().describe(NOTE_LIBRARY_LOCATION_DESCRIPTION),
});
export function noteRef(note: Pick<CutNote, "id" | "title">): AssetRef {
  return { scope: "note", id: note.id, name: `Notes / ${note.title || "Untitled"}`.replace(/"/g, "”").replace(/\s+/g, " "), kind: "text",
    url: `data:text/plain;charset=utf-8,${encodeURIComponent(JSON.stringify({ tool: "read_note", id: note.id }))}` };
}
export function parseNoteLink(value: string): string | null {
  let url: URL;
  try { url = new URL(normalizeLink(value)); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol) || !["donkeycut.com", "www.donkeycut.com", "localhost", "cut.localhost", "127.0.0.1"].includes(url.hostname)) return null;
  if (!/^\/(cut\/)?app\/(notes|library)\/?$/.test(url.pathname)) return null;
  const result = noteIdSchema.safeParse(url.searchParams.get("note"));
  return result.success ? result.data : null;
}
