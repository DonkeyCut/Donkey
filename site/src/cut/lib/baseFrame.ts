"use client";

/**
 * A clip's frame as the base rendering sees it: the decoder's code values put
 * through the source conversion alone — Apple Log, HLG or PQ into Rec.709
 * display values — and nothing of the grade. The chat's colour stats,
 * thumbnails, watch frames and freeze frames read this, so a log clip's
 * numbers and pictures describe what the display shows, never the flat log
 * encoding; Auto and a match read the raw frame and render each grade they
 * try through the clip's recipe. The frames are read the way the preview
 * reads them (sourceColor.ts): tags overridden so the decoder draws code
 * values, and the matrix it drew them through undone first.
 */

import {
  applyLutToImageData,
  buildClipLut,
  type ClipColorRecipe,
  type ColorGrade,
  drawnColorKey,
  type DrawnColor,
  type GradeLut,
  type ParsedLut,
  type SourceProfile,
} from "@donkeycut/effects-kit";
import { frameSink, openMedia, videoTrackOf, type FrameCanvasSink, type FrameSize, type FrameSinkOptions } from "./mediaRead";
import { sampleClipColorRead, sampleClipFrameData } from "./previewCanvas";
import { colorRead, fileAt, previewFile, type ColorRead } from "./sourceColor";
import { useEditor } from "./store";
import type { InputVideoTrack, WrappedCanvas } from "mediabunny";

export { sourceProfileOf } from "./sourceColor";

/** The source conversion for a readout, sampled once per profile and drawn
 * matrix and kept: a 17³ lattice is plenty for quantiles and means. */
const conversions = new Map<string, GradeLut | null>();

function conversionFor(profile: SourceProfile, drawn: Partial<DrawnColor> | undefined): GradeLut | null {
  const key = `${profile}|${drawnColorKey(drawn)}`;
  let lut = conversions.get(key);
  if (lut === undefined) {
    lut = buildClipLut({ profile, output: "sdr", size: 17, ...drawn });
    conversions.set(key, lut);
  }
  return lut;
}

/** Convert raw code values in place into the base rendering. Identity for a
 * Rec.709 or sRGB source drawn through its own matrix. */
export function toBaseRendering(
  px: Uint8ClampedArray,
  profile: SourceProfile,
  drawn?: Partial<DrawnColor>
): Uint8ClampedArray {
  const lut = conversionFor(profile, drawn);
  if (lut) applyLutToImageData(px, lut);
  return px;
}

/** A grade to read a frame through: the clip's grade and the library LUT it
 * names, loaded. */
export type ReadGrade = { grade: ColorGrade; userLut?: ParsedLut };

/** Thumb-size readouts sample a 33³ lattice: quantiles and means sit within
 * a code of the full-size preview. */
const GRADED_READ_LUT_SIZE = 33;

/** Convert raw code values in place into the picture the grade renders on an
 * SDR project: the clip's whole recipe in one lattice, so a log clip's grade
 * runs in scene light exactly as the preview runs it. */
export function toGradedRendering(
  px: Uint8ClampedArray,
  profile: SourceProfile,
  drawn: Partial<DrawnColor> | undefined,
  read: ReadGrade
): Uint8ClampedArray {
  const lut = buildClipLut({ ...drawn, profile, output: "sdr", size: GRADED_READ_LUT_SIZE, grade: read.grade }, read.userLut);
  if (!lut) return toBaseRendering(px, profile, drawn);
  applyLutToImageData(px, lut);
  return px;
}

/** A frame's code values (RGBA) and the ungraded recipe that draws them on
 * an SDR project: what a match renders each grade it tries through. */
export interface RawFrame {
  px: Uint8ClampedArray;
  recipe: ClipColorRecipe;
}

/** A small readout of a clip's code values as the preview decoded them; null
 * when the clip has no decoded frame ready. */
export function sampleClipRawFrame(clipId: string, w = 96, h = 54): RawFrame | null {
  const px = sampleClipFrameData(clipId, w, h);
  if (!px) return null;
  const s = useEditor.getState();
  const clip = s.clips.find((c) => c.id === clipId);
  const asset = clip ? s.assets.find((a) => a.id === clip.assetId) : undefined;
  // The frame came through the engine's read of the clip; its recipe is the
  // one the compositor draws it with.
  const input = asset ? (sampleClipColorRead(clipId) ?? colorRead(asset, previewFile(asset))).recipe() : undefined;
  return { px, recipe: { ...input, profile: input?.profile ?? "rec709", output: "sdr", size: 0 } };
}

/** How the frames at `url` are to be read: the project asset the URL belongs
 * to, and which of its files the URL is. An unknown URL reads as Rec.709. */
export function colorReadAt(url: string): ColorRead {
  const asset = useEditor.getState().assets.find((a) => a.url === url || a.proxyUrl === url);
  return colorRead(asset ?? {}, asset ? fileAt(asset, url) : "master");
}

function convertInPlace(wrapped: WrappedCanvas, profile: SourceProfile, drawn: DrawnColor): WrappedCanvas {
  const canvas = wrapped.canvas;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return wrapped;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  toBaseRendering(image.data, profile, drawn);
  ctx.putImageData(image, 0, 0);
  return wrapped;
}

/** A sink whose frames are the base rendering of what `read` reads: the
 * plain sink for a Rec.709 or sRGB source, and for any other the override
 * read followed by the source conversion on each frame. The route's drawn
 * matrix is settled before the first frame, so what comes out never depends
 * on timing. */
export function baseFrameSink(
  track: InputVideoTrack,
  size: FrameSize | undefined,
  read: ColorRead,
  opts?: Omit<FrameSinkOptions, "colorSpace">
): FrameCanvasSink {
  const colorSpace = read.colorSpace;
  const sink = frameSink(track, size, { ...opts, ...(colorSpace ? { colorSpace } : {}) });
  const profile = read.recipe().profile;
  if (!colorSpace && (profile === "rec709" || profile === "srgb")) return sink;
  const ready = read.settled();
  const convert = async (frame: WrappedCanvas | null) => (frame ? convertInPlace(frame, profile, await ready) : frame);
  return {
    getCanvas: async (t) => convert(await sink.getCanvas(t)),
    canvases: async function* (start, end) {
      for await (const frame of sink.canvases(start, end)) yield convertInPlace(frame, profile, await ready);
    },
    canvasesAtTimestamps: async function* (times) {
      for await (const frame of sink.canvasesAtTimestamps(times)) yield await convert(frame);
    },
  };
}

/** One base-rendering frame of the file at `url`. */
export async function baseFrameAt(url: string, time: number, size?: FrameSize): Promise<WrappedCanvas | null> {
  const input = openMedia(url);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new Error("This file has no readable video.");
    return await baseFrameSink(track, size, colorReadAt(url)).getCanvas(Math.max(0, time));
  } finally {
    input.dispose();
  }
}

/** The code values of one frame of the file at `url`, read the way the
 * preview reads them, with the recipe that draws them. */
export async function rawFrameAt(url: string, time: number, size: FrameSize): Promise<RawFrame | null> {
  const input = openMedia(url);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new Error("This file has no readable video.");
    const read = colorReadAt(url);
    const colorSpace = read.colorSpace;
    const frame = await frameSink(track, size, colorSpace ? { colorSpace } : {}).getCanvas(Math.max(0, time));
    const ctx = frame?.canvas.getContext("2d") as CanvasRenderingContext2D | null | undefined;
    if (!frame || !ctx) return null;
    const drawn = await read.settled();
    return {
      px: ctx.getImageData(0, 0, frame.canvas.width, frame.canvas.height).data,
      recipe: { ...drawn, output: "sdr", size: 0 },
    };
  } finally {
    input.dispose();
  }
}

/** Base-rendering frames at ascending `times`, in one decode pass; null for a
 * time the track has no frame for. */
export async function* baseFramesAt(url: string, times: number[], size?: FrameSize): AsyncGenerator<WrappedCanvas | null> {
  const input = openMedia(url);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new Error("This file has no readable video.");
    yield* baseFrameSink(track, size, colorReadAt(url)).canvasesAtTimestamps(times);
  } finally {
    input.dispose();
  }
}
