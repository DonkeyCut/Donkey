// What kind of library asset a file name makes. One table for every shelf —
// the engine's disk, the cloud rows, the browser's store — and for the page
// that files a drop, so no shelf takes a file another would refuse. The
// extension is a technical field, never the user's words.
import type { AssetType } from "./types";

export const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
export const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
export const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;
export const FONT_RE = /\.(ttf|otf|woff2?)$/i;
export const LUT_RE = /\.(cube|3dl)$/i;

export function libraryTypeOf(fileName: string): AssetType | null {
  if (VIDEO_RE.test(fileName)) return "video";
  if (AUDIO_RE.test(fileName)) return "audio";
  if (IMAGE_RE.test(fileName)) return "image";
  if (FONT_RE.test(fileName)) return "font";
  if (LUT_RE.test(fileName)) return "lut";
  return null;
}
