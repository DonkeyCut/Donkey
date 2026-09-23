// The export sizes offered by name. Kept apart from the export client so a
// server route can list them without pulling the editor in.

/** The delivery every render that is not the user's own export uses — hover
 * proxies, share cards, ladder masters, the phone's presets. */
export const DELIVERY_DEFAULTS = { codec: "h264", container: "mp4", audioCodec: "aac" } as const;

/** Presets pick a short-side target; `presetSettings` derives both dims from
 * the project ratio. */
export const EXPORT_PRESETS = [
  {
    id: "tiktok",
    label: "Best · 1080p",
    detail: "H.264 · best quality",
    shortSide: 1080,
    settings: { fps: 30, crf: 19, preset: "medium", ...DELIVERY_DEFAULTS },
  },
  {
    id: "fast",
    label: "Quick share · 1080p",
    detail: "smaller file, faster",
    shortSide: 1080,
    settings: { fps: 30, crf: 24, preset: "veryfast", ...DELIVERY_DEFAULTS },
  },
  {
    id: "light",
    label: "Draft · 720p",
    detail: "fastest render",
    shortSide: 720,
    settings: { fps: 30, crf: 24, preset: "veryfast", ...DELIVERY_DEFAULTS },
  },
] as const;

/** The sizes a document export offers: `original` matches the footage on the
 * timeline; the rest are the fixed presets flipped to the project's ratio. */
export const DOC_EXPORT_PRESETS = ["original", ...EXPORT_PRESETS.map((p) => p.id)] as const;

export type DocExportPreset = (typeof DOC_EXPORT_PRESETS)[number];

export function isDocExportPreset(value: unknown): value is DocExportPreset {
  return typeof value === "string" && (DOC_EXPORT_PRESETS as readonly string[]).includes(value);
}

/** Named output sizes; Source is derived from the project media. */
export const EXPORT_RESOLUTIONS = [
  { id: "2160", label: "4K", shortSide: 2160 },
  { id: "1440", label: "1440p", shortSide: 1440 },
  { id: "1080", label: "1080p", shortSide: 1080 },
  { id: "720", label: "720p", shortSide: 720 },
  { id: "480", label: "480p", shortSide: 480 },
  { id: "360", label: "360p", shortSide: 360 },
  { id: "240", label: "240p", shortSide: 240 },
] as const;
