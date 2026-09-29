"use client";

import { apiJson } from "@/cut/lib/backend";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { pollCloudJob } from "@/cut/lib/cloudJob";
import { presignedUpload } from "@/cut/lib/media";
import type { LibraryAsset, LibrarySource } from "@/cut/lib/library";
import type { LibraryUploadStage, LibraryUploadState } from "@/cut/lib/libraryUpload";

export type CloudUploadOptions = {
  name?: string;
  source?: LibrarySource;
  folderId?: string | null;
  maxHeight?: number;
  state?: LibraryUploadState;
  onStage?: (stage: LibraryUploadStage) => void;
};

/** The original uploads once; retries resume preparation by its storage key. */
export async function uploadCloudLibraryMedia(file: File, options: CloudUploadOptions = {}): Promise<LibraryAsset> {
  const state = options.state ?? {};
  if (!state.key) {
    options.onStage?.("uploading");
    state.key = await presignedUpload("/api/cut/library/presign", file, file.name, cloudBackend);
  }
  options.onStage?.("preparing");
  const res = await cloudBackend.fetch("/api/cut/library/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: state.key, name: options.name ?? file.name,
      ...(options.folderId ? { folderId: options.folderId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
    }),
  });
  const body = await apiJson<LibraryAsset | { jobId: string }>(res);
  if (!res.ok) throw new Error(body.error ?? "Could not prepare this upload.");
  const asset = "jobId" in body ? await pollCloudJob<LibraryAsset>(body.jobId, cloudBackend,
    "Could not prepare this upload.", {
      timedOut: "This file is still being prepared. Retry to check its progress.",
      onState: (status) => options.onStage?.(status === "queued" ? "queued" : "preparing"),
    }) : body;
  if (!asset.id || !asset.fileName) throw new Error("The import returned no media.");
  return { ...asset, residency: "cloud" };
}

/** A browser without a decoder borrows cloud preparation and takes the result home. */
export async function withCloudPreparedMedia<T>(
  file: File,
  adopt: (file: File) => Promise<T>,
  options: CloudUploadOptions = {},
): Promise<T> {
  const asset = await uploadCloudLibraryMedia(file, options);
  let prepared: File;
  try {
    const response = await cloudBackend.fetch(`/api/cut/library/media/${encodeURIComponent(asset.fileName)}`);
    if (!response.ok) throw new Error("Could not read the prepared media.");
    const blob = await response.blob();
    prepared = new File([blob], asset.fileName, { type: blob.type });
  } finally {
    const removed = await cloudBackend.fetch(`/api/cut/library/${encodeURIComponent(asset.id)}`, { method: "DELETE" });
    if (!removed.ok) throw new Error("Could not remove the temporary cloud import.");
    if (options.state) delete options.state.key;
  }
  // Finish staging cleanup before adoption so a cleanup retry cannot import twice.
  return adopt(prepared);
}
