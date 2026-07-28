"use client";

import { apiFetch, apiJson, getBackend, type CutBackend } from "./backend";
import { quotaErrorMessage } from "./backend/cloud";
import { encodeWav } from "./cloudTranscribe";
import { useEditor } from "./store";
import type { AssetType, AudioClip, MediaAsset, ProjectSummary, StoredAsset, VideoClip } from "./types";
import { IMAGE_CLIP_SECONDS, mediaUrl } from "./types";

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

/** Claim a name and mint a direct-to-R2 PUT for one file. The name is deduped
 * and reserved server-side before the URL comes back, so callers can build the
 * asset's final identity before a single byte moves. */
export async function presignUpload(
  presignPath: string,
  file: Blob,
  name: string,
  backend: CutBackend = getBackend()
): Promise<{ key: string; url: string; fileName: string }> {
  const mime = file.type || "application/octet-stream";
  const res = await backend.fetch(presignPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName: name, mime, bytes: file.size }),
  });
  const body = await apiJson<{ key?: string; url?: string; fileName?: string }>(res);
  if (!res.ok || !body.key || !body.url) {
    throw new Error(quotaErrorMessage(res.status, body) ?? body.error ?? "Upload failed.");
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

/** PUT a blob to a presigned R2 URL. XHR rather than fetch: it is the only way
 * to watch the bytes leave, which is what an upload running behind the editor
 * has to report. */
export function putSigned(
  url: string,
  file: Blob,
  mime?: string,
  opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<void> {
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
  name: string
): Promise<string> {
  if (backend.kind !== "cloud") {
    const form = new FormData();
    form.append("file", file, name);
    const res = await backend.fetch(`/api/cut/projects/${projectId}/media`, {
      method: "POST",
      body: form,
    });
    const body = await apiJson<{ fileName?: string }>(res);
    if (!res.ok || !body.fileName) throw new Error(body.error ?? "Upload failed.");
    return body.fileName;
  }
  const key = await presignedUpload(
    `/api/cut/projects/${projectId}/media/presign`,
    file,
    name,
    backend
  );
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
  opts?: { name?: string; origin?: "generated"; failMessage?: string; backend?: CutBackend }
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

/** Read a media URL's kind/duration/dimensions with the browser's own
 * decoders. The probe can correct the guessed kind: a "video" container with
 * no video stream is really audio. */
async function probeMedia(type: AssetType, url: string): Promise<ProbedMeta> {
  if (type === "image") {
    // Images have no intrinsic duration; the timeline clip carries its length.
    const dims = await loadImageMeta(url);
    return { type, duration: 0, width: dims.width, height: dims.height };
  }
  if (type === "video") {
    const v = await loadVideoMeta(url);
    if (v.videoWidth === 0) return { type: "audio", duration: v.duration };
    return { type, duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  }
  // Decode for a sample-exact duration (HTMLAudioElement overestimates MP3s,
  // leaving a placed clip running past its real audio) and reuse the same
  // decode for the waveform, so enrichAsset has nothing left to do.
  const audio = await decodeAudio(url);
  if (audio && audio.duration > 0) {
    return { type, duration: audio.duration, peaks: peaksFromChannel(audio.getChannelData(0)) };
  }
  return { type, duration: await loadAudioDuration(url) };
}

/** Probe a media file's kind/duration/dimensions in the browser via an object
 * URL — for backends that can't probe server-side (cloud library complete). */
export async function probeFileMeta(file: File): Promise<{
  type: AssetType;
  duration: number;
  width?: number;
  height?: number;
}> {
  const url = URL.createObjectURL(file);
  try {
    const meta = await probeMedia(assetTypeOf(file) ?? "video", url);
    return { type: meta.type, duration: meta.duration, width: meta.width, height: meta.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** An import that is on screen before its bytes have left the browser. */
export type PendingImport = {
  /** Ready to add to the project: plays from `localUrl`, carries its final
   * `fileName`, and is marked `upload` until the bytes land. */
  asset: MediaAsset;
  /** The object URL the asset plays from until the stored file takes over. */
  localUrl: string;
  /** Send the bytes and mark the object complete. */
  send: (opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<void>;
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

  const localUrl = URL.createObjectURL(file);
  try {
    // Probing and claiming the name are independent, so the asset is ready
    // after whichever is slower rather than after both in turn.
    const [meta, signed] = await Promise.all([
      probeMedia(type, localUrl),
      presignUpload(`/api/cut/projects/${projectId}/media/presign`, file, file.name, backend),
    ]);
    const asset: MediaAsset = {
      id: uid(),
      fileName: signed.fileName,
      name: file.name,
      type: meta.type,
      duration: meta.duration,
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
      ...(meta.peaks ? { peaks: meta.peaks } : {}),
      url: localUrl,
      upload: { progress: 0 },
    };
    const send = async (opts?: {
      onProgress?: (fraction: number) => void;
      signal?: AbortSignal;
    }) => {
      await putSigned(signed.url, file, file.type || "application/octet-stream", opts);
      const res = await backend.fetch(`/api/cut/projects/${projectId}/media/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: signed.key }),
      });
      const body = await apiJson<{ fileName?: string }>(res);
      if (!res.ok || !body.fileName) throw new Error(body.error ?? "Upload failed.");
    };
    return { asset, localUrl, send };
  } catch (err) {
    URL.revokeObjectURL(localUrl);
    throw err;
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

  const fileName = await uploadProjectMediaTo(backend, projectId, file, file.name);
  const url = mediaUrl(projectId, fileName, backend);
  const meta = await probeMedia(type, url);
  return {
    id: uid(),
    fileName,
    name: file.name,
    type: meta.type,
    duration: meta.duration,
    ...(meta.width !== undefined ? { width: meta.width } : {}),
    ...(meta.height !== undefined ? { height: meta.height } : {}),
    ...(meta.peaks ? { peaks: meta.peaks } : {}),
    url,
  };
}

/** Natural pixel size of an image URL, for framing on the timeline. */
function loadImageMeta(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

/** Store a fetchable image (a stock tile) in the project's media as a
 * first-class image asset at its native resolution — no video baking — and
 * register it, without placing it on the timeline. Callers choose where it
 * lands. */
export async function importImage(
  projectId: string,
  image: { url: string; name: string }
): Promise<MediaAsset> {
  const dl = await fetch(image.url);
  if (!dl.ok) throw new Error("Could not read the image.");
  const blob = await dl.blob();
  const body = await uploadProjectImage(projectId, blob, image.url.split("/").pop() || "image.png", {
    name: image.name,
  });
  // A stock image lands on the timeline where the caller places it, not in the
  // Media panel — tag it so it stays out.
  const asset: MediaAsset = { ...body, origin: "stock" };
  useEditor.getState().addAsset(asset);
  void enrichAsset(asset);
  return asset;
}

/** Store a fetchable video (a stock clip) in the project's media as a regular
 * video asset and register it, without placing it on the timeline. Callers
 * choose where it lands. */
export async function importStockVideo(
  projectId: string,
  video: { url: string; name: string }
): Promise<MediaAsset> {
  const dl = await fetch(video.url);
  if (!dl.ok) throw new Error("Could not read the video.");
  const blob = await dl.blob();
  const file = new File([blob], video.url.split("/").pop() || "video.mp4", {
    type: blob.type || "video/mp4",
  });
  const asset = await importFileToProject(projectId, file);
  if (!asset) throw new Error("Could not add the video.");
  asset.name = video.name;
  // Like a stock image, it lands where the caller places it, not in Media.
  asset.origin = "stock";
  useEditor.getState().addAsset(asset);
  void enrichAsset(asset);
  return asset;
}

/** Store a bundled stock-music bed in the project's media as a regular audio
 * asset and register it, without placing it on the timeline — callers choose
 * where it lands (the soundtrack). Tagged "stock" so it stays out of Media. */
export async function importStockMusic(
  projectId: string,
  music: { url: string; name: string }
): Promise<MediaAsset> {
  const dl = await fetch(music.url);
  if (!dl.ok) throw new Error("Could not read the music.");
  const blob = await dl.blob();
  const file = new File([blob], music.url.split("/").pop() || "music.mp3", {
    type: blob.type || "audio/mpeg",
  });
  const asset = await importFileToProject(projectId, file);
  if (!asset) throw new Error("Could not add the music.");
  asset.name = music.name;
  asset.origin = "stock";
  useEditor.getState().addAsset(asset);
  void enrichAsset(asset);
  return asset;
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
  // Pinned at start: the download can outlast navigation into a project of
  // the other residency, and every poll must hit the backend the job started on.
  const backend = getBackend();
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
    body = await pollImportUrlJob(started.jobId, backend);
  } else {
    body = await apiJson<{ files?: { fileName: string; title: string }[]; text?: string }>(res);
  }
  // A source that is only words (a text post, an article, a page) imports as
  // that text with no files, so an empty file list with text is a success.
  if (!res.ok || (!body.files?.length && !body.text)) {
    throw new Error(body.error ?? "Could not import that URL.");
  }
  const assets: MediaAsset[] = [];
  for (const f of body.files ?? []) {
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
  return { assets, text: body.text };
}

/** Poll a cloud import-url job to completion (2s cadence, ~10 min cap) and
 * return the engine-shaped {files, text} result. Fails only when the job
 * itself says so — state "error", or the job gone (404) — or after several
 * consecutive failed polls; a single dropped request keeps polling. */
async function pollImportUrlJob(
  jobId: string,
  backend: CutBackend
): Promise<{ files?: { fileName: string; title: string }[]; text?: string }> {
  const deadline = Date.now() + 10 * 60 * 1000;
  const MAX_STRIKES = 6;
  let strikes = 0;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Could not import that URL.");
    await new Promise((r) => setTimeout(r, 2000));
    let res: Response | null = null;
    try {
      res = await backend.fetch(`/api/cut/jobs/${jobId}`);
    } catch {
      // Network blip — a strike, counted below.
    }
    // The create call returned this job's id, so a 404 means it's gone.
    if (res?.status === 404) throw new Error("Could not import that URL.");
    if (!res?.ok) {
      if (++strikes >= MAX_STRIKES) throw new Error("Could not import that URL.");
      continue;
    }
    strikes = 0;
    const job = await apiJson<{
      state?: string;
      result?: { files?: { fileName: string; title: string }[]; text?: string };
    }>(res);
    if (job.state === "error") throw new Error(job.error ?? "Could not import that URL.");
    if (job.state === "done") return job.result ?? {};
  }
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
  const v = await loadVideoMeta(url);
  asset.duration = v.duration;
  if (v.videoWidth === 0) {
    asset.type = "audio";
  } else {
    asset.width = v.videoWidth;
    asset.height = v.videoHeight;
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
  duration = 0
): Promise<MediaAsset> {
  const v = await loadVideoMeta(sourceUrl);
  await seekTo(v, Math.max(0, srcTime));
  const canvas = document.createElement("canvas");
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  canvas.getContext("2d")!.drawImage(v, 0, 0);
  v.removeAttribute("src");
  v.load();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Could not render the freeze frame.");
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fileName = `freeze-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${uid().slice(0, 4)}.png`;
  const asset = await uploadProjectImage(projectId, blob, fileName, {
    failMessage: "Could not render the freeze frame.",
  });
  return duration > 0 ? { ...asset, duration } : asset;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cloud twin of the engine's silence route (ffmpeg silencedetect): decode the
 * source's audio and scan 20ms RMS windows against the same dB threshold and
 * minimum-duration rules. Times are absolute source seconds. */
export async function detectSilenceClientSide(
  sourceUrl: string,
  opts: { from: number; to?: number; thresholdDb: number; minSilence: number }
): Promise<{ start: number; end: number; duration: number }[]> {
  const audio = await decodeAudio(sourceUrl);
  if (!audio) throw new Error("This file has no audio track.");
  const to = Math.min(opts.to ?? audio.duration, audio.duration);
  const from = Math.max(0, Math.min(opts.from, to));
  if (!(to > from)) return [];
  const rate = audio.sampleRate;
  const win = Math.max(1, Math.round(rate * 0.02));
  const threshold = Math.pow(10, opts.thresholdDb / 20);
  const channels = Array.from({ length: audio.numberOfChannels }, (_, c) =>
    audio.getChannelData(c)
  );
  const first = Math.floor(from * rate);
  const last = Math.min(audio.length, Math.ceil(to * rate));
  const silences: { start: number; end: number; duration: number }[] = [];
  let open: number | null = null;
  const close = (endT: number) => {
    if (open !== null && endT - open >= opts.minSilence) {
      const start = round2(Math.max(from, open));
      const end = round2(Math.min(to, endT));
      if (end > start) silences.push({ start, end, duration: round2(end - start) });
    }
    open = null;
  };
  for (let s = first; s < last; s += win) {
    const e = Math.min(last, s + win);
    let sum = 0;
    for (const ch of channels) {
      for (let i = s; i < e; i++) sum += ch[i] * ch[i];
    }
    const rms = Math.sqrt(sum / ((e - s) * channels.length));
    if (rms < threshold) {
      if (open === null) open = s / rate;
    } else {
      close(s / rate);
    }
  }
  close(to);
  return silences;
}

/** Cloud twin of the engine's audio-extract route: render a span of the
 * source's audio to 16 kHz mono WAV in the browser, for the AI to hear
 * inline. An empty `to` runs to the end. */
export async function renderAudioSpanWav(
  sourceUrl: string,
  from: number,
  to: number | undefined
): Promise<Blob> {
  const audio = await decodeAudio(sourceUrl);
  if (!audio) throw new Error("This file has no audio track.");
  const end = Math.min(to ?? audio.duration, audio.duration);
  const start = Math.max(0, Math.min(from, end));
  const dur = end - start;
  if (!(dur > 0)) throw new Error("from/to describe an empty range.");
  const rate = 16000; // encodeWav's fixed sample rate
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(dur * rate)), rate);
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);
  src.start(0, start, dur);
  return encodeWav((await ctx.startRendering()).getChannelData(0));
}

// The engine's contact-sheet geometry (server/frames.ts), mirrored exactly so
// the tool's stampSheet lands each cell's time stamp in the same place in
// both modes.
const SHEET_GRID = 3; // cells per row and column
const SHEET_CELL = 480; // cell long side, px
const SHEET_GAP = 4; // tile margin and padding, px
const SHEET_MAX = 4; // sheets per call
const SHEET_QUALITY = 0.8; // jpeg encode

export interface WatchSheets {
  sheets: { image: string; frames: { t: number }[] }[];
  layout: { grid: number; margin: number; padding: number };
  sceneChanges: number[];
  coveredTo: number;
  truncated: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// The engine scales with ffmpeg's scale=480:-2, which rounds the short side
// to even; mirror it so cell geometry matches to the pixel.
const cellDims = (w: number, h: number): [number, number] =>
  w >= h
    ? [SHEET_CELL, Math.max(2, 2 * Math.round((SHEET_CELL * h) / w / 2))]
    : [Math.max(2, 2 * Math.round((SHEET_CELL * w) / h / 2)), SHEET_CELL];

/** Cloud twin of the engine's watch route for a still image: one downscaled
 * cell, no time axis. */
export async function makeStillSheetClientSide(sourceUrl: string): Promise<WatchSheets> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not read the image."));
    img.src = sourceUrl;
  });
  if (img.naturalWidth === 0 || img.naturalHeight === 0)
    throw new Error("Could not read the image.");
  const [w, h] = cellDims(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not read the image.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  return {
    sheets: [{ image: canvas.toDataURL("image/jpeg", SHEET_QUALITY), frames: [{ t: 0 }] }],
    layout: { grid: 1, margin: 0, padding: 0 },
    sceneChanges: [],
    coveredTo: 0,
    truncated: false,
  };
}

/** Cloud twin of the engine's watch route: seek the source in the browser and
 * tile downscaled frames into timestamped contact sheets, with the route's
 * defaults, clamps, and per-call caps. Frames land on the steady interval
 * only — scene detection needs a decoder — so sceneChanges stays empty and
 * scene fields are omitted. */
export async function makeContactSheetsClientSide(
  sourceUrl: string,
  opts: { from: number; to?: number; interval?: number }
): Promise<WatchSheets> {
  const v = await loadVideoMeta(sourceUrl);
  try {
    if (v.videoWidth === 0) throw new Error("Could not sample the video.");
    const from = Math.max(0, opts.from);
    const wanted = opts.to ?? v.duration;
    if (opts.to === undefined && !(wanted > 0))
      throw new Error("Could not read the media duration — pass to (seconds).");
    if (!(wanted > from)) throw new Error("from/to describe an empty range.");
    const to = Math.min(wanted, from + 600); // bound the work per call; callers resume from coveredTo
    const interval =
      opts.interval !== undefined
        ? clamp(opts.interval, 0.5, 30)
        : clamp((to - from) / 32, 2, 30);

    const perSheet = SHEET_GRID * SHEET_GRID;
    const times: number[] = [];
    for (let t = from; t < to && times.length < SHEET_MAX * perSheet; t += interval)
      times.push(round2(t));

    const [cw, ch] = cellDims(v.videoWidth, v.videoHeight);
    const sheetW = 2 * SHEET_GAP + SHEET_GRID * cw + (SHEET_GRID - 1) * SHEET_GAP;
    const sheetH = 2 * SHEET_GAP + SHEET_GRID * ch + (SHEET_GRID - 1) * SHEET_GAP;
    const sheets: WatchSheets["sheets"] = [];
    for (let i = 0; i < times.length; i += perSheet) {
      const chunk = times.slice(i, i + perSheet);
      const canvas = document.createElement("canvas");
      canvas.width = sheetW;
      canvas.height = sheetH;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not sample the video.");
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, sheetW, sheetH);
      ctx.imageSmoothingQuality = "high";
      for (let j = 0; j < chunk.length; j++) {
        await seekTo(v, chunk[j]);
        const x = SHEET_GAP + (j % SHEET_GRID) * (cw + SHEET_GAP);
        const y = SHEET_GAP + Math.floor(j / SHEET_GRID) * (ch + SHEET_GAP);
        ctx.drawImage(v, x, y, cw, ch);
      }
      sheets.push({
        image: canvas.toDataURL("image/jpeg", SHEET_QUALITY),
        frames: chunk.map((t) => ({ t })),
      });
    }
    const lastT = times.length > 0 ? times[times.length - 1] : from;
    const capped = times.length >= SHEET_MAX * perSheet && lastT < to - interval;
    // The per-call span bound is itself truncation — the caller asked for more.
    const truncated = capped || to < wanted;
    return {
      sheets,
      layout: { grid: SHEET_GRID, margin: SHEET_GAP, padding: SHEET_GAP },
      sceneChanges: [],
      coveredTo: capped ? lastT : to,
      truncated,
    };
  } finally {
    v.removeAttribute("src");
    v.load();
  }
}

/** Generate filmstrip thumbnails / waveform peaks and merge them into the
 * store. Safe to call repeatedly; skips assets that are already enriched.
 * `src` overrides where the frames are read from — an import still uploading
 * has the bytes in the browser already, so it need not wait or re-download. */
export async function enrichAsset(asset: MediaAsset, src = asset.url) {
  try {
    if (asset.type === "image") {
      // A still is its own filmstrip: one frame, tiled across the clip.
      if (!asset.thumbs?.length) {
        useEditor.getState().updateAsset(asset.id, { thumbs: [src], thumbStep: IMAGE_CLIP_SECONDS });
      }
    } else if (asset.type === "video" && !asset.thumbs?.length) {
      const key = stripCacheKey(useEditor.getState().projectId, asset.fileName);
      const cached = await readCachedStrip(key, asset.duration);
      if (cached) {
        useEditor.getState().updateAsset(asset.id, { thumbs: cached.thumbs, thumbStep: cached.thumbStep });
      } else {
        const { thumbs, thumbStep } = await makeThumbs(src, asset.duration);
        useEditor.getState().updateAsset(asset.id, { thumbs, thumbStep });
        writeCachedStrip(key, { thumbs, thumbStep, duration: asset.duration, at: Date.now() });
      }
    } else if (asset.type === "audio" && !asset.peaks?.length) {
      const peaks = await makePeaks(src);
      useEditor.getState().updateAsset(asset.id, { peaks });
    }
  } catch {
    // Thumbnails and waveforms are decorative; editing works without them.
  }
}

/** Waveform peaks on demand — e.g. when a video clip's audio is detached
 * onto the soundtrack track (video assets don't get peaks at import). */
export async function ensurePeaks(asset: MediaAsset) {
  try {
    if (!asset.peaks?.length) {
      const peaks = await makePeaks(asset.url);
      useEditor.getState().updateAsset(asset.id, { peaks });
    }
  } catch {
    // Waveforms are decorative; editing works without them.
  }
}

/** MediaRecorder webm files report Infinity until seeked to the end. */
function ensureFiniteDuration(el: HTMLVideoElement | HTMLAudioElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return Promise.resolve(el.duration);
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener("durationchange", done);
      clearTimeout(timer);
      el.currentTime = 0;
      resolve(Number.isFinite(el.duration) ? el.duration : 0);
    };
    const timer = setTimeout(done, 4000);
    el.addEventListener("durationchange", done);
    el.currentTime = 1e7;
  });
}

function loadVideoMeta(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    // Media may come from the engine on another origin; anonymous CORS keeps
    // canvas frame grabs (filmstrips, AI captures) from tainting.
    v.crossOrigin = "anonymous";
    v.src = url;
    v.onloadedmetadata = () => void ensureFiniteDuration(v).then(() => resolve(v));
    v.onerror = () => reject(new Error("Could not read this video file."));
  });
}

export function loadAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = new Audio();
    a.preload = "metadata";
    a.src = url;
    a.onloadedmetadata = () => void ensureFiniteDuration(a).then(resolve);
    a.onerror = () => reject(new Error("Could not read this audio file."));
  });
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

type CachedStrip = { thumbs: string[]; thumbStep: number; duration: number; at: number };

function stripCacheKey(projectId: string | null, fileName: string) {
  return `${projectId ?? ""}/${fileName}@${THUMB_H}`;
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

function writeCachedStrip(key: string, strip: CachedStrip) {
  void (async () => {
    try {
      const db = await openStripDb();
      const tx = db.transaction(STRIP_STORE, "readwrite");
      const store = tx.objectStore(STRIP_STORE);
      store.put(strip, key);
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

async function makeThumbs(url: string, duration: number) {
  const v = await loadVideoMeta(url);
  // One frame every ~2s (min 10, max 24) so long clips don't repeat frames.
  const count = Math.min(24, Math.max(10, Math.round(duration / 2)));
  const thumbStep = duration / count;
  const aspect = v.videoWidth / Math.max(1, v.videoHeight);
  const w = Math.max(64, Math.round(THUMB_H * aspect));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = THUMB_H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const thumbs: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(duration - 0.05, (i + 0.5) * thumbStep);
    await seekTo(v, Math.max(0, t));
    ctx.drawImage(v, 0, 0, w, THUMB_H);
    thumbs.push(canvas.toDataURL("image/jpeg", 0.92));
  }
  v.removeAttribute("src");
  v.load();
  return { thumbs, thumbStep };
}

// Exact edge frames: a clip's first and last filmstrip tiles show the true
// frames at its in/out points. Asset thumbs are fixed-interval midpoint
// samples, so edges are captured on demand at the precise source time. Each
// clip edge is a "slot" whose newest request supersedes queued ones (trim
// drags stay cheap); one serial loop performs the seeks on a small pool of
// shared per-URL video elements.
const EDGE_CACHE_CAP = 300;
const EDGE_POOL_CAP = 4;

type EdgeRequest = {
  url: string;
  time: number;
  key: string;
  resolvers: ((src: string | null) => void)[];
};

const edgeCache = new Map<string, string>();
const edgeQueue = new Map<string, EdgeRequest>();
const edgePool = new Map<string, Promise<HTMLVideoElement>>();
let edgePumping = false;

function edgeKey(url: string, time: number) {
  return `${url}#${time.toFixed(2)}`;
}

/** Synchronous cache read — the frame if a matching capture already landed. */
export function peekEdgeFrame(url: string, time: number): string | null {
  return edgeCache.get(edgeKey(url, time)) ?? null;
}

/** Capture the frame at `time`, latest-wins per `slot` (a clip edge). Resolves
 * with the frame, or null when superseded by a newer request or on a failed
 * read. */
export function requestEdgeFrame(slot: string, url: string, time: number): Promise<string | null> {
  const key = edgeKey(url, time);
  const hit = edgeCache.get(key);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const prev = edgeQueue.get(slot);
    if (prev?.key === key) {
      prev.resolvers.push(resolve);
    } else {
      prev?.resolvers.forEach((r) => r(null));
      edgeQueue.set(slot, { url, time, key, resolvers: [resolve] });
    }
    void pumpEdgeFrames();
  });
}

function edgeVideo(url: string): Promise<HTMLVideoElement> {
  const hit = edgePool.get(url);
  if (hit) {
    // Re-insert to refresh recency; the pool evicts oldest-first.
    edgePool.delete(url);
    edgePool.set(url, hit);
    return hit;
  }
  const loading = loadVideoMeta(url);
  edgePool.set(url, loading);
  while (edgePool.size > EDGE_POOL_CAP) {
    const [oldUrl, old] = edgePool.entries().next().value!;
    edgePool.delete(oldUrl);
    old
      .then((v) => {
        v.removeAttribute("src");
        v.load();
      })
      .catch(() => {});
  }
  return loading;
}

async function pumpEdgeFrames() {
  if (edgePumping) return;
  edgePumping = true;
  try {
    for (;;) {
      const next = edgeQueue.entries().next();
      if (next.done) break;
      const [slot, req] = next.value;
      edgeQueue.delete(slot);
      let src = edgeCache.get(req.key) ?? null;
      if (!src) {
        try {
          const v = await edgeVideo(req.url);
          const max = Math.max(0, (Number.isFinite(v.duration) ? v.duration : req.time) - 0.05);
          await seekTo(v, Math.max(0, Math.min(req.time, max)));
          const aspect = v.videoWidth / Math.max(1, v.videoHeight);
          const w = Math.max(64, Math.round(THUMB_H * aspect));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = THUMB_H;
          const ctx = canvas.getContext("2d")!;
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(v, 0, 0, w, THUMB_H);
          src = canvas.toDataURL("image/jpeg", 0.92);
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

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      v.removeEventListener("seeked", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 1500);
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}

const PEAK_BUCKETS = 1600;

/** Decode an audio URL to a buffer, or null on any failure (a bad/undecodable
 * file). The decoded buffer's duration is sample-exact — the source of truth for
 * an audio clip's length, unlike HTMLAudioElement.duration, which overestimates
 * MP3s and would leave a placed clip running past its real audio. */
async function decodeAudio(url: string): Promise<AudioBuffer | null> {
  try {
    const buf = await (await fetch(url)).arrayBuffer();
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    try {
      return await ctx.decodeAudioData(buf);
    } finally {
      void ctx.close();
    }
  } catch {
    return null;
  }
}

/** Normalized 0..1 waveform peaks from a decoded buffer's first channel. */
function peaksFromChannel(data: Float32Array): number[] {
  const bucketSize = Math.max(1, Math.floor(data.length / PEAK_BUCKETS));
  const peaks: number[] = [];
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    let max = 0;
    const from = i * bucketSize;
    const to = Math.min(data.length, from + bucketSize);
    for (let j = from; j < to; j += 8) {
      const v = Math.abs(data[j]);
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  return peaks;
}

async function makePeaks(url: string): Promise<number[]> {
  const audio = await decodeAudio(url);
  return audio ? peaksFromChannel(audio.getChannelData(0)) : [];
}
