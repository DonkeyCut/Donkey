"use client";

/**
 * Sticker cutouts: turn a picture into a transparent-background sticker.
 *
 * Two matting paths share one shape. People run through MediaPipe's
 * self-hosted person segmenter — free, on-device, offline (the same model
 * text-behind-speaker uses). Everything else goes to the hosted inference
 * surface: the vision model returns segmentation masks (box + base64 mask
 * PNG per subject) and the alpha is applied here. Both end in the same
 * finishing pass — crop to content, then an optional white die-cut outline —
 * which is the kit's, since shaping a matted picture needs no host.
 */

import {
  applyAlpha,
  canvasOf,
  cropToContent,
  keepLargestSubject,
  removeFlatBackdrop,
  withOutline,
} from "@donkeycut/effects-kit";
import { hostedPost } from "./hosted";
import { decodeRasterImage, rasterCanvasToDataUrl, rasterCanvasToPng } from "./raster";
import { geminiModelRoles } from "@/lib/inference/gemini-models";

const WASM_BASE = "/mediapipe/wasm";
const PERSON_MODEL = "/mediapipe/selfie_segmenter.tflite";
/** Confidence above which a pixel counts as subject. */
const PERSON_THRESHOLD = 0.35;
type Segmenter = import("@mediapipe/tasks-vision").ImageSegmenter;

let segmenterOnce: Promise<Segmenter | null> | null = null;

/**
 * Give the wasm module somewhere quiet to log.
 *
 * TFLite writes its start-up notes ("INFO: Created TensorFlow Lite XNNPACK
 * delegate for CPU.", the GL and feedback-manager warnings) to the module's
 * stderr, and Emscripten binds stderr to `console.error` as the glue script
 * evaluates. Next's dev overlay classifies by channel rather than severity, so
 * an INFO line arrives on screen as a page error, pinned to whichever frame
 * happened to be running — in practice the behind-speaker pass, mid-playback.
 *
 * Emscripten reads `print`/`printErr` off the module object, and the task
 * runner passes a pre-set `self.Module` through to the factory (copying its own
 * `locateFile` onto it and clearing the global afterwards). Pointing those at
 * `console.debug` keeps the notes readable under verbose logging and off the
 * error channel. Patching `console.error` around the call cannot work: the glue
 * captured the original binding before we could reach it.
 */
type EmscriptenScope = typeof globalThis & { Module?: Record<string, unknown> };

async function withQuietWasmLogs<T>(create: () => Promise<T>): Promise<T> {
  const scope = globalThis as EmscriptenScope;
  const prior = scope.Module;
  const note = (...args: unknown[]) => console.debug("[mediapipe]", ...args);
  scope.Module = { print: note, printErr: note };
  try {
    return await create();
  } finally {
    if (prior === undefined) delete scope.Module;
    else scope.Module = prior;
  }
}

/** Build the inference delegate at load time. TFLite defers it to the first
 * inference, which would otherwise land on the first playback frame that needs
 * a matte. */
const WARM_PX = 16;

function warmSegmenter(segmenter: Segmenter): void {
  const [canvas] = canvasOf(WARM_PX, WARM_PX);
  try {
    segmenter.segment(canvas).close();
  } catch {
    // A warm-up that fails is not a reason to withhold a working segmenter.
  }
}

/** The shared IMAGE-mode person segmenter, created on first use. Null when
 * the runtime assets are missing (segmentation quietly unavailable). */
export function personSegmenter(): Promise<Segmenter | null> {
  segmenterOnce ??= (async () => {
    try {
      const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      const segmenter = await withQuietWasmLogs(() =>
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: PERSON_MODEL },
          runningMode: "IMAGE",
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        })
      );
      warmSegmenter(segmenter);
      return segmenter;
    } catch {
      segmenterOnce = null;
      return null;
    }
  })();
  return segmenterOnce;
}

/**
 * Segment one frame and return the subject as an alpha canvas at the mask's
 * own (small) resolution — white where the person is, transparent elsewhere.
 * Scaling it over a frame with `destination-in` cuts the person out; drawing
 * it into a mask video encodes the same information as luma. Null when no
 * segmenter or no clear person. The `source` should be small (≤ ~512px) —
 * the model resamples anyway, and segmentation runs per preview frame.
 */
export function segmentSubjectAlpha(
  segmenter: Segmenter,
  source: HTMLCanvasElement
): HTMLCanvasElement | null {
  const result = segmenter.segment(source);
  try {
    const mask = result.confidenceMasks?.[0];
    if (!mask) return null;
    const conf = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;
    const [out, ctx] = canvasOf(mw, mh);
    const img = ctx.createImageData(mw, mh);
    let kept = 0;
    for (let i = 0; i < mw * mh; i++) {
      // The selfie model's first confidence mask is background; subject = 1-bg.
      const subject = 1 - conf[i];
      const a =
        subject > PERSON_THRESHOLD
          ? Math.min(255, Math.round((subject - PERSON_THRESHOLD) * 4 * 255))
          : 0;
      img.data[i * 4] = 255;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = a;
      if (a > 128) kept++;
    }
    if (kept < mw * mh * 0.01) return null; // no meaningful person
    ctx.putImageData(img, 0, 0);
    return out;
  } finally {
    result.close();
  }
}

const TOUCH_MODEL = "/mediapipe/magic_touch.tflite";
type TouchSegmenter = import("@mediapipe/tasks-vision").InteractiveSegmenterLegacy;

let touchOnce: Promise<TouchSegmenter | null> | null = null;

/** The shared interactive (tap-to-select) segmenter, created on first use.
 * Null when the runtime assets are missing. */
export function interactiveSegmenter(): Promise<TouchSegmenter | null> {
  touchOnce ??= (async () => {
    try {
      const { FilesetResolver, InteractiveSegmenterLegacy } = await import(
        "@mediapipe/tasks-vision"
      );
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      return await withQuietWasmLogs(() =>
        InteractiveSegmenterLegacy.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: TOUCH_MODEL },
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        })
      );
    } catch {
      touchOnce = null;
      return null;
    }
  })();
  return touchOnce;
}

/**
 * Segment the object under a tap (or a scribbled path) and return its alpha
 * canvas at the mask's own resolution, white where the object is. Points are
 * frame fractions. Null when nothing registers. The `source` should be small
 * (≤ ~512px) — the model resamples anyway, and quick-brush strokes segment
 * per pointer move.
 */
export function segmentTouchAlpha(
  segmenter: TouchSegmenter,
  source: HTMLCanvasElement,
  points: { x: number; y: number }[]
): HTMLCanvasElement | null {
  if (points.length === 0) return null;
  const roi =
    points.length === 1
      ? { keypoint: { x: points[0].x, y: points[0].y } }
      : { scribble: points.map((p) => ({ x: p.x, y: p.y })) };
  const result = segmenter.segment(source, roi);
  try {
    const masks = result.confidenceMasks;
    if (!masks?.length) return null;
    // Two masks: background first, the touched object second (mirroring the
    // selfie model's layout). A single mask is the object itself.
    const conf = masks.length > 1 ? masks[1].getAsFloat32Array() : masks[0].getAsFloat32Array();
    const mw = masks[0].width;
    const mh = masks[0].height;
    const [out, ctx] = canvasOf(mw, mh);
    const img = ctx.createImageData(mw, mh);
    let kept = 0;
    for (let i = 0; i < mw * mh; i++) {
      const subject = conf[i];
      const a =
        subject > PERSON_THRESHOLD
          ? Math.min(255, Math.round((subject - PERSON_THRESHOLD) * 4 * 255))
          : 0;
      img.data[i * 4] = 255;
      img.data[i * 4 + 1] = 255;
      img.data[i * 4 + 2] = 255;
      img.data[i * 4 + 3] = a;
      if (a > 128) kept++;
    }
    if (kept < mw * mh * 0.001) return null;
    ctx.putImageData(img, 0, 0);
    return out;
  } finally {
    result.close();
  }
}

/** Person matting, fully on-device. Null when no person registers (callers
 * fall through to the hosted path). */
export async function personCutout(blob: Blob): Promise<HTMLCanvasElement | null> {
  const [img, segmenter] = await Promise.all([decodeRasterImage(blob), personSegmenter()]);
  if (!img || !segmenter) return null;
  const w = img.width;
  const h = img.height;
  const [canvas, ctx] = canvasOf(w, h);
  ctx.drawImage(img.source, 0, 0);
  const result = segmenter.segment(canvas);
  try {
    const mask = result.confidenceMasks?.[0];
    if (!mask) return null;
    const conf = mask.getAsFloat32Array();
    const mw = mask.width;
    const mh = mask.height;
    // The selfie model's first confidence mask is background; subject = 1-bg.
    const ok = applyAlpha(ctx, w, h, (i) => {
      const x = Math.min(mw - 1, Math.round(((i % w) * mw) / w));
      const y = Math.min(mh - 1, Math.round((Math.floor(i / w) * mh) / h));
      const subject = 1 - conf[y * mw + x];
      return subject > PERSON_THRESHOLD ? Math.min(1, (subject - PERSON_THRESHOLD) * 4) : 0;
    });
    return ok ? canvas : null;
  } finally {
    result.close();
  }
}

/** Hosted matting for general subjects: the vision model returns segmentation
 * masks; the largest subject's mask becomes the alpha. */
export async function hostedCutout(blob: Blob): Promise<HTMLCanvasElement | null> {
  const img = await decodeRasterImage(blob);
  if (!img) return null;
  const w = img.width;
  const h = img.height;
  const [canvas, ctx] = canvasOf(w, h);
  ctx.drawImage(img.source, 0, 0);
  // Fit the upload to the inline budget; masks come back box-relative, so a
  // downscaled request still masks the full-size picture.
  const [small, sctx] = canvasOf(Math.min(1024, w), Math.round((Math.min(1024, w) * h) / w));
  sctx.drawImage(img.source, 0, 0, small.width, small.height);
  const dataUrl = await rasterCanvasToDataUrl(small, "image/jpeg", 0.85);
  const res = await hostedPost("/api/inference/responses", {
    donkeyProvider: "gemini",
    model: geminiModelRoles.chat,
    instructions:
      "You segment images. Output a JSON object {\"masks\": [...]} where each entry has \"box_2d\" ([y0, x0, y1, x1], normalized 0-1000), \"mask\" (a data: URI PNG probability mask for that box), and \"label\". Segment only the single main foreground subject.",
    response_format: { type: "json_object" },
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", dataBase64: dataUrl.split(",")[1], mimeType: "image/jpeg" },
          { text: "Give the segmentation mask for the main foreground subject." },
        ],
      },
    ],
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { output_text?: string };
  let masks: { box_2d?: number[]; mask?: string }[] = [];
  try {
    const parsed = JSON.parse(body.output_text ?? "") as
      | { masks?: typeof masks }
      | typeof masks;
    masks = Array.isArray(parsed) ? parsed : (parsed.masks ?? []);
  } catch {
    return null;
  }
  const best = masks
    .filter((m) => Array.isArray(m.box_2d) && m.box_2d.length === 4 && typeof m.mask === "string")
    .sort((a, b) => {
      const area = (box: number[]) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
      return area(b.box_2d!) - area(a.box_2d!);
    })[0];
  if (!best) return null;
  const maskImg = await decodeRasterImage(await (await fetch(best.mask!)).blob().catch(() => new Blob()));
  if (!maskImg) return null;
  const [y0, x0, y1, x1] = best.box_2d!.map((v) => v / 1000);
  const [, mctx] = canvasOf(w, h);
  mctx.drawImage(maskImg.source, x0 * w, y0 * h, Math.max(1, (x1 - x0) * w), Math.max(1, (y1 - y0) * h));
  const maskData = mctx.getImageData(0, 0, w, h).data;
  const ok = applyAlpha(ctx, w, h, (i) => {
    const v = maskData[i * 4] / 255; // grayscale probability
    return v > 0.5 ? 1 : v > 0.25 ? (v - 0.25) * 4 : 0;
  });
  return ok ? canvas : null;
}

/** Knock out a flat studio backdrop — the shape a generated sticker arrives
 * in. Null when the picture has no such backdrop. */
export async function flatBackdropCutout(blob: Blob): Promise<HTMLCanvasElement | null> {
  const img = await decodeRasterImage(blob);
  if (!img) return null;
  const [canvas, ctx] = canvasOf(img.width, img.height);
  ctx.drawImage(img.source, 0, 0);
  return removeFlatBackdrop(canvas) ? canvas : null;
}

/**
 * The whole cutout pass, cheapest answer first: on-device person matting, then
 * the flat-backdrop knockout that generated stickers are made for, and only
 * then the hosted matte — the one that costs a round trip and credits. Ends in
 * crop-to-content and the optional die-cut outline. Null when no path finds a
 * subject, which is the caller's cue to keep the picture as it came.
 */
export async function makeStickerCutout(
  blob: Blob,
  opts: { outline?: boolean; plainBackdrop?: boolean } = {}
): Promise<Blob | null> {
  // A sticker we generated was asked for on a plain sweep, so the knockout is
  // both the cheapest answer and the one that knows the most. It goes first
  // there; a cat on a studio grey reads as a person often enough that letting
  // the segmenter answer first returns a mangled matte.
  const order = opts.plainBackdrop
    ? [flatBackdropCutout, personCutout, hostedCutout]
    : [personCutout, flatBackdropCutout, hostedCutout];
  let cut: HTMLCanvasElement | null = null;
  for (const attempt of order) {
    cut = await attempt(blob);
    if (cut) break;
  }
  if (!cut) return null;
  // A sticker is one thing. Strokes and specks the generator scattered around
  // it survive any matte — they are not backdrop — so the body is picked out
  // before the crop, which would otherwise frame the strays too.
  keepLargestSubject(cut);
  const cropped = cropToContent(cut);
  return rasterCanvasToPng(opts.outline === false ? cropped : withOutline(cropped));
}
