/**
 * What a delivered file is: its container, the codec inside, and the model
 * that turns a quality tier into a bitrate. Pure, so the tab, the engine, the
 * cloud routes and the worker all read the one table.
 */

export type ExportCodec = "h264" | "hevc" | "prores";
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
 * landing the same tier in about 60% of the bits, ProRes 422 HQ a fixed ~3.5
 * bits a pixel (220 Mbit/s at 1080p30). A bitrate the user typed wins.
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
  if (s.codec === "prores") return Math.round(pixelsPerSec * 3.54);
  if (s.bitrate) return s.bitrate;
  const bpp = 0.08 * 2 ** ((23 - s.crf) / 6) * (s.codec === "hevc" ? 0.6 : 1);
  return Math.max(200_000, Math.round(pixelsPerSec * bpp));
}

/** Every media file a render spec plays — clips, picture-in-picture video,
 * sound — by name, once each. */
export function specMediaFiles(spec: {
  clips?: { file?: string }[];
  overlayVideos?: { file?: string }[];
  audio?: { file?: string }[];
}): string[] {
  const names = new Set<string>();
  for (const c of [...(spec.clips ?? []), ...(spec.overlayVideos ?? []), ...(spec.audio ?? [])]) {
    if (c?.file) names.add(c.file);
  }
  return [...names];
}
