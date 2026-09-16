import { z } from "zod";

export const LIBRARY_SHARE_KINDS = ["folder", "asset"] as const;
export const SHARE_ACCESS = ["restricted", "public"] as const;
export const LIBRARY_SHARE_ACTIONS = ["get", "save", "remove"] as const;
export const shareEmailSchema = z.string().trim().toLowerCase().email().max(254);
export const shareSettingsSchema = z.object({
  access: z.enum(SHARE_ACCESS),
  emails: z.array(shareEmailSchema).max(50)
    .transform((emails) => [...new Set(emails)]),
});
export const libraryShareTargetSchema = z.object({
  kind: z.enum(LIBRARY_SHARE_KINDS),
  id: z.string().min(1).max(128),
});
export type LibraryShareTarget = z.infer<typeof libraryShareTargetSchema>;
export type ShareSettings = z.infer<typeof shareSettingsSchema>;
export type LibraryShareState = ShareSettings & { id: string };
export type SharedLibraryAsset = {
  id: string;
  name: string;
  type: "video" | "audio" | "image" | "font";
  duration: number;
  fileName: string;
  width?: number;
  height?: number;
  hasPoster?: boolean;
};
export type SharedLibraryPage = {
  name: string;
  kind: LibraryShareTarget["kind"];
  trail: { id: string; name: string }[];
  folders: { id: string; name: string }[];
  assets: SharedLibraryAsset[];
  templates: { id: string; name: string; files: { name: string; fileName: string }[] }[];
  next: number | null;
};
export const librarySharePath = (token: string) => `/s/library/${encodeURIComponent(token)}`;
export const libraryShareApiPath = ({ kind, id }: LibraryShareTarget) =>
  `/api/cut/library/shares/${kind}/${encodeURIComponent(id)}`;
