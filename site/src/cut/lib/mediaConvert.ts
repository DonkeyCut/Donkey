"use client";

/**
 * Converting a project's media to MP4 — H.264 picture, AAC sound — in place.
 *
 * Footage arrives in whatever the camera wrote. A phone's .mov is HEVC, a
 * screen recorder's is ProRes with raw PCM sound, and neither decodes in
 * every browser: the clip previews black, or refuses to import at all.
 * Converting it is the repair, and it is the same repair someone means when
 * they say "turn these .mov files into mp4".
 *
 * Where a conversion runs is decided by where the bytes already are, because
 * moving a video file costs more than converting one:
 *
 *   Mac project      the engine's ffmpeg, on the file in the project folder.
 *   cloud project    a render-worker job, on the object in R2. The tab sends
 *                    nothing and waits on the job row it polls.
 *   browser project  this tab, where mediabunny drives WebCodecs — and where
 *                    a file whose streams already fit is copied packet for
 *                    packet, with no decoding at all. Footage this browser
 *                    has no decoder for goes to the Mac when the app is
 *                    running: the page posts the bytes to the engine and gets
 *                    an MP4 back, the trade transcription already makes.
 *   headless         a process with no page converts for itself. The engine
 *                    installs a converter that works the project folder
 *                    directly; the cloud runner carries decoders of its own
 *                    and runs the same in-process path a tab runs.
 *
 * The asset keeps its id and its name, so every clip cut from it keeps
 * playing; only the file underneath changes. The old file is deleted once the
 * new one is in the document — a conversion that left both behind would
 * double what the project costs against the user's storage.
 */

import {
  BufferTarget,
  Conversion,
  Mp4OutputFormat,
  Output,
  type ConversionAudioOptions,
  type ConversionVideoOptions,
} from "mediabunny";
import { apiFetch as engineFetch } from "./api";
import { getBackend, hasLocalCompute, type CutBackend } from "./backend";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import { pollCloudJob } from "./cloudJob";
import { enrichAsset, uploadProjectMediaTo } from "./media";
import { storedMediaUrl } from "./mediaSync";
import {
  audioTrackOf,
  hasUndecodableVideo,
  openMedia,
  probeMediaFile,
  videoTrackOf,
  withMedia,
} from "./mediaRead";
import { useEditor } from "./store";
import type { MediaAsset } from "./types";

/** One file in a project, as the converter addresses it. */
export interface ConvertSource {
  fileName: string;
  /** Where the bytes can be read when the conversion runs in this process. */
  url: string;
  /** Display name, for the message an error carries back to the user. */
  name: string;
}

export interface ConvertOptions {
  maxHeight?: number;
  /** Pinned by work that outlives navigation; defaults to the active one. */
  backend?: CutBackend;
}

/** A finished conversion: the new file, and what that file turned out to be,
 * so nothing downstream has to read it again. */
export interface FileConversion {
  fileName: string;
  /** False when the streams were copied into the new container untouched. */
  reencoded: boolean;
  /** The file was already an MP4 of the right streams, so it was left alone
   * and `fileName` is the one the project already had. */
  unchanged?: boolean;
  duration: number;
  width?: number;
  height?: number;
}

/** What a conversion did to an asset, reported back to whoever asked. */
export interface ConvertOutcome extends FileConversion {
  assetId: string;
  /** The asset's display name, rewritten to the new extension. */
  name: string;
}

/** What a headless host does for itself, in place of the client's backend
 * seam: it holds the project's files, so it converts and deletes them
 * directly rather than addressing itself over HTTP. */
export interface HostMediaStore {
  convert(projectId: string, source: ConvertSource, opts: ConvertOptions): Promise<FileConversion>;
  drop(projectId: string, fileName: string): Promise<void>;
}

/** In-process conversion holds the whole output in memory. A source past this
 * belongs on a machine with a disk, and saying so beats an out-of-memory tab
 * several minutes in. */
const IN_PROCESS_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const inPage = () => typeof document !== "undefined";

/** Containers that hold the target streams under the name people ask for. */
const MP4_EXT = /\.(mp4|m4v)$/i;

let host: HostMediaStore | null = null;

/** Install the store a headless host does its own media work with. */
export function setHostMediaStore(store: HostMediaStore | null) {
  host = store;
}

/** The MP4 name a source file converts to: same stem, `.mp4` extension. */
export const mp4NameFor = (fileName: string) =>
  `${fileName.replace(/\.[^./\\]+$/, "") || "media"}.mp4`;

/** A display name after conversion. A name carrying the camera's extension
 * gets the new one — the card reading IMG_4450.MOV under a file that is now
 * an MP4 is the card lying. A name with no extension is the user's words and
 * stays as written. */
export const mp4DisplayName = (name: string) =>
  /\.[a-z0-9]{2,4}$/i.test(name) ? mp4NameFor(name) : name;

/**
 * Convert one of a project's media files to MP4, leaving the original in
 * place. The result lands beside it under a deduped name; what points at
 * which file is the caller's to decide.
 */
export async function convertProjectFile(
  projectId: string,
  source: ConvertSource,
  opts: ConvertOptions = {}
): Promise<FileConversion> {
  if (host) return host.convert(projectId, source, opts);
  const backend = opts.backend ?? getBackend();
  // The machine that stores the bytes converts them: the Mac for its own
  // projects, the worker beside R2 for cloud ones. A headless process working
  // a cloud project is that machine, so it converts in-process.
  return backend.kind === "local" || (backend.kind === "cloud" && inPage())
    ? convertOnBackend(projectId, source, backend, opts.maxHeight)
    : convertNearThePage(projectId, source, { ...opts, backend });
}

/**
 * Convert one project asset to MP4 and point the asset at the result.
 *
 * `maxHeight` caps the picture's height, which forces a re-encode when the
 * source is taller. Everything else is decided from the file: streams that
 * already fit the container are copied, the rest are re-encoded.
 */
export async function convertAssetToMp4(
  projectId: string,
  asset: MediaAsset,
  opts: ConvertOptions = {}
): Promise<ConvertOutcome> {
  if (asset.type === "image") throw new Error("Images have nothing to convert.");
  const backend = opts.backend ?? getBackend();
  const made = await convertProjectFile(
    projectId,
    { fileName: asset.fileName, url: asset.url, name: asset.name },
    { ...opts, backend }
  );

  if (made.unchanged) return { assetId: asset.id, name: asset.name, ...made };

  const patch: Partial<MediaAsset> = {
    fileName: made.fileName,
    name: mp4DisplayName(asset.name),
    url: await storedMediaUrl(projectId, made.fileName, backend),
    duration: made.duration,
    ...(made.width !== undefined ? { width: made.width } : {}),
    ...(made.height !== undefined ? { height: made.height } : {}),
    // The filmstrip and waveform were read off bytes that are about to be
    // deleted; enrichAsset fills them again from the new file.
    thumbs: undefined,
    thumbStep: undefined,
    peaks: undefined,
  };
  useEditor.getState().updateAsset(asset.id, patch);
  void enrichAsset({ ...asset, ...patch }).catch(() => {});
  // Best effort: a file left behind costs storage while everything else
  // already points at the new one.
  void dropProjectFile(projectId, asset.fileName, backend).catch(() => {});

  return { assetId: asset.id, name: patch.name!, ...made };
}

/** Delete a project file through whichever side owns the storage. */
export function dropProjectFile(
  projectId: string,
  fileName: string,
  backend: CutBackend = getBackend()
): Promise<unknown> {
  if (host) return host.drop(projectId, fileName);
  return backend.fetch(`/api/cut/projects/${projectId}/media/${encodeURIComponent(fileName)}`, {
    method: "DELETE",
  });
}

/** Server answer shape, identical from the engine's project route and the
 * worker's job result. */
interface ServerConvert {
  fileName?: string;
  duration?: number;
  width?: number;
  height?: number;
  transcodedVideo?: boolean;
  transcodedAudio?: boolean;
  unchanged?: boolean;
  error?: string;
}

const fromServer = (body: ServerConvert): FileConversion => ({
  fileName: body.fileName!,
  reencoded: !!body.transcodedVideo || !!body.transcodedAudio,
  ...(body.unchanged ? { unchanged: true } : {}),
  duration: body.duration ?? 0,
  ...(body.width !== undefined ? { width: body.width, height: body.height } : {}),
});

/** The engine converts the project's file synchronously; the cloud queues a
 * worker job and this polls it. Both answer with the same fields. */
async function convertOnBackend(
  projectId: string,
  source: ConvertSource,
  backend: CutBackend,
  maxHeight?: number
): Promise<FileConversion> {
  const res = await backend.fetch(`/api/cut/projects/${projectId}/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: source.fileName, ...(maxHeight ? { maxHeight } : {}) }),
  });
  let body: ServerConvert;
  if (backend.kind === "cloud") {
    const started = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
    if (!res.ok || !started.jobId) throw new Error(started.error ?? "Could not convert that file.");
    body = await pollCloudJob(
      started.jobId,
      backend,
      "Could not convert that file.",
      { timedOut: "The conversion took too long." }
    );
  } else {
    body = (await res.json().catch(() => ({}))) as ServerConvert;
    if (!res.ok) throw new Error(body.error ?? "Could not convert that file.");
  }
  if (!body.fileName) throw new Error(body.error ?? "Could not convert that file.");
  return fromServer(body);
}

/** No machine stores this project, so the work happens beside the bytes: in
 * this process, or on the Mac when this process has no decoder for them. */
async function convertNearThePage(
  projectId: string,
  source: ConvertSource,
  opts: ConvertOptions
): Promise<FileConversion> {
  const decodable = await withMedia(
    source.url,
    async (input) => !(await hasUndecodableVideo(input))
  );
  if (decodable) return convertInProcess(projectId, source, opts);
  if (hasLocalCompute()) return convertOnTheMac(projectId, source, opts);
  throw new Error(
    `${source.name} is in a format this browser can't decode. Run the Donkey app to convert it on this Mac, open the project in Safari, or move it to the cloud.`
  );
}

/**
 * Convert in this process with mediabunny: WebCodecs in a tab, the headless
 * runtime's decoders in a worker. Source packets that already fit the
 * container are copied, which makes the common .mov of H.264 a fast remux
 * with no decoding at all.
 */
async function convertInProcess(
  projectId: string,
  source: ConvertSource,
  opts: ConvertOptions
): Promise<FileConversion> {
  const bytes = resolveRegisteredBlob(source.url);
  if (bytes && bytes.size > IN_PROCESS_MAX_BYTES) {
    throw new Error(`${source.name} is too large to convert here.`);
  }
  const input = openMedia(source.url);
  try {
    const [video, audio] = await Promise.all([videoTrackOf(input), audioTrackOf(input)]);
    const height = video ? await video.getDisplayHeight() : 0;
    const cap = opts.maxHeight && opts.maxHeight > 0 ? Math.round(opts.maxHeight) : 0;
    const shrink = !!(cap && height > cap);
    // Already the file a conversion would produce — a second pass would copy
    // it to a new name and change nothing.
    if (
      MP4_EXT.test(source.fileName) &&
      !shrink &&
      (!video || video.codec === "avc") &&
      (!audio || audio.codec === "aac")
    ) {
      return {
        fileName: source.fileName,
        reencoded: false,
        unchanged: true,
        duration: await input.computeDuration(),
        ...(video ? { width: await video.getDisplayWidth(), height } : {}),
      };
    }
    // A stream already in the target codec is copied packet for packet; what
    // is left over is what gets decoded and re-encoded.
    const reencoded =
      (!!video && (video.codec !== "avc" || shrink)) || (!!audio && audio.codec !== "aac");
    const videoOptions: ConversionVideoOptions = {
      codec: "avc",
      ...(shrink ? { height: cap } : {}),
    };
    const audioOptions: ConversionAudioOptions = { codec: "aac" };

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: videoOptions,
      audio: audioOptions,
    });
    if (!conversion.isValid) {
      const reason = conversion.discardedTracks[0]?.reason;
      throw new Error(
        reason === "undecodable_source_codec" || reason === "no_encodable_target_codec"
          ? `${source.name} is in a format this browser can't convert. Run the Donkey app to convert it on this Mac, open the project in Safari, or move it to the cloud.`
          : `Could not convert ${source.name}.`
      );
    }
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error(`Could not convert ${source.name}.`);
    const made = await land(projectId, source, new Blob([buffer], { type: "video/mp4" }), opts);
    return { ...made, reencoded };
  } finally {
    input.dispose();
  }
}

/** Hand the bytes to the Mac and take the MP4 back. The engine keeps nothing:
 * it converts what it is given and answers with the file. */
async function convertOnTheMac(
  projectId: string,
  source: ConvertSource,
  opts: ConvertOptions
): Promise<FileConversion> {
  const bytes = resolveRegisteredBlob(source.url) ?? (await (await fetch(source.url)).blob());
  const form = new FormData();
  form.append("file", bytes, source.fileName);
  if (opts.maxHeight) form.append("maxHeight", String(Math.round(opts.maxHeight)));
  const res = await engineFetch("/api/cut/convert", { method: "POST", body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not convert ${source.name}.`);
  }
  // The handoff only happens for footage this process cannot decode, which is
  // footage the Mac had to re-encode.
  return land(projectId, source, await res.blob(), opts);
}

/** Store a converted blob in the project and read back what it is. */
async function land(
  projectId: string,
  source: ConvertSource,
  blob: Blob,
  opts: ConvertOptions
): Promise<FileConversion> {
  const fileName = await uploadProjectMediaTo(
    opts.backend ?? getBackend(),
    projectId,
    blob,
    mp4NameFor(source.fileName)
  );
  const meta = await probeMediaFile(blob);
  return {
    fileName,
    reencoded: true,
    duration: meta.duration,
    ...(meta.width !== undefined ? { width: meta.width, height: meta.height } : {}),
  };
}
