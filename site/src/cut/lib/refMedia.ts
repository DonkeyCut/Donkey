"use client";

import { refFromAsset, refFromTextFile, type AssetRef } from "./assetRef";
import { tagChatAsset } from "./chatAssets";
import { startUpload } from "./importQueue";
import {
  enrichAsset,
  importFileToProject,
  isMediaFile,
  isTextFile,
  prepareImport,
  renderAudioSpanWav,
} from "./media";
import { frameSink, openMedia, videoTrackOf } from "./mediaRead";
import { createRasterCanvas, rasterCanvasToDataUrl } from "./raster";
import { useEditor } from "./store";
import { formatTime } from "./time";

// Turn refs and dropped files into what the hosted models take. Generation
// routes read `inputs.images = [{ data, mimeType }]`: stock images upload
// as-is; video refs (project clips, library media, generated stills) upload a
// single captured frame — the browser reads the same media URLs the previews
// use. Responses calls (prompt composition, chat) read content parts, where
// text refs contribute their contents.

export interface InlineImage {
  /** Base64 payload, no data: prefix. */
  data: string;
  mimeType: string;
}

const MAX_W = 1280;
const JPEG_Q = 0.85;

// Every picture riding to a hosted model is fitted to this budget first — a
// generated reference sheet comes back at the image model's full output size, and
// a handful of those is more than one model call should carry. Getting the bytes
// to the model is storage's job (hostedBlobs.ts), so this budget is about what
// the model reads: it resamples inputs to roughly this size anyway, so nothing
// it sees is lost.
const MAX_INLINE_EDGE = 2048;
const MAX_INLINE_BYTES = 4 * 1024 * 1024;

// Vertex image models accept only real image mime types. Read the format from the
// bytes rather than the transport Content-Type: a media file served as
// application/octet-stream (or with none) otherwise reaches the model labelled with a
// mimeType it rejects with INVALID_ARGUMENT.
function sniffImageMime(base64: string): string | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 24));
  } catch {
    return null;
  }
  const at = (i: number) => head.charCodeAt(i);
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  )
    return "image/webp";
  return null;
}

function splitDataUrl(dataUrl: string): InlineImage {
  const comma = dataUrl.indexOf(",");
  // Between "data:" and the first ";" (or "," when there are no params).
  const labelled = dataUrl.slice(5, comma).split(";")[0];
  const data = dataUrl.slice(comma + 1);
  // Trust the bytes over the label: a data URL may be typeless ("data:;base64,…") or
  // carry a non-image type (application/octet-stream from a media URL). Sniff the real
  // format, keeping a valid image/* label, and fall back to png only when unknown.
  const mimeType =
    (labelled.startsWith("image/") ? labelled : null) ?? sniffImageMime(data) ?? "image/png";
  return { data, mimeType };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked so a large picture doesn't blow the argument limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

/** Re-encode a picture down into the inline budget: scaled to the edge cap,
 * then stepped down until it fits. Null when the browser can't decode it — the
 * caller keeps the original bytes rather than dropping the reference. */
async function encodeWithin(blob: Blob): Promise<InlineImage | null> {
  const bitmap = await createImageBitmap(blob).catch(() => null);
  if (!bitmap) return null;
  try {
    let edge = MAX_INLINE_EDGE;
    let out: InlineImage | null = null;
    for (const quality of [JPEG_Q, 0.7, 0.55]) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = createRasterCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale))
      );
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (!ctx) return null;
      ctx.imageSmoothingQuality = "high";
      // JPEG carries no alpha, so a cut-out sheet composites onto white here
      // instead of the canvas's transparent black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      out = splitDataUrl(await rasterCanvasToDataUrl(canvas, "image/jpeg", quality));
      if (out.data.length * 0.75 <= MAX_INLINE_BYTES) return out;
      edge = Math.round(edge * 0.75);
    }
    return out;
  } finally {
    bitmap.close();
  }
}

/** A blob's bytes as an inline image part, fitted to the inline budget, mime
 * read from the bytes. */
export async function blobToInline(blob: Blob): Promise<InlineImage> {
  if (blob.size > MAX_INLINE_BYTES) {
    const fitted = await encodeWithin(blob);
    if (fitted) return fitted;
  }
  return splitDataUrl(await blobToDataUrl(blob));
}

/** A media blob's bytes as an inline audio part, mime from the blob's own type
 * (the engine's extractor hands back audio/aac). Null when it clears the inline
 * cap — a longer stretch than the model can take at once. */
export async function blobToInlineAudio(blob: Blob): Promise<InlineImage | null> {
  if (blob.size > MAX_AUDIO_BYTES) return null;
  const dataUrl = await blobToDataUrl(blob);
  const comma = dataUrl.indexOf(",");
  const labelled = dataUrl.slice(5, comma).split(";")[0];
  return {
    data: dataUrl.slice(comma + 1),
    mimeType: labelled.startsWith("audio/") ? labelled : "audio/aac",
  };
}

/** Video models take input images only as JPEG or PNG — the render rejects anything
 * else by format, killing the render after it was billed. Re-encode any other
 * picture (webp saved off the web is the common case) to JPEG; jpeg and png
 * pass through untouched. */
export async function videoSafeInline(img: InlineImage): Promise<InlineImage> {
  if (img.mimeType === "image/jpeg" || img.mimeType === "image/png") return img;
  const blob = await (await fetch(`data:${img.mimeType};base64,${img.data}`)).blob();
  const fitted = await encodeWithin(blob);
  if (!fitted) throw new Error("A reference image is in a format the video model can't read.");
  return fitted;
}

// Keeps the inline payload well under the Gemini per-request inline-data cap
// (base64 inflates by 4/3); larger audio degrades to a name-only marker.
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

/** A ref's bytes, naming what failed and where when they don't arrive. A bare
 * fetch rejection is the string "Failed to fetch" and nothing else — no asset,
 * no address — and the failures that reach here are exactly the ones that need
 * both: a URL built against the wrong backend, a cross-origin hop that answers
 * without CORS, an object that was never written. Which host and path was asked
 * for tells them apart. */
async function readRefBytes(ref: AssetRef): Promise<Blob> {
  const where = mediaAddress(ref.url);
  let res: Response;
  try {
    res = await fetch(ref.url);
  } catch (err) {
    // A rejected fetch never reached a server: DNS, CORS, mixed content, or a
    // refused connection.
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach “${ref.name}” at ${where} — ${why}.`);
  }
  if (!res.ok) throw new Error(`Could not load “${ref.name}” — ${res.status} from ${where}.`);
  return res.blob();
}

/** The audio bytes for `ref`, base64 with a real audio mime, or null when the
 * file is too large to ride inline. */
export async function refToInlineAudio(ref: AssetRef): Promise<InlineImage | null> {
  const blob = await readRefBytes(ref);
  if (blob.size > MAX_AUDIO_BYTES) return null;
  const dataUrl = await blobToDataUrl(blob);
  const comma = dataUrl.indexOf(",");
  const labelled = dataUrl.slice(5, comma).split(";")[0];
  return {
    data: dataUrl.slice(comma + 1),
    mimeType: labelled.startsWith("audio/") ? labelled : "audio/mpeg",
  };
}

/** A media URL as much of itself as may be repeated. Origin and path are what
 * identify a failure; the query string is not, and on cloud media it holds the
 * signed token that grants read access to the object — these messages reach the
 * chat transcript, which is persisted and readable by anyone a project's chat is
 * shared with. */
export function mediaAddress(url: string): string {
  try {
    const u = new URL(url, window.location.origin);
    return u.protocol === "data:" ? "an inline attachment" : `${u.origin}${u.pathname}`;
  } catch {
    return "an unreadable address";
  }
}

async function captureFrame(
  url: string,
  duration?: number,
  opts?: { at?: number; width?: number }
): Promise<InlineImage> {
  const input = openMedia(url);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new Error(`Could not read ${mediaAddress(url)} for a reference frame.`);
    const dur = duration || (await input.computeDuration()) || 2;
    // A pinned moment reads exactly there (kept inside the source); otherwise
    // the same poster spot the cards show, so the reference matches the preview.
    const at =
      opts?.at !== undefined
        ? Math.min(Math.max(0, opts.at), Math.max(0, dur - 0.05))
        : Math.min(1, Math.max(0.1, dur / 10));
    const width = Math.min(opts?.width ?? MAX_W, await track.getDisplayWidth());
    const frame = await frameSink(track, { width }).getCanvas(at);
    if (!frame) throw new Error("The video has no readable frame.");
    const canvas = frame.canvas;
    return splitDataUrl(
      canvas instanceof OffscreenCanvas
        ? await blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_Q }))
        : canvas.toDataURL("image/jpeg", JPEG_Q)
    );
  } finally {
    input.dispose();
  }
}

/** The length of the SOURCE behind a ref, as far as the ref knows it. A clip
 * ref's `duration` is the clip's own length, not its source file's — times on
 * a clip ref (its `t` pin) are source seconds, so the capture must probe the
 * real source length instead. */
const sourceDuration = (ref: AssetRef): number | undefined =>
  ref.scope === "clip" ? undefined : ref.duration;

/** A single reference image for `ref`: the file itself for images, a captured
 * frame for videos — the pinned moment when the user chose one, the poster
 * spot otherwise. Audio and text have no picture and reject. */
export async function refToInlineImage(ref: AssetRef): Promise<InlineImage> {
  if (ref.kind === "audio" || ref.kind === "text") {
    throw new Error(`“${ref.name}” has no picture — it can't be a visual reference.`);
  }
  if (ref.kind === "image") return blobToInline(await readRefBytes(ref));
  return captureFrame(ref.url, sourceDuration(ref), ref.t !== undefined ? { at: ref.t } : undefined);
}

/**
 * Put the picture a ref points at on the system clipboard, as a PNG so it
 * pastes into anything that takes an image.
 *
 * The blob goes in as a promise rather than an awaited value: Safari ties a
 * clipboard write to the gesture that asked for it, and decoding a frame first
 * spends that gesture. Throws when the frame cannot be read or the browser
 * refuses the write, which is the caller's cue to say so.
 */
export async function copyRefImage(ref: AssetRef): Promise<void> {
  const png = (async () => {
    const inline = await refToInlineImage(ref);
    const bytes = Uint8Array.from(atob(inline.data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: inline.mimeType });
    if (inline.mimeType === "image/png") return blob;
    // Clipboard image writes are PNG everywhere; a JPEG frame re-encodes.
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the frame."))), "image/png")
    );
  })();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/** Reference images for a whole ref list, in order; skips nothing — a broken
 * ref fails the call so the user knows the reference didn't ride along. */
export function refsToInlineImages(refs: AssetRef[]): Promise<InlineImage[]> {
  return Promise.all(refs.map(refToInlineImage));
}

/** The refs that can ride to a visual model as input images. */
export const visualRefs = (refs: AssetRef[]): AssetRef[] =>
  refs.filter((r) => r.kind === "image" || r.kind === "video");

/** Attach OS files dropped on a composer, returned as refs in drop order.
 * Media files import into the project first; text files become transient file
 * refs read at send time. Files that are neither, and failed imports, are
 * skipped. `chatId` marks the imports chat-owned from creation: they live on
 * the chat (its card, thread deletion), never in the Media panel — a drop on
 * the chat composer is an attachment, not a filing. Panel drops omit it and
 * file into Media as user imports.
 *
 * A cloud drop shows its chip the moment the local bytes are probed: the ref
 * plays from the file's own object URL while the upload queue sends the bytes
 * behind the composer, and the asset swaps to its stored URL when they land
 * (chips and the send paths read the live URL from the asset). The engine
 * takes a file's bytes in one quick local call, so its imports go straight
 * through. */
export async function refsFromDroppedFiles(
  projectId: string,
  files: File[],
  opts?: { chatId?: string }
): Promise<AssetRef[]> {
  const refs: AssetRef[] = [];
  for (const file of files) {
    try {
      if (isTextFile(file) && !isMediaFile(file)) {
        refs.push(await refFromTextFile(file));
        continue;
      }
      const pending = await prepareImport(projectId, file);
      const asset = pending?.asset ?? (await importFileToProject(projectId, file));
      if (!asset) continue;
      useEditor.getState().addAsset(asset);
      if (opts?.chatId) tagChatAsset(asset.id, opts.chatId);
      // A pending import still holds its bytes — enrich from those.
      void enrichAsset(asset, pending?.localUrl);
      if (pending) startUpload(projectId, pending);
      refs.push(refFromAsset(asset));
    } catch (err) {
      console.error(`Attach failed for ${file.name}:`, err);
    }
  }
  return refs;
}

/** A text ref's contents (a dropped script, notes, subtitles…). */
export async function readRefText(ref: AssetRef): Promise<string> {
  const res = await fetch(ref.url);
  if (!res.ok) throw new Error(`Could not read “${ref.name}”.`);
  return res.text();
}

// A pinned video moment also samples a frame this far to each side, so the
// pick lands even when the user's scrub was a beat off the exact frame.
const PIN_SAMPLE_SPREAD = 1;
const PIN_SAMPLE_W = 640;
// A pinned audio moment reads as a segment reaching this far back and forward
// — enough lead-in to place the moment and enough tail to hear the passage.
const PIN_AUDIO_BACK = 5;
const PIN_AUDIO_FORWARD = 25;

/** The audio around a pinned moment as an inline part, rendered in the
 * browser from the source URL. Null when the span can't be read (no audio
 * track, an unreadable source) — the caller falls back to the whole file. */
async function pinnedAudioSegment(
  ref: AssetRef,
  t: number
): Promise<{ audio: InlineImage; from: number; to: number } | null> {
  const dur = sourceDuration(ref);
  const from = Math.max(0, t - PIN_AUDIO_BACK);
  const to = dur !== undefined ? Math.min(dur, t + PIN_AUDIO_FORWARD) : t + PIN_AUDIO_FORWARD;
  if (to <= from) return null;
  try {
    const audio = await blobToInlineAudio(await renderAudioSpanWav(ref.url, from, to));
    return audio ? { audio, from, to } : null;
  } catch {
    return null;
  }
}

/** A ref list as hosted-Responses content parts, for any Gemini call that
 * should actually see the attachments: each visual ref contributes a numbered
 * label plus its picture (image as-is, video by poster frame), each text ref
 * its contents, and each audio ref its actual sound (so the model can answer
 * about what's said without touching the project; oversized files fall back
 * to a name-only marker). A ref with a pinned moment (`t`) reads from there
 * instead: a video contributes the pinned frame plus a sampled frame each
 * side, an audio ref the segment around the moment. `visuals` returns the
 * pictures in label order (`Image 1` = visuals[0]) so a model can pick among
 * them. */
export async function refsToParts(
  refs: AssetRef[]
): Promise<{ parts: Record<string, unknown>[]; visuals: InlineImage[] }> {
  const parts: Record<string, unknown>[] = [];
  const visuals: InlineImage[] = [];
  const pushImage = (image: InlineImage, label: string) => {
    visuals.push(image);
    parts.push({ text: `Image ${visuals.length} — ${label}` });
    parts.push({ type: "input_image", dataBase64: image.data, mimeType: image.mimeType });
  };
  for (const ref of refs) {
    if (ref.kind === "audio") {
      const segment = ref.t !== undefined ? await pinnedAudioSegment(ref, ref.t) : null;
      const audio = segment?.audio ?? (await refToInlineAudio(ref));
      if (!audio) {
        parts.push({ text: `Attached audio "${ref.name}" (too large to include inline).` });
        continue;
      }
      parts.push({
        text: segment
          ? `Attached audio "${ref.name}" — the segment around the user's pinned moment ${formatTime(ref.t!)} (${formatTime(segment.from)}–${formatTime(segment.to)}):`
          : `Attached audio "${ref.name}":`,
      });
      parts.push({ type: "input_audio", dataBase64: audio.data, mimeType: audio.mimeType });
      continue;
    }
    if (ref.kind === "text") {
      parts.push({
        text:
          ref.scope === "entity"
            ? `Referenced timeline entity "${ref.name}":\n${await readRefText(ref)}`
            : `Attached file "${ref.name}":\n${await readRefText(ref)}`,
      });
      continue;
    }
    if (ref.kind === "video" && ref.t !== undefined) {
      const t = ref.t;
      const dur = sourceDuration(ref);
      pushImage(
        await refToInlineImage(ref),
        `the frame the user pinned, ${formatTime(t)} into video "${ref.name}":`
      );
      for (const dt of [-PIN_SAMPLE_SPREAD, PIN_SAMPLE_SPREAD]) {
        const at = Math.max(0, dur !== undefined ? Math.min(t + dt, dur) : t + dt);
        // A neighbor clamped onto the pin itself adds nothing.
        if (Math.abs(at - t) < 0.25) continue;
        const image = await captureFrame(ref.url, dur, { at, width: PIN_SAMPLE_W }).catch(
          () => null
        );
        if (!image) continue;
        pushImage(image, `the same video ${formatTime(at)}, sampled near the pinned frame:`);
      }
      continue;
    }
    pushImage(
      await refToInlineImage(ref),
      ref.kind === "video" ? `a frame of video "${ref.name}":` : `image "${ref.name}":`
    );
  }
  return { parts, visuals };
}
