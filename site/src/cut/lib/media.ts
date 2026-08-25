"use client";

import { scanSilence, scanSpeech, type PcmChunk, type SpeechScan } from "./audioScan";
import { apiFetch, apiJson, getBackend, type CutBackend } from "./backend";
import { cloudBackend } from "./backend/cloud";
import { pollCloudJob } from "./cloudJob";
import { quotaErrorMessage } from "./backend/cloud";
import { encodeWav } from "./cloudTranscribe";
import { normalizeLink } from "./link";
import { downloadFromUrl } from "./download";
import { startUpload, uploadInFlight } from "./importQueue";
import { convertProjectFile, dropProjectFile, mp4DisplayName } from "./mediaConvert";
import {
  audioChunks,
  audioPeaks,
  audioTrackOf,
  decodeAudioSpan,
  frameAt,
  framesAt,
  frameSink,
  openMedia,
  probeMediaFile,
  UnreadableMediaError,
  videoTrackOf,
} from "./mediaRead";
import {
  clearPendingUpload,
  dropLocalMedia,
  localMediaFile,
  localMediaUrl,
  pendingUploadsFor,
  renameLocalMedia,
  stashCloudMedia,
  stashUnclaimedMedia,
} from "./mediaSync";
import {
  createRasterCanvas,
  decodeRasterImage,
  decodeRasterImageUrl,
  rasterCanvasToBlob,
  rasterCanvasToDataUrl,
  type RasterSurface,
} from "./raster";
import { pickThumbTimes, type ThumbProbe } from "./filmstrip";
import { reportSwallowed } from "./report";
import { useEditor } from "./store";
import type { AssetType, AudioClip, MediaAsset, ProjectSummary, StoredAsset, VideoClip, WatchKeepReason } from "./types";
import { contentRect, IMAGE_CLIP_SECONDS, mediaUrl } from "./types";
import { createDedupSelector, DEDUP_TUNING } from "./watch/dedupSelector";
import { diffCellPct, frameSig } from "./watch/signatures";
import { SIGNATURE_SIZE } from "./watch/types";

const uid = () => crypto.randomUUID().slice(0, 8);

/** True when a dropped OS file is something Cut can turn into a project. */
export function isMediaFile(file: File) {
  return (
    file.type.startsWith("video/") ||
    file.type.startsWith("audio/") ||
    file.type.startsWith("image/") ||
    isVideoFile(file) ||
    isAudioFile(file) ||
    isImageFile(file)
  );
}

/** Create a fresh project seeded from a single desktop file: upload the media,
 * lay it on the timeline, and persist — no editor round-trip. Returns the new
 * project's id, or null if the file isn't video/audio. */
export async function createProjectFromFile(
  file: File,
  folderId: string | null
): Promise<string | null> {
  if (!isMediaFile(file)) return null;
  const name = file.name.replace(/\.[^./]+$/, "") || "Untitled";
  const res = await apiFetch("/api/cut/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, folderId }),
  });
  const project = await apiJson<ProjectSummary>(res);
  if (!res.ok || !project.id) throw new Error(project.error ?? "Could not create the project.");

  const asset = await importFileToProject(project.id, file);
  // Media the engine rejects leaves an empty project rather than a dangling id.
  if (!asset) return project.id;

  const stored: StoredAsset = {
    id: asset.id,
    fileName: asset.fileName,
    name: asset.name,
    type: asset.type,
    duration: asset.duration,
    ...(asset.width !== undefined ? { width: asset.width } : {}),
    ...(asset.height !== undefined ? { height: asset.height } : {}),
  };
  const doc: Partial<{ assets: StoredAsset[]; clips: VideoClip[]; audioClips: AudioClip[] }> = {
    assets: [stored],
  };
  if (asset.type === "video" || asset.type === "image") {
    const out = asset.type === "image" ? IMAGE_CLIP_SECONDS : asset.duration;
    doc.clips = [{ id: uid(), assetId: asset.id, track: 0, start: 0, in: 0, out, muted: false }];
  } else {
    doc.audioClips = [
      { id: uid(), assetId: asset.id, start: 0, in: 0, out: asset.duration, volume: 1 },
    ];
  }
  await apiFetch(`/api/cut/projects/${project.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(doc),
  });
  return project.id;
}

/** Save a project media file to the user's Downloads folder — the everywhere
 * counterpart to revealing it in Finder.
 *
 * What lands is the source file itself: import stores the bytes it was handed
 * and every derivative (proxy, ladder, filmstrip, export) is a separate file,
 * so the media route is already the original. An asset whose bytes are still
 * uploading has no server copy to serve, so it has nothing to download yet.
 * `backend` pins the shelf the asset lives on when the ambient one may have
 * moved on. */
export function downloadMedia(projectId: string, asset: MediaAsset, backend?: CutBackend) {
  if (asset.upload) return;
  downloadFromUrl(mediaUrl(projectId, asset.fileName, backend), asset.fileName);
}

/** Reveal a project media file in Finder (local engine only). */
export async function revealMedia(projectId: string, fileName: string) {
  await apiFetch(
    `/api/cut/projects/${projectId}/media/${encodeURIComponent(fileName)}/reveal`,
    { method: "POST" }
  );
}

export function isVideoFile(file: File) {
  return file.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name);
}

export function isAudioFile(file: File) {
  return file.type.startsWith("audio/") || /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(file.name);
}

export function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(file.name);
}

export function isTextFile(file: File) {
  return file.type.startsWith("text/") || /\.(txt|md|markdown|srt|vtt|csv|json)$/i.test(file.name);
}

/** A font file the Library takes. Browsers often report an empty type for
 * .otf, so the extension has the final say. */
export function isFontFile(file: File) {
  return file.type.startsWith("font/") || /\.(ttf|otf|woff2?)$/i.test(file.name);
}

/** The kind mark a card wears for a file: its extension, uppercased. Empty for
 * a name that carries none. */
export const fileKind = (fileName: string) =>
  (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "").toUpperCase();

/** Fonts are small; a file past this is a mistake worth catching before the
 * bytes move. The storage quota is the real ceiling. */
export const MAX_FONT_BYTES = 10 * 1024 ** 2;

/** Claim a name and mint a direct-to-R2 PUT for one file. The name is deduped
 * and reserved server-side before the URL comes back, so callers can build the
 * asset's final identity before a single byte moves. */
export async function presignUpload(
  presignPath: string,
  file: Blob,
  name: string,
  backend: CutBackend = getBackend(),
  extra: Record<string, unknown> = {}
): Promise<{ key: string; url: string; fileName: string }> {
  const mime = file.type || "application/octet-stream";
  const res = await backend.fetch(presignPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: name, mime, bytes: file.size, ...extra }),
  });
  const body = await apiJson<{ key?: string; url?: string; fileName?: string }>(res);
  if (!res.ok || !body.key || !body.url) {
    const err = new Error(
      quotaErrorMessage(res.status, body) ?? body.error ?? "Upload failed."
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return { key: body.key, url: body.url, fileName: body.fileName ?? name };
}

/** Presign a direct-to-R2 upload, PUT the bytes, and return the object key
 * for the follow-up complete call. Shared by project media, the library, and
 * export overlays; cloud backend only. */
export async function presignedUpload(
  presignPath: string,
  file: Blob,
  name: string,
  backend: CutBackend = getBackend()
): Promise<string> {
  const signed = await presignUpload(presignPath, file, name, backend);
  await putSigned(signed.url, file, file.type || "application/octet-stream");
  return signed.key;
}

/** PUT a blob to a presigned R2 URL. XHR because it is the only way to watch
 * the bytes leave, which is what an upload running behind the editor has to
 * report. A headless runtime has no XHR and nobody watching; fetch covers it. */
export function putSigned(
  url: string,
  file: Blob,
  mime?: string,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<void> {
  if (typeof XMLHttpRequest === "undefined") {
    return fetch(url, {
      method: "PUT",
      headers: { "Content-Type": mime ?? (file.type || "application/octet-stream") },
      body: file,
      signal: opts?.signal,
    }).then((res) => {
      if (!res.ok) throw new Error("Upload failed.");
      opts?.onProgress?.(1);
    });
  }
  return new Promise((resolve, reject) => {
    if (opts?.signal?.aborted) return reject(new DOMException("Upload cancelled.", "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", mime ?? (file.type || "application/octet-stream"));
    if (opts?.onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress!(e.loaded / e.total);
      };
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed."));
    xhr.onerror = () => reject(new Error("Upload failed."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled.", "AbortError"));
    opts?.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Upload raw media bytes into a project. Local: the engine's multipart POST,
 * byte-identical to the pre-seam request. Cloud: presign -> direct R2 PUT ->
 * complete. Returns the stored (deduped) file name. */
export function uploadProjectMedia(projectId: string, file: Blob, name: string): Promise<string> {
  return uploadProjectMediaTo(getBackend(), projectId, file, name);
}

/** `uploadProjectMedia` against an explicit backend — cross-residency copies
 * upload to a backend that is not the globally bound one. */
export async function uploadProjectMediaTo(
  backend: CutBackend,
  projectId: string,
  file: Blob,
  name: string,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<string> {
  if (backend.kind !== "cloud") {
    const form = new FormData();
    form.append("file", file, name);
    const res = await backend.fetch(`/api/cut/projects/${projectId}/media`, {
      method: "POST",
      body: form,
      signal: opts?.signal,
    });
    const body = await apiJson<{ fileName?: string }>(res);
    if (!res.ok || !body.fileName) throw new Error(body.error ?? "Upload failed.");
    return body.fileName;
  }
  const signed = await presignUpload(
    `/api/cut/projects/${projectId}/media/presign`,
    file,
    name,
    backend
  );
  await putSigned(signed.url, file, file.type || "application/octet-stream", opts);
  const key = signed.key;
  const res = await backend.fetch(`/api/cut/projects/${projectId}/media/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const body = await apiJson<{ fileName?: string }>(res);
  if (!res.ok || !body.fileName) throw new Error(body.error ?? "Upload failed.");
  return body.fileName;
}

// The cloud /image mirror only takes inline multipart bodies below ~3.5MB;
// larger images ride the presign path.
const IMAGE_INLINE_MAX = 3 * 1024 * 1024;

/** Store an image blob as a first-class project image asset. Local (and small
 * cloud payloads): the engine's /image multipart route, byte-identical to the
 * pre-seam request. Large cloud payloads: presign -> R2 PUT -> complete, with
 * the dimensions probed here instead of by the server. */
export async function uploadProjectImage(
  projectId: string,
  file: Blob,
  fileName: string,
  opts?: { name?: string; origin?: "generated" | "sticker"; failMessage?: string; backend?: CutBackend }
): Promise<MediaAsset> {
  // Callers whose work outlives navigation (finishing AI generations) pin the
  // backend they started on; everyone else rides the active one.
  const backend = opts?.backend ?? getBackend();
  const failMessage = opts?.failMessage ?? "Could not add the image.";
  if (backend.kind !== "cloud" || file.size < IMAGE_INLINE_MAX) {
    const form = new FormData();
    form.append("file", file, fileName);
    if (opts?.name !== undefined) form.append("name", opts.name);
    if (opts?.origin) form.append("origin", opts.origin);
    const res = await backend.fetch(`/api/cut/projects/${projectId}/image`, {
      method: "POST",
      body: form,
    });
    const body = await apiJson<MediaAsset>(res);
    if (!res.ok || !body.fileName) {
      throw new Error(quotaErrorMessage(res.status, body) ?? body.error ?? failMessage);
    }
    return { ...body, url: mediaUrl(projectId, body.fileName, backend) };
  }
  const stored = await uploadProjectMediaTo(backend, projectId, file, fileName);
  const url = mediaUrl(projectId, stored, backend);
  const dims = await loadImageMeta(url);
  return {
    id: uid(),
    type: "image",
    name: opts?.name?.trim() || fileName,
    fileName: stored,
    duration: 0,
    width: dims.width,
    height: dims.height,
    ...(opts?.origin ? { origin: opts.origin } : {}),
    url,
  };
}

/** The kind of asset a dropped file becomes, or null if Cut can't use it.
 * MIME wins over extension: recordings are .webm for both video and audio. */
export function assetTypeOf(file: File): AssetType | null {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  if (file.type.startsWith("image/")) return "image";
  if (isVideoFile(file)) return "video";
  if (isAudioFile(file)) return "audio";
  if (isImageFile(file)) return "image";
  return null;
}

type ProbedMeta = {
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
  peaks?: number[];
};

/** Read a media source's kind/duration/dimensions from its container. The
 * probe can correct the guessed kind: a "video" container with no video track
 * is really audio, and an "audio" one that turns out to carry picture is video.
 *
 * The duration is exact, which matters — it is a placed clip's length, and the
 * metadata a player reports overestimates MP3s badly enough to leave a clip
 * running past its own audio. */
async function probeMedia(type: AssetType, src: string | Blob): Promise<ProbedMeta> {
  if (type === "image") {
    // Images have no intrinsic duration; the timeline clip carries its length.
    // Stills are the one kind read through the browser's image decoder rather
    // than the container reader, which does not do them.
    if (typeof Image === "undefined") {
      // Headless runtime: decode through the raster seam (skia in the worker).
      const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
      const img = await decodeRasterImage(blob);
      if (!img) throw new UnreadableMediaError();
      return { type, duration: 0, width: img.width, height: img.height };
    }
    const url = typeof src === "string" ? src : URL.createObjectURL(src);
    try {
      const dims = await loadImageMeta(url);
      return { type, duration: 0, width: dims.width, height: dims.height };
    } finally {
      if (typeof src !== "string") URL.revokeObjectURL(url);
    }
  }
  const meta = await probeMediaFile(src);
  if (!meta.hasVideo) {
    // The waveform rides along with the probe: the file is open and its audio
    // is being read either way, so enrichAsset has nothing left to do.
    return { type: "audio", duration: meta.duration, peaks: await makePeaks(src, meta.duration) };
  }
  return { type: "video", duration: meta.duration, width: meta.width, height: meta.height };
}

/** Probe a media file's kind/duration/dimensions from the bytes in hand — for
 * backends that can't probe server-side (cloud library complete). */
export async function probeFileMeta(file: File): Promise<{
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
}> {
  const meta = await probeMedia(assetTypeOf(file) ?? "video", file);
  return { type: meta.type, duration: meta.duration, width: meta.width, height: meta.height };
}

/** An import that is on screen before its bytes have left the browser. */
export type PendingImport = {
  /** Ready to add to the project: plays from `localUrl`, carries its final
   * `fileName`, and is marked `upload` until the bytes land. */
  asset: MediaAsset;
  /** The URL the asset plays from until the stored file takes over — a local
   * object URL for a dropped file, the source URL for remote media. */
  localUrl: string;
  /** Send the bytes and mark the object complete; resolves to the stored
   * (deduped) file name the asset swaps to. */
  send: (opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<string>;
};

/** Prepare a dropped file so it can appear instantly: reserve its stored name
 * and probe it from local bytes, both before anything is uploaded. The caller
 * adds the asset, then runs `send` in the background.
 *
 * Cloud only. The engine takes a file's bytes and hands back its name in one
 * request, so there is no name to build an asset around ahead of time — and a
 * copy to local disk is quick enough that there is nothing to hide. */
export async function prepareImport(
  projectId: string,
  file: File,
  backend: CutBackend = getBackend()
): Promise<PendingImport | null> {
  if (backend.kind !== "cloud") return null;
  const type = assetTypeOf(file);
  if (!type) return null;

  const objectUrl = URL.createObjectURL(file);
  try {
    // Probing and claiming the name are independent, so the asset is ready
    // after whichever is slower rather than after both in turn. The probe
    // reads the dropped bytes rather than the object URL, so it never goes
    // back through the network stack for a file already in hand.
    const metaP = probeMedia(type, file);
    let signed: { key: string; url: string; fileName: string } | null = null;
    let stashed: { fileName: string; url: string } | null = null;
    // Names this browser already pinned locally (413-era stashes with no cloud
    // row): the cloud can't see them, so its dedupe is told to steer clear —
    // a claim on one of them would overwrite the only copy of another file.
    const avoid = (await pendingUploadsFor(projectId)).map((p) => p.fileName);
    try {
      signed = await presignUpload(
        `/api/cut/projects/${projectId}/media/presign`,
        file,
        file.name,
        backend,
        avoid.length > 0 ? { avoid } : {}
      );
    } catch (err) {
      // A full account still imports: the bytes stay in the browser store
      // under a locally deduped name, pinned until the drain claims a cloud
      // name for them once there is room.
      const status = (err as { status?: number }).status;
      stashed = status === 413 ? await stashUnclaimedMedia(projectId, file) : null;
      if (!stashed) {
        await metaP.catch(() => {});
        throw err;
      }
    }
    // Local-first: the bytes land in the browser store under the claimed name
    // before they leave it, so the asset saves into the document now and the
    // upload drains behind it, surviving reloads through the store's ledger.
    // A browser that can't hold the store keeps the tab-scoped object URL.
    const storedUrl = signed
      ? await stashCloudMedia(projectId, file, signed.fileName)
      : stashed!.url;
    const fileName = signed ? signed.fileName : stashed!.fileName;
    // Footage this browser has no decoder for imports the plain way instead:
    // the file reaches the project first and converts there, which local-first
    // can't do — the optimistic asset would be one nothing here can play.
    const meta = await metaP.catch((e: unknown) => {
      if (e instanceof UnreadableMediaError && e.undecodable) return null;
      throw e;
    });
    if (!meta) {
      URL.revokeObjectURL(objectUrl);
      await dropLocalMedia(projectId, fileName);
      return null;
    }
    const localUrl = storedUrl ?? objectUrl;
    if (storedUrl) URL.revokeObjectURL(objectUrl);
    const asset: MediaAsset = {
      id: uid(),
      fileName,
      name: file.name,
      type: meta.type,
      duration: meta.duration,
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
      ...(meta.peaks ? { peaks: meta.peaks } : {}),
      url: localUrl,
      upload: { progress: 0, ...(storedUrl ? { stored: true } : {}) },
    };
    const claim = signed;
    const send = claim
      ? async (opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => {
          await putSigned(claim.url, file, file.type || "application/octet-stream", opts);
          const res = await backend.fetch(`/api/cut/projects/${projectId}/media/complete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: claim.key }),
          });
          const body = await apiJson<{ fileName?: string }>(res);
          if (!res.ok || !body.fileName) throw new Error(body.error ?? "Upload failed.");
          await clearPendingUpload(projectId, body.fileName);
          return body.fileName;
        }
      : sendStoredUpload(backend, projectId, stashed!.fileName);
    return { asset, localUrl, send };
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

/** The drain for a store-backed upload, built from the stored bytes alone so
 * a reload can resume it: reclaim the cloud name, PUT the file, complete, and
 * unpin. The cloud's answer is the final name; when it drifts from the local
 * one (a 413-era stash claiming its first cloud name), the local copy is
 * renamed to match and the new name flows back to the asset. */
export function sendStoredUpload(
  backend: CutBackend,
  projectId: string,
  fileName: string
): PendingImport["send"] {
  return async (opts) => {
    const file = await localMediaFile(projectId, fileName);
    if (!file) throw new Error("The local copy of this file is gone.");
    const mime = file.type || "application/octet-stream";
    // Steer the cloud's dedupe around the other pinned names, never this one:
    // this drain is the pin's own claim.
    const avoid = (await pendingUploadsFor(projectId))
      .map((p) => p.fileName)
      .filter((n) => n !== fileName);
    const res = await backend.fetch(`/api/cut/projects/${projectId}/media/presign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName,
        mime,
        bytes: file.size,
        resume: true,
        ...(avoid.length > 0 ? { avoid } : {}),
      }),
    });
    const body = await apiJson<{ key?: string; url?: string; fileName?: string; done?: boolean }>(
      res
    );
    if (!res.ok || !body.fileName || (!body.done && !(body.url && body.key))) {
      throw new Error(quotaErrorMessage(res.status, body) ?? body.error ?? "Upload failed.");
    }
    let finalName = body.fileName;
    if (!body.done) {
      await putSigned(body.url!, file, mime, opts);
      // A claim that resolved to a different name (a 413-era stash drifting)
      // has to flow back into the open asset. If the user left the project,
      // pause instead of completing: the rename would move the local copy out
      // from under the saved document's reference. The claim stays pending
      // and the next open of the project resumes it. A same-name claim can't
      // drift, so it completes regardless.
      if (body.fileName !== fileName && useEditor.getState().projectId !== projectId) {
        throw Object.assign(new Error("Paused: the project closed."), { paused: true });
      }
      const cres = await backend.fetch(`/api/cut/projects/${projectId}/media/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: body.key }),
      });
      const cbody = await apiJson<{ fileName?: string }>(cres);
      if (!cres.ok || !cbody.fileName) throw new Error(cbody.error ?? "Upload failed.");
      finalName = cbody.fileName;
    }
    await renameLocalMedia(projectId, fileName, finalName);
    await clearPendingUpload(projectId, finalName);
    return finalName;
  };
}

/** Re-arm a cloud project's unsynced imports after a reload: every ledger pin
 * whose asset is still in the document gets its blob URL back, is re-marked
 * uploading, and re-enters the queue; a pin whose asset left the document
 * releases its bytes; a pin whose bytes are gone releases itself. */
export async function resumePendingUploads(
  projectId: string,
  backend: CutBackend = getBackend()
): Promise<void> {
  if (backend.kind !== "cloud") return;
  for (const p of await pendingUploadsFor(projectId)) {
    const s = useEditor.getState();
    if (s.projectId !== projectId) return;
    const asset = s.assets.find((a) => a.fileName === p.fileName);
    if (!asset) {
      void dropLocalMedia(projectId, p.fileName);
      continue;
    }
    if (uploadInFlight(asset.id)) continue;
    const url = await localMediaUrl(projectId, p.fileName);
    if (!url) {
      void clearPendingUpload(projectId, p.fileName);
      continue;
    }
    const upload = { progress: 0, stored: true };
    useEditor.getState().updateAsset(asset.id, { url, upload });
    startUpload(projectId, {
      asset: { ...asset, url, upload },
      localUrl: url,
      send: sendStoredUpload(backend, projectId, p.fileName),
    });
  }
}

/** Upload a raw file into the project folder, probe it, and return the asset.
 * Thumbnails/waveform are filled in asynchronously via `enrichAsset`. */
export async function importFileToProject(
  projectId: string,
  file: File,
  backend: CutBackend = getBackend()
): Promise<MediaAsset | null> {
  const type = assetTypeOf(file);
  if (!type) return null;

  let fileName = await uploadProjectMediaTo(backend, projectId, file, file.name);
  let name = file.name;
  // Probe the bytes in hand: the same file the upload just wrote, with no
  // second network read — which also lets a headless process import media.
  const meta = await probeMedia(type, file).catch(async (e: unknown) => {
    // Footage this browser has no decoder for — a phone's HEVC, a camera's
    // ProRes. The file is already in the project, so convert it there and
    // import what comes back; the raw upload goes with the failure otherwise.
    if (!(e instanceof UnreadableMediaError && e.undecodable)) throw e;
    const made = await convertProjectFile(
      projectId,
      { fileName, url: mediaUrl(projectId, fileName, backend), name: file.name },
      { backend }
    ).catch((convertError: unknown) => {
      void dropProjectFile(projectId, fileName, backend).catch(() => {});
      throw convertError;
    });
    void dropProjectFile(projectId, fileName, backend).catch(() => {});
    fileName = made.fileName;
    // The asset answers to what it now is: a card reading .MOV over an MP4
    // file is the card lying about the media.
    name = mp4DisplayName(name);
    return probeMedia(type, mediaUrl(projectId, fileName, backend));
  });
  const url = mediaUrl(projectId, fileName, backend);
  return {
    id: uid(),
    fileName,
    name,
    type: meta.type,
    duration: meta.duration,
    ...(meta.width !== undefined ? { width: meta.width } : {}),
    ...(meta.height !== undefined ? { height: meta.height } : {}),
    ...(meta.peaks ? { peaks: meta.peaks } : {}),
    url,
  };
}

/** Natural pixel size of an image URL, for framing on the timeline. */
async function loadImageMeta(url: string): Promise<{ width: number; height: number }> {
  const img = await decodeRasterImageUrl(url);
  return img ? { width: img.width, height: img.height } : { width: 0, height: 0 };
}

/** What `importRemote` needs to register a fetchable source as an asset the
 * user can edit with right away. Duration and dimensions come from the
 * caller's catalog entry, so nothing has to be read before the asset exists. */
type RemoteImportInit = {
  url: string;
  name: string;
  /** Name to store the bytes under; defaults to the URL's basename. */
  fileName?: string;
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
  origin?: StoredAsset["origin"];
};

/** Copy attempts ride out transient blips before the queue marks the asset
 * failed; an abort (asset deleted, project left) stops immediately. */
async function withRetries(
  copy: (opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<string>,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await copy(opts);
    } catch (err) {
      if (opts?.signal?.aborted || attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

/** Register media that lives at a fetchable URL — a stock tile, a library
 * file — as a project asset that is usable the moment this returns. The asset
 * plays from the source URL while `copy` moves the bytes into project storage
 * behind the editor (the import queue); when they land it swaps to the stored
 * file and joins the saved document, exactly like a dropped OS file. `copy`
 * defaults to download-and-upload; callers with a server-side copy (the
 * library's same-shelf route) pass their own and skip the round trip. */
export function importRemote(
  projectId: string,
  init: RemoteImportInit,
  copy?: (opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<string>
): MediaAsset {
  const id = uid();
  // The name the bytes will be stored under is the copy's to decide — the
  // server dedupes it against what the project already holds — so until they
  // land the asset answers to a name of its own. A name borrowed from the
  // source would collide with a file already in the project and speak for it:
  // the delete guard and the filmstrip cache both key on this field.
  const storeAs =
    init.fileName || init.url.split("/").pop()?.split("?")[0] || `${init.type}-${id}`;
  const asset: MediaAsset = {
    id,
    fileName: `pending-${id}`,
    name: init.name,
    type: init.type,
    duration: init.duration,
    ...(init.width !== undefined ? { width: init.width } : {}),
    ...(init.height !== undefined ? { height: init.height } : {}),
    ...(init.origin ? { origin: init.origin } : {}),
    url: init.url,
    upload: { progress: 0 },
  };
  useEditor.getState().addAsset(asset);
  void enrichAsset(asset);
  // Catalog dimensions are nominal (an aspect, not the file's pixels): read
  // the real ones behind the placement so the doc stores the truth.
  if (init.type === "video") {
    void probeMediaFile(init.url)
      .then((m) => {
        if (m.hasVideo) {
          useEditor.getState().updateAsset(asset.id, { width: m.width, height: m.height });
        }
      })
      .catch(() => {});
  }
  const download = async (opts?: {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  }) => {
    const dl = await fetch(init.url, { signal: opts?.signal });
    if (!dl.ok) throw new Error("Could not read the media.");
    const blob = await dl.blob();
    return uploadProjectMediaTo(getBackend(), projectId, blob, storeAs, opts);
  };
  startUpload(projectId, {
    asset,
    localUrl: init.url,
    send: (opts) => withRetries(copy ?? download, opts),
  });
  return asset;
}

/** Store a fetchable image (a stock tile) in the project's media as a
 * first-class image asset at its native resolution — no video baking — and
 * register it, without placing it on the timeline. Callers choose where it
 * lands. Ready as soon as the pixel size is read; the bytes copy in behind
 * the editor. */
export async function importImage(
  projectId: string,
  image: { url: string; name: string }
): Promise<MediaAsset> {
  // The size frames the still (and the first-asset aspect guess); the source
  // is a same-origin file, so this is one cached header read, not a download.
  const dims = await loadImageMeta(image.url);
  // 0×0 is how the read reports a source it could not open (a stock id that
  // no longer resolves, a dead link). Registering that would place a broken
  // still and hand the first-asset aspect guess a meaningless size, so the
  // import fails here instead.
  if (dims.width === 0 || dims.height === 0) throw new Error("Could not read the image.");
  // A stock image lands on the timeline where the caller places it, not in the
  // Media panel — tag it so it stays out.
  return importRemote(projectId, {
    url: image.url,
    name: image.name,
    type: "image",
    duration: 0,
    width: dims.width,
    height: dims.height,
    origin: "stock",
  });
}

/** Store a fetchable video (a stock clip) in the project's media as a regular
 * video asset and register it, without placing it on the timeline. Callers
 * choose where it lands. Instant when the catalog supplies the duration;
 * otherwise one metadata read stands between the call and the asset. */
export async function importStockVideo(
  projectId: string,
  video: { url: string; name: string; duration?: number; width?: number; height?: number }
): Promise<MediaAsset> {
  const duration = video.duration ?? (await probeMediaFile(video.url)).duration;
  // Like a stock image, it lands where the caller places it, not in Media.
  return importRemote(projectId, {
    url: video.url,
    name: video.name,
    type: "video",
    duration,
    width: video.width,
    height: video.height,
    origin: "stock",
  });
}

/** Store a bundled stock-music bed in the project's media as a regular audio
 * asset and register it, without placing it on the timeline — callers choose
 * where it lands (the soundtrack). Tagged "stock" so it stays out of Media. */
export async function importStockMusic(
  projectId: string,
  music: { url: string; name: string; duration?: number }
): Promise<MediaAsset> {
  const duration = music.duration ?? (await probeMediaFile(music.url)).duration;
  return importRemote(projectId, {
    url: music.url,
    name: music.name,
    type: "audio",
    duration,
    origin: "stock",
  });
}

/** Download a URL (TikTok, YouTube, an X post, an article, …) into the project
 * through the engine's bundled downloader and register what came back — one
 * asset for a video, one per photo for a photo post, none at all for a source
 * that is only words — without placing anything on the timeline. Callers
 * choose where assets land. `text` is the source's own words: a post's body,
 * an article, or a video's title and description. */
export async function importUrlMedia(
  projectId: string,
  url: string
): Promise<{ assets: MediaAsset[]; text?: string }> {
  url = normalizeLink(url);
  // Pinned at start: the download can outlast navigation into a project of
  // the other residency, and every poll must hit the backend the job started on.
  const backend = getBackend();
  // A browser project has no server of its own to run the fetch, so its import
  // rides the cloud worker and the bytes come back down.
  if (backend.kind === "browser") {
    const staged = await importUrlThroughCloud(projectId, backend, url);
    return adoptImportedFiles(projectId, backend, staged);
  }
  const res = await backend.fetch(`/api/cut/projects/${projectId}/import-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  let body: { files?: { fileName: string; title: string }[]; text?: string; error?: string };
  if (backend.kind === "cloud") {
    // The cloud route is async: it answers {jobId} and a worker does the fetch.
    const started = await apiJson<{ jobId?: string }>(res);
    if (!res.ok || !started.jobId) throw new Error(started.error ?? "Could not import that URL.");
    body = await pollCloudJob(started.jobId, backend, "Could not import that URL.");
  } else {
    body = await apiJson<{ files?: { fileName: string; title: string }[]; text?: string }>(res);
  }
  // A source that is only words (a text post, an article, a page) imports as
  // that text with no files, so an empty file list with text is a success.
  if (!res.ok || (!body.files?.length && !body.text)) {
    throw new Error(body.error ?? "Could not import that URL.");
  }
  return adoptImportedFiles(projectId, backend, body);
}

/** Register the files an import landed in the project, in order, and hand back
 * what the caller places. */
async function adoptImportedFiles(
  projectId: string,
  backend: CutBackend,
  imported: { files?: { fileName: string; title: string }[]; text?: string }
): Promise<{ assets: MediaAsset[]; text?: string }> {
  const assets: MediaAsset[] = [];
  for (const f of imported.files ?? []) {
    const asset = await assetFromProjectFile(
      projectId,
      f.fileName,
      f.title || "Imported clip",
      backend
    );
    useEditor.getState().addAsset(asset);
    void enrichAsset(asset);
    assets.push(asset);
  }
  return { assets, text: imported.text };
}

/**
 * A browser project's URL import. Nothing in the page can fetch a TikTok or a
 * YouTube video, so the cloud worker does it — into the account's library,
 * where the page can read it — and the bytes come down into this browser's own
 * storage. The staged library copy is dropped once the project holds it, so
 * the import leaves nothing behind on the cloud shelf.
 */
async function importUrlThroughCloud(
  projectId: string,
  backend: CutBackend,
  url: string
): Promise<{ files: { fileName: string; title: string }[]; text?: string }> {
  const res = await cloudBackend.fetch("/api/cut/library/import-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const started = await apiJson<{ jobId?: string }>(res);
  if (!res.ok || !started.jobId) throw new Error(started.error ?? "Could not import that URL.");
  const done = await pollCloudJob<{
    assets?: { id: string; fileName: string; name: string }[];
    text?: string;
  }>(started.jobId, cloudBackend, "Could not import that URL.");
  // Words with no media are a successful import; nothing at all is a failure.
  if (!done.assets?.length && !done.text) throw new Error("Could not import that URL.");
  const files: { fileName: string; title: string }[] = [];
  // Every staged copy is dropped from the cloud shelf, however this ends: a
  // download or a local write that throws part way through would otherwise
  // leave the user holding — and paying quota for — library media they never
  // asked for and cannot see from a browser project.
  const dropStaged = async () => {
    for (const staged of done.assets ?? []) {
      await cloudBackend
        .fetch(`/api/cut/library/${staged.id}`, { method: "DELETE" })
        .catch(() => {});
    }
  };
  try {
    for (const staged of done.assets ?? []) {
      const path = `/api/cut/library/media/${encodeURIComponent(staged.fileName)}`;
      const bytes = await cloudBackend.fetch(path);
      if (!bytes.ok) throw new Error("Could not import that URL.");
      const fileName = await uploadProjectMediaTo(
        backend,
        projectId,
        await bytes.blob(),
        staged.fileName
      );
      files.push({ fileName, title: staged.name });
    }
  } finally {
    void dropStaged();
  }
  return { files, ...(done.text ? { text: done.text } : {}) };
}

/** Build a runtime asset for a media file the engine already wrote into the
 * project folder (freeze frames, AI generations, URL imports) — probe
 * metadata, no upload. */
export async function assetFromProjectFile(
  projectId: string,
  fileName: string,
  name: string,
  backend: CutBackend = getBackend()
): Promise<MediaAsset> {
  const url = mediaUrl(projectId, fileName, backend);
  const asset: MediaAsset = {
    id: uid(),
    fileName,
    name,
    type: "video",
    duration: 0,
    url,
  };
  if (/\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(fileName)) {
    asset.type = "image";
    const dims = await loadImageMeta(url);
    asset.width = dims.width;
    asset.height = dims.height;
    return asset;
  }
  const meta = await probeMediaFile(url);
  asset.duration = meta.duration;
  if (!meta.hasVideo) {
    asset.type = "audio";
  } else {
    asset.width = meta.width;
    asset.height = meta.height;
  }
  return asset;
}

/** Cloud twin of the engine's freeze route: grab the source frame in the
 * browser (seek + canvas at native resolution), store it as a PNG project
 * image, and return the same asset shape the engine's freeze response has.
 * `duration` (seconds) rides back on the asset so the caller can size the
 * placed clip like the engine's baked still video; the stored image itself
 * has no intrinsic length. */
export async function captureFreezeFrame(
  projectId: string,
  sourceUrl: string,
  srcTime: number,
  duration = 0,
  /** Bake the still at the project frame, framed as the clip is — the engine's
   * /freeze route does the same with ffmpeg, so a still captured in the browser
   * and one captured on the Mac are the same picture. */
  framed?: {
    frame: { w: number; h: number };
    cover: boolean;
    zoom?: number;
    panX?: number;
    panY?: number;
  }
): Promise<MediaAsset> {
  const frame = await frameAt(sourceUrl, srcTime);
  if (!frame) throw new Error("Could not render the freeze frame.");
  let picture = frame.canvas;
  if (framed) {
    const { w, h } = framed.frame;
    const out = createRasterCanvas(w, h);
    const ctx = out.getContext("2d") as CanvasRenderingContext2D;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, w, h);
    const box = { x: 0, y: 0, w, h };
    const r = contentRect(
      box,
      frame.canvas.width,
      frame.canvas.height,
      framed.cover,
      framed.zoom,
      framed.panX,
      framed.panY
    );
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.drawImage(frame.canvas as CanvasImageSource, r.x, r.y, r.w, r.h);
    ctx.restore();
    picture = out;
  }
  const blob = await rasterCanvasToBlob(picture, "image/png");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fileName = `freeze-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${uid().slice(0, 4)}.png`;
  const asset = await uploadProjectImage(projectId, blob, fileName, {
    failMessage: "Could not render the freeze frame.",
  });
  return duration > 0 ? { ...asset, duration } : asset;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Decoded audio for a span of a source, chunk by chunk, so scanning a long
 * file costs one decoded chunk at a time rather than a decoded copy of the
 * whole thing. Throws when the file carries no audio at all — whether it does
 * is asked of the file, not of the span, so a range past the end of a
 * perfectly good recording is an empty answer instead of an error. */
async function* sourcePcm(
  sourceUrl: string,
  from: number,
  to: number | undefined
): AsyncGenerator<PcmChunk> {
  const input = openMedia(sourceUrl);
  const track = await audioTrackOf(input).finally(() => input.dispose());
  if (!track) throw new Error("This file has no audio track.");
  if (to !== undefined && !(to > from)) return;
  for await (const { buffer, timestamp } of audioChunks(sourceUrl, from, to)) {
    yield {
      channels: Array.from({ length: buffer.numberOfChannels }, (_, c) =>
        buffer.getChannelData(c)
      ),
      timestamp,
      sampleRate: buffer.sampleRate,
    };
  }
}

/** Cloud twin of the engine's silence route (ffmpeg silencedetect): read the
 * source's audio and scan 20ms RMS windows against the same dB threshold and
 * minimum-duration rules. Times are absolute source seconds. */
export async function detectSilenceClientSide(
  sourceUrl: string,
  opts: { from: number; to?: number; thresholdDb: number; minSilence: number }
): Promise<{ start: number; end: number; duration: number }[]> {
  const from = Math.max(0, opts.from);
  return scanSilence(sourcePcm(sourceUrl, from, opts.to), { ...opts, from });
}

/** Where the words are in a span of a source. One implementation for every
 * residency: the page reads its own media this way in local and cloud mode
 * alike, and the headless runner installs the same decoders. */
export async function scanSourceSpeech(
  sourceUrl: string,
  opts: { from: number; to?: number }
): Promise<SpeechScan> {
  const from = Math.max(0, opts.from);
  return scanSpeech(sourcePcm(sourceUrl, from, opts.to), { ...opts, from });
}

/** Cloud twin of the engine's audio-extract route: render a span of the
 * source's audio to 16 kHz mono WAV in the browser, for the AI to hear
 * inline. An empty `to` runs to the end. */
export async function renderAudioSpanWav(
  sourceUrl: string,
  from: number,
  to: number | undefined
): Promise<Blob> {
  // Only the asked-for span is decoded, so pulling thirty seconds out of an
  // hour-long file costs thirty seconds of work.
  const span = await decodeAudioSpan(sourceUrl, Math.max(0, from), to);
  if (!span) throw new Error("This file has no audio track.");
  const dur = span.duration;
  if (!(dur > 0)) throw new Error("from/to describe an empty range.");
  const rate = 16000; // encodeWav's fixed sample rate
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * rate)), rate);
  const src = ctx.createBufferSource();
  src.buffer = span;
  src.connect(ctx.destination);
  src.start(0);
  return encodeWav((await ctx.startRendering()).getChannelData(0));
}

// Watch geometry: cells at a fixed long side, tiled and stamped by
// composeSheets. One sampler serves the local and cloud backends alike — the
// browser decodes the source (local media rides the engine's media URL, cloud
// media the CDN) and the shared selector keeps the frames that differ.
const SHEET_GRID = 3; // cells per row and column
const SHEET_CELL = 480; // cell long side, px
const SHEET_GAP = 4; // tile margin and padding, px
const SHEET_MAX = 4; // sheets per call
const SHEET_QUALITY = 0.8; // jpeg encode
const CANDIDATE_CAP = 150; // decodes per call — the densest sweep
const REFINE_TARGET_S = 0.35; // localize each hard cut to about this window
const REFINE_MAX_PROBES = 48; // extra seeks the refinement pass may spend per call

/** The watch sample: kept frames, ascending source time, each carrying why
 * the selector kept it (WatchKeepReason in types.ts). */
export interface WatchFrames {
  frames: { t: number; image: string; via: WatchKeepReason }[];
  candidates: number;
  sceneChanges: number[];
  coveredTo: number;
  truncated: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Round the cell's short side to even, so encoded dimensions stay codec-safe.
const cellDims = (w: number, h: number): [number, number] =>
  w >= h
    ? [SHEET_CELL, Math.max(2, 2 * Math.round((SHEET_CELL * h) / w / 2))]
    : [Math.max(2, 2 * Math.round((SHEET_CELL * w) / h / 2)), SHEET_CELL];

/** Watch a still image: one downscaled frame, no time axis. */
export async function makeStillFrame(sourceUrl: string): Promise<WatchFrames> {
  const img = await decodeRasterImageUrl(sourceUrl);
  if (!img || img.width === 0 || img.height === 0) throw new Error("Could not read the image.");
  const [w, h] = cellDims(img.width, img.height);
  const canvas = createRasterCanvas(w, h);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Could not read the image.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img.source, 0, 0, w, h);
  // A picture read through an element (a host that sends no CORS header)
  // taints the canvas, and the encode is where that surfaces.
  const image = await rasterCanvasToDataUrl(canvas, "image/jpeg", SHEET_QUALITY).catch(() => {
    throw new Error("Could not read the image.");
  });
  return {
    frames: [{ t: 0, image, via: "first" }],
    candidates: 1,
    sceneChanges: [],
    coveredTo: 0,
    truncated: false,
  };
}

/** Watch a video source: decode candidates on a dense steady floor, then let
 * the shared selector keep the frames that actually differ. sceneChanges are
 * hard-cut times: each "global" keep says a cut lies inside the grid step
 * before it, and a short bisection pass narrows that window to about
 * REFINE_TARGET_S — the reported time is where the new shot is first seen.
 * A shot shorter than the candidate step can still fall between samples; a
 * narrow re-watch with a small interval is the recall pass.
 *
 * Coverage is honest by construction: the keep-cap, a pause, and the time
 * budget all END the pass (coveredTo says where) instead of thinning or
 * guessing — everything inside [from, coveredTo] was decoded and judged, and
 * every kept frame in it is returned. A source that decodes no frames at all
 * throws; it is never reported as watched.
 *
 * metadataOnly skips the cell copies and JPEG encodes — frames come back with
 * an empty image — for the background sweep, which only wants the numbers.
 * shouldPause is polled per candidate; budgetMs bounds the whole call the
 * same way, for callers racing a tool deadline. */
export async function sampleWatchFrames(
  sourceUrl: string,
  opts: {
    from: number;
    to?: number;
    interval?: number;
    metadataOnly?: boolean;
    shouldPause?: () => boolean;
    budgetMs?: number;
  }
): Promise<WatchFrames> {
  const input = openMedia(sourceUrl);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new Error("Could not sample the video.");
    const from = Math.max(0, opts.from);
    const wanted = opts.to ?? (await input.computeDuration());
    if (opts.to === undefined && !(wanted > 0))
      throw new Error("Could not read the media duration — pass to (seconds).");
    if (!(wanted > from)) throw new Error("from/to describe an empty range.");
    const to = Math.min(wanted, from + 600); // bound the work per call; callers resume from coveredTo
    const interval = clamp(opts.interval ?? 1, 0.5, 30);
    // The candidate floor: as asked, widened only when the range would blow
    // the per-call decode budget.
    const step = Math.max(interval, (to - from) / CANDIDATE_CAP);
    const times: number[] = [];
    for (let t = from; t < to && times.length < CANDIDATE_CAP; t += step)
      times.push(round2(t));

    const [cw, ch] = cellDims(await track.getDisplayWidth(), await track.getDisplayHeight());
    const maxFrames = SHEET_MAX * SHEET_GRID * SHEET_GRID;
    // Cell canvases are held only until the selector rules on them (decisions
    // run one frame behind), so memory stays near the kept set, never the
    // candidate sweep.
    const held = new Map<number, RasterSurface>();
    const candTimes: number[] = [];
    const candG16: Float32Array[] = []; // per-candidate coarse grid, for cut refinement
    let keptCount = 0;
    const selector = createDedupSelector({
      maxFrames,
      onDecision: (d) => {
        if (d.verdict === "drop") held.delete(d.index);
        else keptCount++;
      },
    });
    const sig = createRasterCanvas(SIGNATURE_SIZE, SIGNATURE_SIZE);
    const sigCtx = sig.getContext("2d", {
      willReadFrequently: true,
    }) as CanvasRenderingContext2D | null;
    if (!sigCtx) throw new Error("Could not sample the video.");
    const deadline = Date.now() + (opts.budgetMs ?? Infinity);
    const outOfTime = () => Date.now() > deadline;
    const sigG16At = async (t: number): Promise<Float32Array | null> => {
      const one = await frameSink(track, { width: cw, height: ch, fit: "fill" })
        .canvasesAtTimestamps([t])
        .next();
      if (one.done || !one.value) return null;
      sigCtx.imageSmoothingQuality = "high";
      sigCtx.drawImage(one.value.canvas as CanvasImageSource, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
      const data = sigCtx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data;
      return frameSig({ width: SIGNATURE_SIZE, height: SIGNATURE_SIZE, channels: 4, data }).g16;
    };

    // The times are ascending, so the whole span decodes once, in order.
    const cells = frameSink(track, { width: cw, height: ch, fit: "fill" }).canvasesAtTimestamps(
      times
    );
    let paused = false;
    let capped = false;
    for (let i = 0; i < times.length; i++) {
      if (opts.shouldPause?.() || outOfTime()) {
        paused = true;
        break;
      }
      // The keep-cap ends the pass — everything reported stays everything
      // seen, and the caller resumes from coveredTo.
      if (keptCount >= maxFrames) {
        capped = true;
        break;
      }
      const next = await cells.next();
      if (next.done || !next.value) continue; // a moment the decoder had no frame for
      if (!opts.metadataOnly) {
        const copy = createRasterCanvas(cw, ch);
        const cctx = copy.getContext("2d") as CanvasRenderingContext2D | null;
        if (!cctx) throw new Error("Could not sample the video.");
        cctx.drawImage(next.value.canvas as CanvasImageSource, 0, 0, cw, ch);
        held.set(candTimes.length, copy);
      }
      candTimes.push(times[i]);
      sigCtx.imageSmoothingQuality = "high";
      sigCtx.drawImage(next.value.canvas as CanvasImageSource, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
      const rgb = {
        width: SIGNATURE_SIZE,
        height: SIGNATURE_SIZE,
        channels: 4 as const,
        data: sigCtx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data,
      };
      candG16.push(frameSig(rgb).g16);
      selector.push(rgb);
    }
    const selection = selector.finish();
    // Nothing decoded and nothing interrupted the pass: the source is
    // unreadable. Say so — never record an unseen span as watched.
    if (candTimes.length === 0 && !paused) throw new Error("Could not sample the video.");
    // finish() judges the one pending frame, which can nudge past the cap.
    const keptIdx = selection.kept.slice(0, maxFrames);
    const frames: WatchFrames["frames"] = [];
    for (const idx of keptIdx) {
      const canvas = held.get(idx);
      if (!opts.metadataOnly && !canvas) continue;
      const verdict = selection.decisions[idx].verdict;
      frames.push({
        t: candTimes[idx],
        image: canvas ? await rasterCanvasToDataUrl(canvas, "image/jpeg", SHEET_QUALITY) : "",
        via: verdict === "keep-global" ? "global"
          : verdict === "keep-action" ? "action"
          : verdict === "keep-settled" ? "settled"
          : "first",
      });
    }
    held.clear();

    // A "global" keep only says the cut lies in the grid step before it.
    // Bisect that step with a few extra decodes so each reported cut time
    // sits within REFINE_TARGET_S of the first new-shot frame; the kept
    // image stays the grid sample.
    let probes = 0;
    const sceneChanges: number[] = [];
    for (const idx of keptIdx) {
      if (selection.decisions[idx].verdict !== "keep-global") continue;
      let lo = idx > 0 ? candTimes[idx - 1] : from;
      let hi = candTimes[idx];
      const pre = idx > 0 ? candG16[idx - 1] : null;
      while (
        pre !== null &&
        hi - lo > REFINE_TARGET_S &&
        probes < REFINE_MAX_PROBES &&
        !outOfTime() &&
        !opts.shouldPause?.()
      ) {
        probes++;
        const mid = (lo + hi) / 2;
        const g = await sigG16At(mid);
        if (!g) break;
        if (diffCellPct(g, pre, DEDUP_TUNING.GLOBAL_TOL) > DEDUP_TUNING.THRESHOLD) hi = mid;
        else lo = mid;
      }
      sceneChanges.push(round2(hi));
    }

    // An interrupted or capped scan only covered what it decoded and kept;
    // the caller merges that much and comes back for the rest.
    const lastKeptT = keptIdx.length > 0 ? candTimes[keptIdx[keptIdx.length - 1]] : from;
    const coveredTo = paused
      ? (candTimes[candTimes.length - 1] ?? from)
      : capped
        ? lastKeptT
        : to;
    return {
      frames,
      candidates: selection.candidateCount,
      sceneChanges,
      coveredTo,
      // The per-call span bound is itself truncation — the caller asked for more.
      truncated: paused || capped || to < wanted,
    };
  } finally {
    input.dispose();
  }
}

/** Tile kept frames into 3×3 contact sheets and stamp each cell's source
 * time. The last sheet may run short; its frames list only the real cells. */
export async function composeSheets(
  cells: { t: number; image: string }[]
): Promise<{ image: string; frames: { t: number }[] }[]> {
  if (cells.length === 0) return [];
  const images = await Promise.all(
    cells.map(async (c) => {
      const img = await decodeRasterImageUrl(c.image);
      if (!img) throw new Error("Bad frame image.");
      return img;
    })
  );
  const cw = images[0].width;
  const ch = images[0].height;
  const perSheet = SHEET_GRID * SHEET_GRID;
  const sheetW = 2 * SHEET_GAP + SHEET_GRID * cw + (SHEET_GRID - 1) * SHEET_GAP;
  const sheetH = 2 * SHEET_GAP + SHEET_GRID * ch + (SHEET_GRID - 1) * SHEET_GAP;
  const size = Math.max(13, Math.round(ch / 12));
  const sheets: { image: string; frames: { t: number }[] }[] = [];
  for (let s = 0; s < cells.length; s += perSheet) {
    const batch = cells.slice(s, s + perSheet);
    const canvas = createRasterCanvas(sheetW, sheetH);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) throw new Error("No 2d context.");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, sheetW, sheetH);
    ctx.imageSmoothingQuality = "high";
    ctx.font = `bold ${size}px ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    batch.forEach((c, j) => {
      const x = SHEET_GAP + (j % SHEET_GRID) * (cw + SHEET_GAP);
      const y = SHEET_GAP + Math.floor(j / SHEET_GRID) * (ch + SHEET_GAP);
      ctx.drawImage(images[s + j].source, x, y, cw, ch);
      const label = `${round2(c.t)}s`;
      const w = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(x + 4, y + ch - size - 10, w + 10, size + 8);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x + 9, y + ch - 6);
    });
    sheets.push({
      image: await rasterCanvasToDataUrl(canvas, "image/jpeg", SHEET_QUALITY),
      frames: batch.map((c) => ({ t: c.t })),
    });
  }
  return sheets;
}

// Filmstrip generation that failed, by asset id — session state, never doc
// state. The clip box reads it to swap the loading pulse for a still
// placeholder; each new enrich attempt (imports fire one, and every project
// open sweeps all assets) clears the mark before trying again.
const failedStrips = new Set<string>();
const stripListeners = new Set<() => void>();

export function subscribeStripStatus(fn: () => void) {
  stripListeners.add(fn);
  return () => {
    stripListeners.delete(fn);
  };
}

/** Whether the last filmstrip attempt for this asset failed. */
export const stripFailedFor = (assetId: string) => failedStrips.has(assetId);

function setStripFailed(assetId: string, failed: boolean) {
  if (failed === failedStrips.has(assetId)) return;
  if (failed) failedStrips.add(assetId);
  else failedStrips.delete(assetId);
  for (const fn of stripListeners) fn();
}

// A failed enrich books itself more tries. Filmstrip and waveform reads drop
// out together with the preview's when media reads fail, and the sweep that
// would try again runs only on project open — so a blip at open used to leave
// every clip blank for the whole session. The tries are few and well spaced;
// an asset that gains its thumbs or peaks stops the clock, and one that keeps
// failing goes quiet after the last try.
const ENRICH_RETRY_BASE_MS = 30_000;
const ENRICH_RETRIES = 3;
const enrichRetries = new Map<string, number>();
const enrichRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleEnrichRetry(assetId: string) {
  if (typeof window === "undefined") return;
  if (enrichRetryTimers.has(assetId)) return;
  const n = enrichRetries.get(assetId) ?? 0;
  if (n >= ENRICH_RETRIES) return;
  enrichRetries.set(assetId, n + 1);
  const timer = setTimeout(() => {
    enrichRetryTimers.delete(assetId);
    const asset = useEditor.getState().assets.find((a) => a.id === assetId);
    if (!asset) return;
    const done =
      asset.type === "audio"
        ? !!asset.peaks?.length
        : asset.type === "video"
          ? stripComplete(asset) && asset.peaks !== undefined
          : !!asset.thumbs?.length;
    if (done) return;
    void enrichAsset(asset);
  }, ENRICH_RETRY_BASE_MS * 3 ** n);
  enrichRetryTimers.set(assetId, timer);
}

/** A strip holds one tile per slot the grid asks for. A sweep that died
 * midway published fewer, so the tile count is what tells a finished strip
 * from a partial one — a non-empty strip is not necessarily a whole strip. */
function stripComplete(asset: MediaAsset) {
  return (asset.thumbs?.length ?? 0) >= thumbGrid(asset.duration).count;
}

/** One enrich per asset at a time. A reload re-sweeps every asset, and a
 * second pass landing mid-sweep would read the partial strip as the finished
 * one and refine against it. */
const enrichInFlight = new Set<string>();

/** Generate filmstrip thumbnails / waveform peaks and merge them into the
 * store. Safe to call repeatedly; skips assets that are already enriched.
 * `src` overrides where the frames are read from — an import still uploading
 * has the bytes in the browser already, so it need not wait or re-download. */
export async function enrichAsset(asset: MediaAsset, src = asset.url) {
  if (enrichInFlight.has(asset.id)) return;
  enrichInFlight.add(asset.id);
  try {
    if (asset.type === "image") {
      // A still is its own filmstrip: one frame, tiled across the clip.
      if (!asset.thumbs?.length) {
        useEditor.getState().updateAsset(asset.id, { thumbs: [src], thumbStep: IMAGE_CLIP_SECONDS });
      }
    } else if (asset.type === "video") {
      if (!stripComplete(asset)) {
        setStripFailed(asset.id, false);
        const key = stripCacheKey(useEditor.getState().projectId, asset.fileName);
        const cached = await readCachedStrip(key, asset.duration);
        if (cached) {
          useEditor.getState().updateAsset(asset.id, {
            thumbs: cached.thumbs,
            thumbStep: cached.thumbStep,
            sceneCuts: cached.cuts,
          });
        } else {
          // Midpoint grabs, published tile by tile: the strip fills in as the
          // sweep runs, and the scene pass refines the grab points behind it.
          const { thumbs, thumbStep } = await makeThumbs(src, asset.duration, [], (partial, step) =>
            useEditor.getState().updateAsset(asset.id, { thumbs: partial, thumbStep: step })
          );
          // An empty strip is a failure, not a result: persisting it would
          // leave the asset looking permanently mid-load.
          if (!thumbs.length) throw new UnreadableMediaError("No frames could be read for the filmstrip.");
          useEditor.getState().updateAsset(asset.id, { thumbs, thumbStep });
          writeCache(key, { thumbs, thumbStep, duration: asset.duration, at: Date.now() });
        }
      }
      // The cuts a strip was built without — a fresh sweep, or a cache written
      // before the scene pass finished — are probed once the tiles are up.
      const live = useEditor.getState().assets.find((a) => a.id === asset.id);
      if (live && stripComplete(live) && live.sceneCuts === undefined) {
        void refineSceneCuts(asset.id, src, asset.duration).catch((err) => {
          // Scene cuts only sharpen the strip; the tiles already painted.
          reportSwallowed(`[cut] scene probe failed for ${asset.fileName}`, err);
        });
      }
      // The clip box draws the sound under the picture, so a video enriches
      // waveform peaks alongside its filmstrip. `[]` is an answer too — a
      // silent file — and stops the strip from re-decoding every open.
      if (asset.peaks === undefined) {
        try {
          const peaks = await loadPeaks(asset, src);
          if (peaks) useEditor.getState().updateAsset(asset.id, { peaks });
        } catch (err) {
          // The strip above already painted; a peaks failure (an expired
          // signed URL, an undecodable track) never marks it failed.
          reportSwallowed(`[cut] peaks failed for ${asset.fileName}`, err);
        }
      }
      enrichRetries.delete(asset.id);
    } else if (asset.type === "audio" && !asset.peaks?.length) {
      const peaks = await loadPeaks(asset, src);
      if (peaks) useEditor.getState().updateAsset(asset.id, { peaks });
      enrichRetries.delete(asset.id);
    }
  } catch (err) {
    // Thumbnails and waveforms are decorative; editing works without them.
    // The failure still gets recorded — clips stop their loading pulse — and
    // reported, which carries it into PostHog error tracking with the file's
    // shape beside the cause (lib/report.ts).
    if (asset.type === "video") setStripFailed(asset.id, true);
    if (asset.type !== "image") scheduleEnrichRetry(asset.id);
    reportSwallowed(
      `[cut] enrich failed for ${asset.fileName} (${asset.type}, ${Math.round(asset.duration)}s)`,
      err
    );
  } finally {
    enrichInFlight.delete(asset.id);
  }
}

/** Waveform peaks on demand — e.g. when a video clip's audio is detached
 * onto the soundtrack track (video assets don't get peaks at import). */
export async function ensurePeaks(asset: MediaAsset) {
  try {
    if (!asset.peaks?.length) {
      const peaks = await loadPeaks(asset);
      if (peaks?.length) useEditor.getState().updateAsset(asset.id, { peaks });
    }
  } catch (err) {
    // Waveforms are decorative; editing works without them.
    reportSwallowed(`[cut] peaks failed for ${asset.fileName}`, err);
  }
}

// Filmstrip frames render at 60 CSS px tall — capture at 3× so they stay sharp
// on Retina (and when a tall timeline scales the row up).
const THUMB_H = 180;

// Filmstrips persist in IndexedDB keyed by project + file name + thumbnail
// geometry — not the URL, which churns on cloud signed-URL refreshes — so
// reopening a project paints clips from cache instead of re-seeking every
// video. Cache failures fall through to regeneration.
const STRIP_DB = "cut-filmstrips";
const STRIP_STORE = "strips";
const STRIP_CAP = 500; // prune oldest beyond this many cached strips

type CachedStrip = {
  thumbs: string[];
  thumbStep: number;
  cuts?: number[];
  duration: number;
  at: number;
};

function stripCacheKey(projectId: string | null, fileName: string) {
  // "s3" marks strips that carry scene cuts; strips cached before them regenerate.
  return `${projectId ?? ""}/${fileName}@${THUMB_H}s3`;
}

type CachedPeaks = { peaks: number[]; duration: number; at: number };

function peaksCacheKey(projectId: string | null, fileName: string) {
  // The density marker versions the cache; peaks sampled differently regenerate.
  return `${projectId ?? ""}/${fileName}@peaks${PEAKS_PER_SECOND}`;
}

function openStripDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STRIP_DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STRIP_STORE);
      store.createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readCachedStrip(key: string, duration: number): Promise<CachedStrip | null> {
  try {
    const db = await openStripDb();
    const strip = await new Promise<CachedStrip | undefined>((resolve, reject) => {
      const req = db.transaction(STRIP_STORE).objectStore(STRIP_STORE).get(key);
      req.onsuccess = () => resolve(req.result as CachedStrip | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    // A same-path file with a different duration was rewritten; regenerate.
    if (!strip?.thumbs?.length || Math.abs(strip.duration - duration) > 0.25) return null;
    return strip;
  } catch {
    return null;
  }
}

async function readCachedPeaks(key: string, duration: number): Promise<number[] | null> {
  try {
    const db = await openStripDb();
    const entry = await new Promise<CachedPeaks | undefined>((resolve, reject) => {
      const req = db.transaction(STRIP_STORE).objectStore(STRIP_STORE).get(key);
      req.onsuccess = () => resolve(req.result as CachedPeaks | undefined);
      req.onerror = () => reject(req.error);
    });
    db.close();
    // A same-path file with a different duration was rewritten; regenerate.
    if (!Array.isArray(entry?.peaks) || Math.abs(entry.duration - duration) > 0.25) return null;
    return entry.peaks;
  } catch {
    return null;
  }
}

/** Waveform peaks for an asset, from the cache when this file was already
 * decoded — a real audio decode otherwise. Empty peaks are an answer (a file
 * with no audible track) and cache like any other. A headless runtime returns
 * undefined so the browser decodes on its next open. */
async function loadPeaks(asset: MediaAsset, src = asset.url): Promise<number[] | undefined> {
  if (typeof AudioDecoder === "undefined") return undefined;
  const key = peaksCacheKey(useEditor.getState().projectId, asset.fileName);
  const cached = await readCachedPeaks(key, asset.duration);
  if (cached) return cached;
  const peaks = await makePeaks(src, asset.duration);
  writeCache(key, { peaks, duration: asset.duration, at: Date.now() });
  return peaks;
}

function writeCache(key: string, entry: CachedStrip | CachedPeaks) {
  void (async () => {
    try {
      const db = await openStripDb();
      const tx = db.transaction(STRIP_STORE, "readwrite");
      const store = tx.objectStore(STRIP_STORE);
      store.put(entry, key);
      const count = await new Promise<number>((resolve, reject) => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (count > STRIP_CAP) {
        const cursorReq = store.index("at").openCursor();
        let toDrop = count - STRIP_CAP;
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor || toDrop <= 0) return;
          cursor.delete();
          toDrop--;
          cursor.continue();
        };
      }
      tx.oncomplete = () => db.close();
      tx.onerror = () => db.close();
    } catch {
      // Cache writes are best-effort; the strip is already on screen.
    }
  })();
}

/** Probes per strip bucket for scene-change detection, and the cap on the
 * whole probe sweep so long files stay a bounded pass. */
const THUMB_PROBE_CAP = 120;
/** % of 16-grid cells that must change between adjacent probes to call a
 * scene cut. Far above the watch selector's "meaningfully new" bar (8%), so
 * motion and pans pass under it and only a real cut splits a bucket. */
const THUMB_PROBE_CUT_PCT = 45;

/** g16 grid signatures for ascending `times`, decoded small in one sweep;
 * null where the decoder had no frame. */
async function g16Sweep(url: string, times: number[]): Promise<(Float32Array | null)[]> {
  const sig = createRasterCanvas(SIGNATURE_SIZE, SIGNATURE_SIZE);
  const ctx = sig.getContext("2d", {
    willReadFrequently: true,
  }) as CanvasRenderingContext2D | null;
  if (!ctx) return times.map(() => null);
  const out: (Float32Array | null)[] = [];
  for await (const frame of framesAt(url, times, { height: SIGNATURE_SIZE })) {
    if (!frame) {
      out.push(null);
      continue;
    }
    ctx.drawImage(frame.canvas as CanvasImageSource, 0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE);
    out.push(
      frameSig({
        width: SIGNATURE_SIZE,
        height: SIGNATURE_SIZE,
        channels: 4,
        data: ctx.getImageData(0, 0, SIGNATURE_SIZE, SIGNATURE_SIZE).data,
      }).g16
    );
  }
  return out;
}

/** Scene-change signals across the clip: one small decoded frame every
 * fraction of a bucket, compared through the watch pipeline's grid signature.
 * A probe is flagged `cut` when the picture changed scene since the probe
 * before it. */
async function thumbProbes(url: string, duration: number, count: number): Promise<ThumbProbe[]> {
  const perBucket = Math.max(3, Math.floor(THUMB_PROBE_CAP / count));
  const n = count * perBucket;
  const times = Array.from({ length: n }, (_, i) =>
    Math.max(0, Math.min(duration - 0.05, ((i + 0.5) * duration) / n))
  );
  const sigs = await g16Sweep(url, times);
  return times.map((t, i) => {
    const p = i > 0 ? sigs[i - 1] : null;
    const q = sigs[i];
    return {
      t,
      cut: !!p && !!q && diffCellPct(q, p, DEDUP_TUNING.GLOBAL_TOL) > THUMB_PROBE_CUT_PCT,
    };
  });
}

/** How many cut brackets get the dense second sweep, samples per bracket, and
 * the most cuts an asset stores at all. */
const CUT_REFINE_MAX = 32;
const CUT_REFINE_STEPS = 8;
const SCENE_CUTS_MAX = 256;

/** The clip's scene-change moments. The probe pass brackets each cut between
 * two probes; a denser sweep inside each bracket places the cut within an
 * eighth of the probe spacing (tens of milliseconds on a typical clip).
 * Brackets past the refinement cap keep their bracket midpoint. */
async function sceneCutTimes(url: string, probes: ThumbProbe[]): Promise<number[]> {
  const brackets: [number, number][] = [];
  for (let i = 1; i < probes.length; i++) {
    if (probes[i].cut) brackets.push([probes[i - 1].t, probes[i].t]);
  }
  const refine = brackets.slice(0, CUT_REFINE_MAX);
  const cuts = brackets.slice(CUT_REFINE_MAX).map(([a, b]) => (a + b) / 2);
  if (refine.length) {
    const S = CUT_REFINE_STEPS;
    const times = refine.flatMap(([a, b]) =>
      Array.from({ length: S + 1 }, (_, j) => a + (j * (b - a)) / S)
    );
    const sigs = await g16Sweep(url, times);
    refine.forEach(([a, b], r) => {
      let at = (a + b) / 2;
      let strongest = -1;
      for (let j = 1; j <= S; j++) {
        const p = sigs[r * (S + 1) + j - 1];
        const q = sigs[r * (S + 1) + j];
        if (!p || !q) continue;
        const d = diffCellPct(q, p, DEDUP_TUNING.GLOBAL_TOL);
        if (d > strongest) {
          strongest = d;
          at = a + ((j - 0.5) * (b - a)) / S;
        }
      }
      cuts.push(at);
    });
  }
  return cuts
    .map((c) => Math.round(c * 100) / 100)
    .sort((x, y) => x - y)
    .slice(0, SCENE_CUTS_MAX);
}

/** The strip's bucket count and spacing: one frame every ~2s (min 10, max 24)
 * so long clips don't repeat frames. */
function thumbGrid(duration: number) {
  const count = Math.min(24, Math.max(10, Math.round(duration / 2)));
  return { count, thumbStep: duration / count };
}

/** How often a sweep in progress hands the tiles it has over to the strip. */
const THUMB_PUBLISH_MS = 250;

/**
 * Sweep a clip's filmstrip frames, handing over the tiles that have landed as
 * the pass runs.
 *
 * Ascending times over one decode pass — the strip is a single sweep of the
 * file rather than `count` seeks into it — and each tile is on screen as soon
 * as it is read. A long clip streaming in from storage takes real time to
 * sweep, and a strip that showed nothing until the last tile landed read as
 * broken next to a preview that plays immediately.
 *
 * The strip is read back by position (`thumbs[floor(t / thumbStep)]`), so a
 * time the decoder has no frame for cannot simply be dropped: that would
 * slide every later tile onto the wrong moment for the rest of the clip, and
 * the wrong strip would be cached. A gap repeats the frame before it, which
 * keeps every index meaning what it says — and the same fill carries the tail
 * of a strip that is still being swept.
 */
async function makeThumbs(
  url: string,
  duration: number,
  probes: ThumbProbe[] = [],
  onTiles?: (thumbs: string[], thumbStep: number) => void
) {
  const { count, thumbStep } = thumbGrid(duration);
  const times = pickThumbTimes(count, thumbStep, duration, probes);
  const captured: (string | null)[] = [];
  // Fill gaps from the frame before, so the strip is either populated to the
  // tile the sweep has reached or empty.
  const settled = () => {
    const thumbs: string[] = [];
    let fill: string | null = captured.find((c) => c !== null) ?? null;
    if (fill) {
      for (const shot of captured) {
        if (shot) fill = shot;
        thumbs.push(fill);
      }
    }
    return thumbs;
  };
  let published = 0;
  for await (const frame of framesAt(url, times, { height: THUMB_H })) {
    captured.push(frame ? await rasterCanvasToDataUrl(frame.canvas, "image/jpeg", 0.92) : null);
    if (!onTiles || captured.length >= times.length) continue;
    const now = Date.now();
    if (now - published < THUMB_PUBLISH_MS) continue;
    published = now;
    const partial = settled();
    if (partial.length) onTiles(partial, thumbStep);
  }
  return { thumbs: settled(), thumbStep };
}

/**
 * The clip's scene-change moments, and the probe signals behind them.
 *
 * This is the expensive half of building a strip: the probe sweep and its
 * refinement decode many times the frames the strip itself needs, so it runs
 * behind the strip rather than in front of it.
 */
async function sceneProbe(url: string, duration: number) {
  const { count } = thumbGrid(duration);
  const probes = await thumbProbes(url, duration, count);
  const cuts = await sceneCutTimes(url, probes);
  return { probes, cuts };
}

/** A grab point has to move by this share of its bucket before the tile is
 * worth reading again. */
const THUMB_REGRAB_SHARE = 0.1;

/** One scene probe per asset at a time. The probe outlives the enrich that
 * launched it, so the enrich guard cannot cover it: the next pass would see a
 * complete strip with no cuts yet and start the same sweep over again. */
const sceneProbeInFlight = new Set<string>();

/**
 * Scene-aware refinement, once the strip is already on screen: probe the clip
 * for its cuts, store them, and re-read only the tiles whose grab point moved
 * far enough that the midpoint was showing a neighbouring scene.
 */
async function refineSceneCuts(assetId: string, url: string, duration: number) {
  if (sceneProbeInFlight.has(assetId)) return;
  sceneProbeInFlight.add(assetId);
  try {
    const live = () => useEditor.getState().assets.find((a) => a.id === assetId);
    const { probes, cuts } = await sceneProbe(url, duration);
    if (!live()) return;
    useEditor.getState().updateAsset(assetId, { sceneCuts: cuts });
    const { count, thumbStep } = thumbGrid(duration);
    // The cuts land in the cache however the tiles turn out. A sweep that
    // moves no grab point still answered the expensive question, and a cache
    // written without the answer sends every later open through the whole
    // probe again.
    const persist = (fileName: string, thumbs: string[]) =>
      writeCache(stripCacheKey(useEditor.getState().projectId, fileName), {
        thumbs,
        thumbStep,
        cuts,
        duration,
        at: Date.now(),
      });
    const midpoints = pickThumbTimes(count, thumbStep, duration, []);
    const scened = pickThumbTimes(count, thumbStep, duration, probes);
    const moved = scened
      .map((t, i) => ({ t, i }))
      .filter(({ t, i }) => Math.abs(t - midpoints[i]) > thumbStep * THUMB_REGRAB_SHARE);
    const asset = live();
    if (!asset?.thumbs?.length) return;
    if (!moved.length) {
      persist(asset.fileName, asset.thumbs);
      return;
    }
    const regrabbed = new Map<number, string>();
    let k = 0;
    for await (const frame of framesAt(
      url,
      moved.map((m) => m.t),
      { height: THUMB_H }
    )) {
      const at = moved[k++];
      if (!frame || !at) continue;
      regrabbed.set(at.i, await rasterCanvasToDataUrl(frame.canvas, "image/jpeg", 0.92));
    }
    // The sweep above took a while; the strip on screen is the one to patch.
    const current = live();
    if (!current?.thumbs?.length) return;
    const thumbs = [...current.thumbs];
    for (const [i, tile] of regrabbed) if (i < thumbs.length) thumbs[i] = tile;
    useEditor.getState().updateAsset(assetId, { thumbs });
    persist(current.fileName, thumbs);
  } finally {
    sceneProbeInFlight.delete(assetId);
  }
}

// Exact edge frames: a clip's first and last filmstrip tiles show the true
// frames at its in/out points. Asset thumbs are fixed-interval midpoint
// samples, so edges are captured on demand at the precise source time. Each
// clip edge is a "slot" whose newest request supersedes queued ones (trim
// drags stay cheap); one serial loop reads frames from a small pool of
// per-URL readers.
//
// The pool is what makes a trim drag cheap. A reader holds a warm decoder and
// its cache of recently decoded frames, so the frames either side of where the
// handle already is come back without re-reading the file — which is the whole
// difference between this and re-opening the source per request.
const EDGE_CACHE_CAP = 300;
const EDGE_POOL_CAP = 4;

type EdgeRequest = {
  url: string;
  time: number;
  height: number;
  key: string;
  resolvers: ((src: string | null) => void)[];
};

/** A file held open for repeated frame reads, with a decoding sink per capture
 * height — trim edges and tile previews read different sizes from the same
 * warm reader. */
type EdgeReader = {
  input: ReturnType<typeof openMedia>;
  sinkFor: (height: number) => ReturnType<typeof frameSink>;
};

const edgeCache = new Map<string, string>();
const edgeQueue = new Map<string, EdgeRequest>();
/** Filmstrip tile captures wait here, behind every queued clip-edge capture,
 * so a trim drag's frames land first while a zoomed strip fills in behind. */
const edgeBackQueue = new Map<string, EdgeRequest>();
const edgePool = new Map<string, Promise<EdgeReader>>();
let edgePumping = false;

function edgeKey(url: string, time: number, height: number) {
  return `${url}#${time.toFixed(2)}@${height}`;
}

/** Synchronous cache read — the frame if a matching capture already landed. */
export function peekEdgeFrame(url: string, time: number, height = THUMB_H): string | null {
  return edgeCache.get(edgeKey(url, time, height)) ?? null;
}

/** Capture the frame at `time`, latest-wins per `slot` (a clip edge or a
 * strip tile). Resolves with the frame, or null when superseded by a newer
 * request or on a failed read. `background` requests wait behind every queued
 * foreground one. */
export function requestEdgeFrame(
  slot: string,
  url: string,
  time: number,
  height = THUMB_H,
  opts?: { background?: boolean }
): Promise<string | null> {
  const key = edgeKey(url, time, height);
  const hit = edgeCache.get(key);
  if (hit) return Promise.resolve(hit);
  const queue = opts?.background ? edgeBackQueue : edgeQueue;
  return new Promise((resolve) => {
    const prev = queue.get(slot);
    if (prev?.key === key) {
      prev.resolvers.push(resolve);
    } else {
      prev?.resolvers.forEach((r) => r(null));
      queue.set(slot, { url, time, height, key, resolvers: [resolve] });
    }
    void pumpEdgeFrames();
  });
}

/** Captures still queued or mid-read. The filmstrip eval waits on zero to
 * know a zoomed strip has finished filling in. */
export function edgeFramesPending(): number {
  return edgeQueue.size + edgeBackQueue.size + (edgePumping ? 1 : 0);
}

function edgeReader(url: string): Promise<EdgeReader> {
  const hit = edgePool.get(url);
  if (hit) {
    // Re-insert to refresh recency; the pool evicts oldest-first.
    edgePool.delete(url);
    edgePool.set(url, hit);
    return hit;
  }
  const opening = (async () => {
    const input = openMedia(url);
    const track = await videoTrackOf(input);
    if (!track) {
      input.dispose();
      throw new UnreadableMediaError("This file has no readable video.");
    }
    // A pool of canvases each sink cycles through, so a drag that reads
    // hundreds of frames keeps its allocation flat.
    const sinks = new Map<number, ReturnType<typeof frameSink>>();
    const sinkFor = (height: number) => {
      let sink = sinks.get(height);
      if (!sink) {
        sink = frameSink(track, { height }, { poolSize: 4, lowLatency: true });
        sinks.set(height, sink);
      }
      return sink;
    };
    return { input, sinkFor };
  })();
  edgePool.set(url, opening);
  while (edgePool.size > EDGE_POOL_CAP) {
    const [oldUrl, old] = edgePool.entries().next().value!;
    edgePool.delete(oldUrl);
    old.then((r) => r.input.dispose()).catch(() => {});
  }
  return opening;
}

async function pumpEdgeFrames() {
  if (edgePumping) return;
  edgePumping = true;
  try {
    for (;;) {
      const queue = edgeQueue.size ? edgeQueue : edgeBackQueue;
      const next = queue.entries().next();
      if (next.done) break;
      const [slot, req] = next.value;
      queue.delete(slot);
      let src = edgeCache.get(req.key) ?? null;
      if (!src) {
        try {
          const { sinkFor } = await edgeReader(req.url);
          const frame = await sinkFor(req.height).getCanvas(Math.max(0, req.time));
          if (!frame) throw new Error("No frame at that time.");
          src = await rasterCanvasToDataUrl(frame.canvas, "image/jpeg", 0.92);
          edgeCache.set(req.key, src);
          while (edgeCache.size > EDGE_CACHE_CAP) {
            edgeCache.delete(edgeCache.keys().next().value!);
          }
        } catch {
          src = null;
        }
      }
      req.resolvers.forEach((r) => r(src));
    }
  } finally {
    edgePumping = false;
  }
}

/** Waveform buckets per second of media. Density scaling with length keeps a
 * zoomed-in strip honest; the bounds keep tiny stings drawable and hour-long
 * files a bounded array. */
const PEAKS_PER_SECOND = 50;

function makePeaks(src: string | Blob, duration: number): Promise<number[]> {
  const buckets =
    duration > 0 ? Math.min(30_000, Math.max(400, Math.round(duration * PEAKS_PER_SECOND))) : 1600;
  return audioPeaks(src, buckets);
}
