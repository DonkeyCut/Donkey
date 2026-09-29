import { z } from "zod";
import { NOTE_LABELS_MAX } from "@/cut/lib/types";
import type { AssetRef } from "@/cut/lib/assetRef";
import type { CutNote } from "@/cut/lib/notes";
import { normalizeLink } from "@/cut/lib/link";

export const noteIdSchema = z.string().regex(/^[\w-]{1,64}$/);
export const noteLocationSchema = z.object({
  folderId: z.string().min(1).max(128),
  residency: z.enum(["browser", "local", "cloud"]),
});
export type NoteLocation = z.infer<typeof noteLocationSchema>;
export const noteUnfileSchema = z.object({ residency: z.enum(["browser", "local", "cloud"]), folderIds: z.array(z.string().min(1).max(128)).max(10000) });
export const noteReadSchema = z.object({ id: noteIdSchema.optional(), link: z.string().optional() });
export const noteSaveSchema = z.object({
  id: noteIdSchema.optional().describe("Existing note id; omit to create a note"),
  title: z.string().max(200).optional(),
  body: z.string().max(20_000).optional(),
  colorIndex: z.number().int().optional(),
  labelIds: z.array(noteIdSchema).max(NOTE_LABELS_MAX).optional(),
  libraryLocation: noteLocationSchema.nullable().optional().describe("Library folder and shelf; null files at the Library root"),
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
