"use client";

/**
 * The quality matte bake: the clip's trimmed segment goes to the hosted
 * tracker (credits), which propagates the subject across every frame; the
 * returned mask video is refined here against the source pixels with the
 * kit's guided filter and encoded as the final matte asset. Auto mode seeds
 * the tracker from the on-device person matte; custom mode seeds it from the
 * brush's stored prompts and paint. Driven by the page or the cloud worker —
 * the local engine only ever consumes the stored matte.
 */

import {
  coverageToGray,
  MATTE_BITRATE,
  MATTE_FPS,
  MATTE_SHORT,
  refineMatteAgainstFrame,
} from "@donkeycut/effects-kit";
import { openCanvasVideo, scaledEvenSize } from "../canvasVideo";
import { NO_CREDITS_MESSAGE } from "../credits";
import { ClipReader } from "../exportRender";
import { hostedPost } from "../hosted";
import { storeHostedBlob } from "../hostedBlobs";
import { createRasterCanvas, decodeRasterImageUrl } from "../raster";
import type { MediaAsset, RemovalSeeds, VideoClip } from "../types";
import { localBakeMatte, MatteBakeCancelled } from "./localBake";

/** Segment sent to the tracker: capped resolution and rate — the mask comes
 * back at the same shape, and tracking cost scales with both. The bitrate
 * also shrinks with length so the whole segment stays under the upload
 * route's 32MB blob cap: a long clip trades bitrate for admission. */
const SEGMENT_SHORT = 720;
const SEGMENT_BITRATE = 2_500_000;
const SEGMENT_BYTE_BUDGET = 30 * 1024 * 1024;
const POLL_MS = 5_000;
const DEADLINE_MS = 10 * 60_000;

/** The hosted tier answered 402: credits unlock it, the local matte stands.
 * Carries the app-wide balance message so every surface renders it the same
 * way, with the credits link. */
export class MatteNeedsCredits extends Error {
  constructor() {
    super(NO_CREDITS_MESSAGE);
  }
}

/** The tracker settled this generation as failed — the charge is spent and
 * the track is dead, so the caller drops its persisted ticket and a retry
 * submits fresh. Transient errors (a poll that couldn't reach the route)
 * throw plain errors instead, and the ticket stands for a resume. */
export class MatteTrackFailed extends Error {}

type Point = { x: number; y: number; frame: number; label: 0 | 1; object: string };

interface Generation {
  id: string;
  status: string;
  provider: string;
  model: string;
  providerJobId?: string | null;
  providerGenerationId?: string | null;
  providerPollingUrl?: string | null;
  metadata?: Record<string, unknown>;
  outputs: { url?: string; dataBase64?: string; contentType?: string }[];
  error?: unknown;
}

function checkAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new MatteBakeCancelled();
}

/** Encode the clip's trimmed source range as a compact video-only segment. */
async function renderSegment(
  asset: MediaAsset,
  clip: VideoClip,
  signal: AbortSignal | undefined
): Promise<{ blob: Blob; from: number; w: number; h: number; frames: number }> {
  const still = asset.type === "image";
  const from = still ? 0 : Math.max(0, clip.in);
  const to = still ? from + 1 / MATTE_FPS : Math.min(clip.out, asset.duration || clip.out);
  const frames = still ? 1 : Math.max(1, Math.ceil(Math.max(1 / MATTE_FPS, to - from) * MATTE_FPS));
  const reader = new ClipReader(asset, () => asset.url);
  try {
    const first = await reader.frameAt(from);
    if (first.kind !== "ready") throw new Error("The clip's picture could not be read.");
    const { w, h } = scaledEvenSize(first.width, first.height, SEGMENT_SHORT);
    const seconds = frames / MATTE_FPS;
    const enc = await openCanvasVideo({
      width: w,
      height: h,
      fps: MATTE_FPS,
      frames,
      bitrate: Math.min(SEGMENT_BITRATE, Math.floor((SEGMENT_BYTE_BUDGET * 8) / seconds)),
    });
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) {
        await enc.cancel();
        throw new MatteBakeCancelled();
      }
      const at = Math.min(to - 1 / (MATTE_FPS * 2), from + i / MATTE_FPS);
      const frame = await reader.frameAt(at);
      enc.ctx.fillStyle = "#000000";
      enc.ctx.fillRect(0, 0, w, h);
      if (frame.kind === "ready") enc.ctx.drawImage(frame.image, 0, 0, w, h);
      await enc.add(i / MATTE_FPS, 1 / MATTE_FPS);
    }
    return { blob: await enc.finish(), from, w, h, frames };
  } finally {
    reader.dispose();
  }
}

/** Centroid of the white pixels in an alpha or luma image, as fractions;
 * null when nothing is marked. */
function centroidOf(px: Uint8ClampedArray, w: number, h: number, channel: 0 | 3): { x: number; y: number } | null {
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + channel] > 160) {
        sx += x;
        sy += y;
        count++;
      }
    }
  }
  // A handful of lit pixels is a real mark — the smallest brush dab covers
  // ~20px² at the paint bitmap's 256px short side.
  if (count < 4) return null;
  return { x: sx / count / w, y: sy / count / h };
}

/** Custom mode's tracker seeds, from the brush's stored prompts and paint.
 * A seed the trims moved past points at a frame the segment doesn't hold —
 * clamped it would prompt on a different moment of the shot, so it is
 * dropped instead. */
async function seedPoints(
  seeds: RemovalSeeds,
  seg: { w: number; h: number; frames: number },
  from: number
): Promise<Point[]> {
  const frameOf = (t: number): number | null => {
    const frame = Math.round((t - from) * MATTE_FPS);
    return frame >= 0 && frame < seg.frames ? frame : null;
  };
  const out: Point[] = [];
  seeds.prompts.forEach((p, i) => {
    const frame = frameOf(p.t);
    if (frame === null) return;
    const keeps = p.points.some((pt) => pt.label === 1);
    for (const pt of p.points) {
      out.push({
        x: pt.x * seg.w,
        y: pt.y * seg.h,
        frame,
        label: pt.label,
        // A refine-only stroke (all background points) attaches to the first
        // tracked object; a keep stroke tracks its own object.
        object: keeps ? `obj${i}` : "obj0",
      });
    }
  });
  for (const p of seeds.paint ?? []) {
    const frame = frameOf(p.t);
    if (frame === null) continue;
    for (const [url, label] of [
      [p.add, 1],
      [p.erase, 0],
    ] as const) {
      if (!url) continue;
      const img = await decodeRasterImageUrl(url).catch(() => null);
      if (!img) continue;
      const c = createRasterCanvas(img.width, img.height);
      const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      ctx.drawImage(img.source, 0, 0);
      const px = ctx.getImageData(0, 0, img.width, img.height).data;
      const point = centroidOf(px, img.width, img.height, 0);
      if (point) {
        out.push({ x: point.x * seg.w, y: point.y * seg.h, frame, label, object: "paint" });
      }
    }
  }
  return out;
}

/** What a reload needs to re-attach to a paid in-flight track: the
 * generation's poll payload, as the submit returned it. */
export type HostedBakeTicket = Generation;

/**
 * Run the hosted quality bake for a clip and return the refined matte, ready
 * to store as the project's matte asset. Throws `MatteNeedsCredits` on a 402,
 * `MatteTrackFailed` when the tracker settled the paid run as dead, and
 * `MatteBakeCancelled` on abort. The submit bills, so the caller persists the
 * ticket handed to `onSubmitted` and passes it back as `resume` after a
 * reload — the bake then re-attaches to the running track and pays nothing
 * new.
 */
export async function hostedBakeMatte(
  asset: MediaAsset,
  clip: VideoClip,
  opts: {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
    resume?: HostedBakeTicket;
    onSubmitted?: (ticket: HostedBakeTicket) => void;
  } = {}
): Promise<{ blob: Blob; in: number }> {
  const r = clip.removal;
  if (!r) throw new Error("The clip has no removal to bake.");
  const still = asset.type === "image";
  const from = still ? 0 : Math.max(0, clip.in);
  let gen: Generation;
  if (opts.resume) {
    gen = opts.resume;
    opts.onProgress?.(0.2);
  } else {
    opts.onProgress?.(0.02);
    const segment = await renderSegment(asset, clip, opts.signal);
    opts.onProgress?.(0.15);
    // The words and the strokes ride together: auto mode and a described
    // subject send a text prompt, painted seeds send point prompts, and a
    // custom removal with both sends both — the segmenter's points refine what
    // the words detected. The route picks the configured segmenter.
    const painted =
      r.mode === "custom" && !!(r.seeds?.prompts.length || r.seeds?.paint?.length);
    const concept = r.mode === "custom" ? (r.subject ?? "").trim() : "person";
    const points = painted ? await seedPoints(r.seeds!, segment, segment.from) : [];
    if (!concept && points.length === 0) throw new Error("No selection to track.");
    const parameters = {
      ...(concept ? { prompt: concept } : {}),
      ...(points.length > 0 ? { points } : {}),
    };
    checkAborted(opts.signal);

    const blobRef = await storeHostedBlob(segment.blob, "donkey-cut");
    if (!blobRef) throw new Error("The segment could not reach storage.");
    opts.onProgress?.(0.2);

    const submit = await hostedPost("/api/inference/assets", {
      kind: "matte",
      prompt: "Track the selected subject through the clip.",
      inputs: { video: { blobRef, blobField: "url", blobUrl: true, mimeType: "video/mp4" } },
      parameters,
    });
    if (submit.status === 402) throw new MatteNeedsCredits();
    if (!submit.ok) throw new Error("The quality cutout could not start.");
    gen = (await submit.json()) as Generation;
    // The submit is the billable moment: from here the ticket outlives the
    // page, so a reload resumes this track instead of paying for another.
    opts.onSubmitted?.(gen);
  }

  const deadline = Date.now() + DEADLINE_MS;
  while (gen.status === "in_progress" || gen.status === "pending") {
    checkAborted(opts.signal);
    if (Date.now() > deadline) throw new Error("The quality cutout is taking too long.");
    await new Promise((r2) => setTimeout(r2, POLL_MS));
    checkAborted(opts.signal);
    const poll = await hostedPost("/api/inference/assets/refresh", {
      id: gen.id,
      kind: "matte",
      provider: gen.provider,
      model: gen.model,
      providerJobId: gen.providerJobId,
      providerGenerationId: gen.providerGenerationId,
      providerPollingUrl: gen.providerPollingUrl,
      metadata: gen.metadata ?? {},
    });
    if (!poll.ok) throw new Error("The quality cutout failed.");
    gen = (await poll.json()) as Generation;
    opts.onProgress?.(Math.min(0.7, 0.2 + (1 - (deadline - Date.now()) / DEADLINE_MS) * 2));
  }
  if (gen.status !== "completed") {
    const message =
      typeof (gen.error as { message?: string } | undefined)?.message === "string"
        ? (gen.error as { message: string }).message
        : "The quality cutout failed.";
    throw new MatteTrackFailed(message);
  }
  const maskUrl = gen.outputs.find((o) => o.url)?.url;
  if (!maskUrl) throw new MatteTrackFailed("The tracker returned no mask.");
  checkAborted(opts.signal);
  opts.onProgress?.(0.72);

  return refineAndEncode(asset, clip, maskUrl, from, opts);
}

/** Refine the tracker's mask against the source pixels and encode the final
 * grayscale matte. */
async function refineAndEncode(
  asset: MediaAsset,
  clip: VideoClip,
  maskUrl: string,
  from: number,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<{ blob: Blob; in: number }> {
  const still = asset.type === "image";
  const to = still ? from + 1 / MATTE_FPS : Math.min(clip.out, asset.duration || clip.out);
  const frames = still ? 1 : Math.max(1, Math.ceil(Math.max(1 / MATTE_FPS, to - from) * MATTE_FPS));
  // The browser reads the mask from a local blob: the whole file downloads
  // once, and the decoder never streams the provider's CDN. Headless runs
  // have no object URLs and read the URL directly.
  let localUrl: string | null = null;
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    const got = await fetch(maskUrl).catch(() => null);
    if (!got?.ok) throw new Error("The tracked mask could not be downloaded.");
    localUrl = URL.createObjectURL(await got.blob());
  }
  const readUrl = localUrl ?? maskUrl;
  const maskAsset: MediaAsset = {
    id: "hosted-mask",
    type: "video",
    url: readUrl,
    fileName: "hosted-mask.mp4",
    name: "hosted-mask",
  } as MediaAsset;
  const maskReader = new ClipReader(maskAsset, () => readUrl);
  const srcReader = new ClipReader(asset, () => asset.url);
  try {
    const firstMask = await maskReader.frameAt(0);
    if (firstMask.kind !== "ready") throw new Error("The tracked mask could not be read.");
    const { w, h } = scaledEvenSize(firstMask.width, firstMask.height, MATTE_SHORT);
    const enc = await openCanvasVideo({
      width: w,
      height: h,
      fps: MATTE_FPS,
      frames,
      bitrate: MATTE_BITRATE,
      readback: true,
    });
    const ctx = enc.ctx;
    const guide = createRasterCanvas(w, h);
    const gctx = guide.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    // A track that detected nothing comes back as an all-black mask video; an
    // empty matte would make the clip vanish, so it fails the bake instead.
    let lit = false;

    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) {
        await enc.cancel();
        throw new MatteBakeCancelled();
      }
      const t = i / MATTE_FPS;
      const mask = await maskReader.frameAt(Math.min(t, (frames - 0.5) / MATTE_FPS));
      const src = await srcReader.frameAt(still ? 0 : Math.min(to - 1 / (MATTE_FPS * 2), from + t));
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
      if (mask.kind === "ready") {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(mask.image, 0, 0, w, h);
        const mattePx = ctx.getImageData(0, 0, w, h);
        coverageToGray(mattePx.data);
        if (!lit) {
          const px = mattePx.data;
          for (let p = 0; p < px.length; p += 4) {
            if (px[p] > 32) {
              lit = true;
              break;
            }
          }
        }
        if (src.kind === "ready") {
          gctx.drawImage(src.image, 0, 0, w, h);
          const framePx = gctx.getImageData(0, 0, w, h);
          refineMatteAgainstFrame(mattePx.data, framePx.data, w, h, 6);
        }
        ctx.putImageData(mattePx, 0, 0);
      }
      await enc.add(t, 1 / MATTE_FPS);
      opts.onProgress?.(0.72 + ((i + 1) / frames) * 0.27);
    }
    if (!lit) {
      await enc.cancel();
      throw new MatteTrackFailed(
        "The tracker found nothing to keep — describe the subject or paint it."
      );
    }
    return { blob: await enc.finish(), in: from };
  } finally {
    maskReader.dispose();
    srcReader.dispose();
    if (localUrl) URL.revokeObjectURL(localUrl);
  }
}

// The local quick bake rides beside the hosted one so callers pick a rung
// without importing two modules.
export { localBakeMatte, MatteBakeCancelled };
