import { z } from "zod";

export const CLOUD_LIBRARY_IMPORT_DESCRIPTION =
  "Cloud Library uploads accept original video and audio files. The cloud prepares playable media automatically and retains the original for download.";

export const libraryUploadSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1).max(512),
  maxHeight: z.number().int().min(2).max(8192).optional(),
  folderId: z.string().min(1).nullable().optional(),
  source: z.object({
    url: z.string().url(),
    title: z.string().optional(),
    uploader: z.string().optional(),
    uploadDate: z.string().optional(),
  }).optional(),
});

export type LibraryUploadInput = z.infer<typeof libraryUploadSchema>;
export type LibraryUploadState = { key?: string };
export type LibraryUploadStage = "uploading" | "queued" | "preparing";

export const libraryUploadId = (objectId: string) => `library-upload-${objectId}`;
