"use client";

/**
 * The quality matte bake: the clip's trimmed segment goes to the hosted
 * matting service (credits) and the returned mask video is refined here
 * against the source pixels with the kit's guided filter and encoded as the
 * final matte asset. One model per job: auto mode sends the segment to the
 * background-removal model, which masks the foreground subject on its own;
 * custom mode sends it to the promptable tracker, seeded by the described
 * subject and the brush's stored prompts and paint. Driven by the page or
 * the cloud worker — the local engine only ever consumes the stored matte.
 *
 * A long clip tracks in parts: the span splits into pieces of at most
 * `MATTE_MAX_S`, each rendered, uploaded, and tracked on its own upload
 * budget, and every piece encodes into the one matte. A painted selection
 * crosses the seam by handoff — the last mask frame of one part seeds point
 * prompts for the next. Each part's submit is its own billable moment, and
 * the persisted ticket carries every submitted part and the exact span it
 * was built for, so a reload resumes the run without paying for finished
 * pieces again; a part whose track settles dead is forgotten alone, and a
 * retry re-buys just that piece.
 */

import {
  coverageToGray,
  MATTE_BITRATE,
  MATTE_FPS,
  MATTE_MAX_S,
  MATTE_SHORT,
  refineMatteAgainstFrame,
} from "@donkeycut/effects-kit";
import { openCanvasVideo, scaledEvenSize, type CanvasVideoEncoder } from "../canvasVideo";
import { NO_CREDITS_MESSAGE } from "../credits";
import { ClipReader } from "../exportRender";
import { hostedPost } from "../hosted";
import { storeHostedBlob } from "../hostedBlobs";
import { falMatteModels } from "@/lib/inference/matte-models";
import { createRasterCanvas, decodeRasterImageUrl, type RasterSurface } from "../raster";
import type { MediaAsset, RemovalSeeds, VideoClip } from "../types";
import { liveReader } from "../liveReader";
import { MatteBakeCancelled } from "./localBake";

/** Segment sent to the tracker: capped resolution and rate — the mask comes
 * back at the same shape, and tracking cost scales with both. The bitrate
 * also shrinks with length so each part stays under the upload route's 32MB
 * blob cap. */
const SEGMENT_SHORT = 720;
const SEGMENT_BITRATE = 2_500_000;
const SEGMENT_BYTE_BUDGET = 30 * 1024 * 1024;
const POLL_MS = 5_000;
const DEADLINE_MS = 10 * 60_000;
/** The most handoff points sampled from a part's final mask. */
const CARRY_POINTS_MAX = 6;

/** The hosted tier answered 402: credits unlock it, the local matte stands.
 * Carries the app-wide balance message so every surface renders it the same
 * way, with the credits link. */
export class MatteNeedsCredits extends Error {
  constructor() {
    super(NO_CREDITS_MESSAGE);
  }
}

/** The tracker settled a generation as failed — the charge is spent and the
 * track is dead. The run forgets the dead part in the ticket it reports, so
 * a retry re-buys that piece alone and resumes the rest. Transient errors
 * (a poll that couldn't reach the route) throw plain errors instead, and
 * the whole ticket stands for a resume. */
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

/** Encode one span of the clip's source as a compact video-only segment.
 * The segment's own clock starts at zero — the tracker sees a standalone
 * video — and `from` records where it sits in source time. The reader is the
 * run's shared one; the caller owns its lifetime. */
async function renderSegment(
  reader: ClipReader,
  still: boolean,
  from: number,
  to: number,
  frames: number,
  signal: AbortSignal | undefined,
  onProgress?: (fraction: number) => void
): Promise<{ blob: Blob; from: number; w: number; h: number; frames: number }> {
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
  try {
    for (let i = 0; i < frames; i++) {
      checkAborted(signal);
      const at = still ? 0 : Math.min(to - 1 / (MATTE_FPS * 2), from + i / MATTE_FPS);
      const frame = await reader.frameAt(at);
      enc.ctx.fillStyle = "#000000";
      enc.ctx.fillRect(0, 0, w, h);
      if (frame.kind === "ready") enc.ctx.drawImage(frame.image, 0, 0, w, h);
      await enc.add(i / MATTE_FPS, 1 / MATTE_FPS);
      onProgress?.((i + 1) / frames);
    }
    return { blob: await enc.finish(), from, w, h, frames };
  } catch (e) {
    await enc.cancel();
    throw e;
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
 * A seed outside this part's span points at a frame the segment doesn't
 * hold — clamped it would prompt on a different moment of the shot, so it
 * is dropped instead (a seed in another part lands with that part). */
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

/** Handoff seeds for the next part: positive points sampled from the mask's
 * white regions, as frame fractions — a coarse grid keeps them spread over
 * every kept area. They all seed the one carried selection, so the tracker
 * follows it as a single object however many cells it lights. */
function carryPoints(px: Uint8ClampedArray, w: number, h: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const cols = 3;
  const rows = 2;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sx = 0;
      let sy = 0;
      let count = 0;
      const x0 = Math.floor((cx * w) / cols);
      const x1 = Math.floor(((cx + 1) * w) / cols);
      const y0 = Math.floor((cy * h) / rows);
      const y1 = Math.floor(((cy + 1) * h) / rows);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (px[(y * w + x) * 4] > 160) {
            sx += x;
            sy += y;
            count++;
          }
        }
      }
      // The cell's centroid can land on background between two kept areas of
      // the same cell; dense sampling is not worth the prompt noise, so a
      // cell contributes only when it is meaningfully lit.
      if (count > 24 && out.length < CARRY_POINTS_MAX) {
        out.push({ x: sx / count / w, y: sy / count / h });
      }
    }
  }
  return out;
}

/** What a reload needs to re-attach to a paid in-flight run: every part's
 * poll payload, in order (a dead track's slot holds null), how many parts
 * the whole run has, and the source span the parts were cut from. */
export interface HostedBakeTicket {
  parts: (Generation | null)[];
  total: number;
  from: number;
  to: number;
}

/** Read a persisted ticket. The parts were tracked for one exact source
 * span, so a ticket whose span or split no longer matches the clip's (a
 * retrim moved the trims under the same fingerprint) is unusable and
 * dropped; so is a record from before the span was stamped. */
function ticketParts(
  v: HostedBakeTicket | undefined,
  total: number,
  from: number,
  to: number
): (Generation | null)[] {
  if (!v || !("parts" in v) || !Array.isArray(v.parts)) return [];
  const holds =
    v.total === total &&
    typeof v.from === "number" &&
    typeof v.to === "number" &&
    Math.abs(v.from - from) < 0.001 &&
    Math.abs(v.to - to) < 0.001;
  return holds ? v.parts : [];
}

/** Poll one part's track to completion and hand back its mask URL. */
async function pollTrack(
  start: Generation,
  opts: { signal?: AbortSignal },
  onFrac: (f: number) => void
): Promise<string> {
  let gen = start;
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
    onFrac(Math.min(1, 1 - (deadline - Date.now()) / DEADLINE_MS));
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
  return maskUrl;
}

/** The one encoder the whole matte writes through, opened on the first
 * part's mask, plus the scratch the refine pass reuses. */
interface MatteSink {
  enc: CanvasVideoEncoder;
  w: number;
  h: number;
  guide: RasterSurface;
  gctx: CanvasRenderingContext2D;
  lit: boolean;
}

/**
 * Refine one part's tracked mask against the source pixels and append its
 * frames to the shared matte. Returns the part's final mask pixels for the
 * next part's handoff.
 */
async function refinePart(
  sink: { current: MatteSink | null },
  srcReader: ClipReader,
  still: boolean,
  maskUrl: string,
  span: { from: number; to: number; frames: number; offset: number },
  totalFrames: number,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
): Promise<ImageData | null> {
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
  try {
    const firstMask = await maskReader.frameAt(0);
    if (firstMask.kind !== "ready") throw new Error("The tracked mask could not be read.");
    let s = sink.current;
    if (!s) {
      const { w, h } = scaledEvenSize(firstMask.width, firstMask.height, MATTE_SHORT);
      const enc = await openCanvasVideo({
        width: w,
        height: h,
        fps: MATTE_FPS,
        frames: totalFrames,
        bitrate: MATTE_BITRATE,
        readback: true,
      });
      const guide = createRasterCanvas(w, h);
      const gctx = guide.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      s = { enc, w, h, guide, gctx, lit: false };
      sink.current = s;
    }
    const ctx = s.enc.ctx;
    let last: ImageData | null = null;

    for (let i = 0; i < span.frames; i++) {
      checkAborted(opts.signal);
      const t = i / MATTE_FPS;
      const mask = await maskReader.frameAt(Math.min(t, (span.frames - 0.5) / MATTE_FPS));
      const src = await srcReader.frameAt(
        still ? 0 : Math.min(span.to - 1 / (MATTE_FPS * 2), span.from + t)
      );
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, s.w, s.h);
      if (mask.kind === "ready") {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(mask.image, 0, 0, s.w, s.h);
        const mattePx = ctx.getImageData(0, 0, s.w, s.h);
        coverageToGray(mattePx.data);
        // A track that detected nothing comes back as an all-black mask
        // video; an empty matte would make the clip vanish, so the whole
        // bake fails instead once every part has drawn.
        if (!s.lit) {
          const px = mattePx.data;
          for (let p = 0; p < px.length; p += 4) {
            if (px[p] > 32) {
              s.lit = true;
              break;
            }
          }
        }
        // The handoff reads the part's last frame that decoded; a mask
        // video's very final frame is allowed to come back pending without
        // costing the seam its seeds.
        last = mattePx;
        if (src.kind === "ready") {
          s.gctx.drawImage(src.image, 0, 0, s.w, s.h);
          const framePx = s.gctx.getImageData(0, 0, s.w, s.h);
          refineMatteAgainstFrame(mattePx.data, framePx.data, s.w, s.h, 6);
        }
        ctx.putImageData(mattePx, 0, 0);
      }
      await s.enc.add((span.offset + i) / MATTE_FPS, 1 / MATTE_FPS);
      opts.onProgress?.((i + 1) / span.frames);
    }
    return last;
  } finally {
    maskReader.dispose();
    if (localUrl) URL.revokeObjectURL(localUrl);
  }
}

/**
 * Run the hosted quality bake for a clip and return the refined matte, ready
 * to store as the project's matte asset. Throws `MatteNeedsCredits` on a 402,
 * `MatteTrackFailed` when the tracker settled a paid run as dead, and
 * `MatteBakeCancelled` on abort. Each part's submit bills, so the caller
 * persists the ticket handed to `onSubmitted` and passes it back as `resume`
 * after a reload — the run then re-attaches to every submitted part and pays
 * only for the ones it has not started.
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
  const to = still ? from + 1 / MATTE_FPS : Math.min(clip.out, asset.duration || clip.out);
  const totalFrames = still
    ? 1
    : Math.max(1, Math.ceil(Math.max(1 / MATTE_FPS, to - from) * MATTE_FPS));
  const maxFrames = Math.max(1, Math.round(MATTE_MAX_S * MATTE_FPS));
  const nParts = Math.max(1, Math.ceil(totalFrames / maxFrames));
  const perPart = Math.ceil(totalFrames / nParts);

  const custom = r.mode === "custom";
  const painted = custom && !!(r.seeds?.prompts.length || r.seeds?.paint?.length);
  const concept = custom ? (r.subject ?? "").trim() : "";
  const model = custom ? falMatteModels.segmenter : falMatteModels.removal;

  const gens = [...ticketParts(opts.resume, nParts, from, to)];
  const ticket = (upto: number): HostedBakeTicket => ({
    parts: gens.slice(0, upto).map((g) => g ?? null),
    total: nParts,
    from,
    to,
  });
  const sink: { current: MatteSink | null } = { current: null };
  const srcReader = liveReader(asset);
  let carry: { x: number; y: number }[] = [];

  try {
    for (let p = 0; p < nParts; p++) {
      const startFrame = p * perPart;
      const frames = Math.min(totalFrames, (p + 1) * perPart) - startFrame;
      const partFrom = from + startFrame / MATTE_FPS;
      const partTo = Math.min(to, from + (startFrame + frames) / MATTE_FPS);
      const frac = (f: number) => opts.onProgress?.((p + f) / nParts);

      let gen = gens[p];
      if (!gen) {
        frac(0.02);
        const segment = await renderSegment(srcReader, still, partFrom, partTo, frames, opts.signal, (f) =>
          frac(0.02 + f * 0.13)
        );
        // Custom mode's words and strokes ride together: a described subject
        // sends a text prompt, painted seeds send point prompts, and a
        // removal with both sends both — the segmenter's points refine what
        // the words detected. A painted part with no strokes of its own
        // takes the handoff points from the previous part's final mask, so
        // the picked selection crosses the seam. Auto mode sends the segment
        // alone — the removal model finds the subject itself.
        let points = painted ? await seedPoints(r.seeds!, segment, segment.from) : [];
        if (painted && points.length === 0 && carry.length > 0) {
          points = carry.map((c) => ({
            x: c.x * segment.w,
            y: c.y * segment.h,
            frame: 0,
            label: 1 as const,
            object: "carry",
          }));
        }
        if (custom && !concept && points.length === 0) {
          throw p === 0
            ? new Error("No selection to track.")
            : new MatteTrackFailed("The selection was lost at a part boundary.");
        }
        const parameters = {
          ...(concept ? { prompt: concept } : {}),
          ...(points.length > 0 ? { points } : {}),
        };
        checkAborted(opts.signal);

        const blobRef = await storeHostedBlob(segment.blob, "donkey-cut");
        if (!blobRef) throw new Error("The segment could not reach storage.");
        frac(0.2);

        const submit = await hostedPost("/api/inference/assets", {
          kind: "matte",
          model,
          prompt: custom
            ? "Track the selected subject through the clip."
            : "Remove the clip's background.",
          inputs: { video: { blobRef, blobField: "url", blobUrl: true, mimeType: "video/mp4" } },
          parameters,
        });
        if (submit.status === 402) throw new MatteNeedsCredits();
        if (!submit.ok) throw new Error("The quality cutout could not start.");
        gen = (await submit.json()) as Generation;
        gens[p] = gen;
        // The submit is the billable moment: from here the ticket outlives the
        // page, so a reload resumes this run's submitted parts instead of
        // paying for them again.
        opts.onSubmitted?.(ticket(p + 1));
      } else {
        frac(0.2);
      }

      let maskUrl: string;
      try {
        maskUrl = await pollTrack(gen, opts, (f) => frac(0.2 + f * 0.5));
      } catch (e) {
        // A dead track spends only its own part: the ticket forgets this
        // generation and keeps every other submitted one, so a retry re-buys
        // just this piece.
        if (e instanceof MatteTrackFailed && gens[p]) {
          gens[p] = null;
          opts.onSubmitted?.(ticket(Math.max(p + 1, gens.length)));
        }
        throw e;
      }
      checkAborted(opts.signal);
      const last = await refinePart(
        sink,
        srcReader,
        still,
        maskUrl,
        { from: partFrom, to: partTo, frames, offset: startFrame },
        totalFrames,
        { ...opts, onProgress: (f) => frac(0.72 + f * 0.28) }
      );
      carry = last ? carryPoints(last.data, last.width, last.height) : [];
    }

    const s = sink.current;
    if (!s) throw new MatteTrackFailed("The tracker returned no mask.");
    if (!s.lit) {
      throw new MatteTrackFailed(
        "The tracker found nothing to keep — describe the subject or paint it."
      );
    }
    return { blob: await s.enc.finish(), in: from };
  } catch (e) {
    // Whatever escaped, the matte encoder must not outlive the run — the
    // browser's hardware encoder pool is finite, and a leaked one starves
    // every bake after it. Cancel is idempotent.
    await sink.current?.enc.cancel();
    throw e;
  } finally {
    srcReader.dispose();
  }
}
