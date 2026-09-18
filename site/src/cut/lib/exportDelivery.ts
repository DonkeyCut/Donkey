/**
 * What a delivered file is: its container, the codec inside, and the model
 * that turns a quality tier into a bitrate. Pure, so the tab, the engine, the
 * cloud routes and the worker all read the one table.
 */

export type ExportCodec = "h264" | "hevc" | "prores" | "prores4444";
export type ExportContainer = "mp4" | "mov";
export type ExportAudioCodec = "aac" | "pcm";

export interface DeliveryContainer {
  id: ExportContainer;
  label: string;
  ext: string;
  mime: string;
}

export const EXPORT_CONTAINERS: readonly DeliveryContainer[] = [
  { id: "mp4", label: "MP4", ext: ".mp4", mime: "video/mp4" },
  { id: "mov", label: "MOV", ext: ".mov", mime: "video/quicktime" },
];

/**
 * A codec a delivered file can carry: what the menu calls it, the container
 * it needs, the chroma it holds, and how it is rated.
 *
 * `bpp` marks a codec with no rate control: ProRes encodes at one rate per
 * profile, so the quality tier and a typed bitrate never reach it and its
 * size is bits-per-pixel times the frame. The others are rated by tier.
 */
export interface DeliveryCodec {
  id: ExportCodec;
  label: string;
  detail: string;
  /** The only container this codec rides; absent = any of them. */
  container?: ExportContainer;
  /** Full-chroma delivery: 4:4:4, no subsampling. */
  chroma444?: true;
  /** Bits a pixel, fixed, for a codec with no rate control. */
  bpp?: number;
}

/**
 * The delivery codecs, in menu order. ProRes 422 HQ writes ~220 Mbit/s at
 * 1080p30 and ProRes 4444 ~330, which is where the fixed bits-per-pixel come
 * from.
 */
export const EXPORT_CODECS: readonly DeliveryCodec[] = [
  { id: "h264", label: "H.264", detail: "plays everywhere" },
  { id: "hevc", label: "HEVC", detail: "half the size · newer devices" },
  { id: "prores", label: "ProRes 422 HQ", detail: "edit master · MOV", container: "mov", bpp: 3.54 },
  {
    id: "prores4444",
    label: "ProRes 4444",
    detail: "every pixel's own color · MOV",
    container: "mov",
    chroma444: true,
    bpp: 5.31,
  },
];

export function deliveryCodec(id: ExportCodec | undefined): DeliveryCodec {
  return EXPORT_CODECS.find((c) => c.id === id) ?? EXPORT_CODECS[0];
}

/** Whether a codec sets its own rate, so the quality tier and a typed
 * bitrate have nothing to act on. */
export function fixedRate(id: ExportCodec | undefined): boolean {
  return deliveryCodec(id).bpp !== undefined;
}

/** A window of the timeline to deliver, seconds; absent = the whole cut. */
export interface ExportRange {
  start: number;
  end: number;
}

/** How long a delivery runs: the range's span, or the whole cut. */
export function deliverySpan(range: ExportRange | undefined, duration: number): number {
  if (!range) return duration;
  const start = Math.max(0, range.start);
  const end = Math.min(duration, range.end);
  return Math.max(0, end - start);
}

/** Seconds between key frames in a delivered file. Two is what the platforms
 * ask for: seeks land within two seconds, and the encoder keeps most of its
 * bits for the frames between. */
export const KEYFRAME_INTERVAL_S = 2;

/** The base of a delivered file's name, from what the user typed or the
 * project is called: a container suffix dropped, path and shell characters
 * stripped, trimmed, cut to sixty characters, with "export" standing in for
 * nothing at all. The one rule every residency names its file by. */
export function exportBaseName(raw: string): string {
  return (
    raw
      .replace(/\.(mp4|mov)$/i, "")
      .replace(/[/\\:*?"<>|]/g, "")
      .trim()
      .slice(0, 60) || "export"
  );
}

export function deliveryContainer(id: ExportContainer | undefined): DeliveryContainer {
  return EXPORT_CONTAINERS.find((c) => c.id === id) ?? EXPORT_CONTAINERS[0];
}

/** The container a delivered file's name says it is; MP4 when the name says
 * nothing this table knows. */
export function containerOfName(name: string): DeliveryContainer {
  const lower = name.toLowerCase();
  return EXPORT_CONTAINERS.find((c) => lower.endsWith(c.ext)) ?? EXPORT_CONTAINERS[0];
}

/** Whether a file name is one the export writes. */
export function isDeliveryName(name: string): boolean {
  const lower = name.toLowerCase();
  return EXPORT_CONTAINERS.some((c) => lower.endsWith(c.ext));
}

/**
 * The video bitrate a setting asks for, in bits per second: H.264
 * bits-per-pixel halving every +6 CRF from a ~0.08 bpp anchor at CRF 23, HEVC
 * landing the same tier in about 60% of the bits, and a fixed-rate codec the
 * bits a pixel its table row names. A bitrate the user typed wins.
 *
 * WebCodecs and VideoToolbox encode to a bitrate while the tiers are written
 * in CRF; this is the one model they share with the dialog's size estimate, so
 * the file lands at the size the user was shown.
 */
export function videoBitrateFor(s: {
  width: number;
  height: number;
  fps: number;
  crf: number;
  codec?: ExportCodec;
  bitrate?: number;
}): number {
  const pixelsPerSec = s.width * s.height * s.fps;
  const fixed = deliveryCodec(s.codec).bpp;
  if (fixed) return Math.round(pixelsPerSec * fixed);
  if (s.bitrate) return s.bitrate;
  const bpp = 0.08 * 2 ** ((23 - s.crf) / 6) * (s.codec === "hevc" ? 0.6 : 1);
  return Math.max(200_000, Math.round(pixelsPerSec * bpp));
}

/** Every media file a render spec plays — clips, picture-in-picture video,
 * sound — by name, once each. */
export function specMediaFiles(spec: {
  clips?: { file?: string; staged?: boolean }[];
  overlayVideos?: { file?: string }[];
  audio?: { file?: string }[];
}): string[] {
  const names = new Set<string>();
  for (const c of [...(spec.clips ?? []), ...(spec.overlayVideos ?? []), ...(spec.audio ?? [])]) {
    // A staged picture is painted by the client and travels with the job, so
    // it is not one of the project's media files: looking for it in the
    // project's folder finds nothing, and staging it there puts it where the
    // render does not read.
    if (c?.file && !("staged" in c && c.staged)) names.add(c.file);
  }
  return [...names];
}
