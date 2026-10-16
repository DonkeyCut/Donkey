"use client";

import { apiJson } from "@/cut/lib/backend";
import { cloudBackend } from "@/cut/lib/backend/cloud";
import { pollCloudJob } from "@/cut/lib/cloudJob";
import { presignedUpload } from "@/cut/lib/media";
import type { ConvertMode } from "@/cut/lib/convertMode";
import type { CompatCover } from "@/cut/lib/proxyNames";
import type { LibraryAsset, LibrarySource } from "@/cut/lib/library";
import type { LibraryUploadStage, LibraryUploadState } from "@/cut/lib/libraryUpload";

export type CloudUploadOptions = {
  name?: string;
  source?: LibrarySource;
  folderId?: string | null;
  maxHeight?: number;
  mode?: ConvertMode;
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
      ...(options.mode === "reencode" ? { mode: options.mode } : {}),
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

/** The compat proxy (proxyNames.ts) of media the page holds, made by the
 * cloud worker: the file stages on the cloud shelf, the proxy comes back,
 * and both leave the shelf. */
export async function compatInTheCloud(file: File, cover: CompatCover, onProgress?: (p: number) => void): Promise<Blob> {
  const failed = "Could not make the preview proxy.";
  const asset = await uploadCloudLibraryMedia(file, { name: file.name });
  try {
    const res = await cloudBackend.fetch(`/api/cut/library/${encodeURIComponent(asset.id)}/proxy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ compat: cover }),
    });
    const body = await apiJson<LibraryAsset | { jobId: string }>(res);
    if (!res.ok) throw new Error(body.error ?? failed);
    const landed = "jobId" in body
      ? await pollCloudJob<LibraryAsset>(body.jobId, cloudBackend, failed, { timedOut: "The preview proxy took too long.", onProgress })
      : body;
    if (!landed.proxyFile) throw new Error(failed);
    const media = await cloudBackend.fetch(`/api/cut/library/media/${encodeURIComponent(landed.proxyFile)}`);
    if (!media.ok) throw new Error(failed);
    return await media.blob();
  } finally {
    await cloudBackend.fetch(`/api/cut/library/${encodeURIComponent(asset.id)}`, { method: "DELETE" }).catch(() => {});
  }
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
