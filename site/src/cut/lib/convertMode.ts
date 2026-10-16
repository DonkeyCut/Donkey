/** How a conversion treats a video stream that already fits its container:
 * "fit" copies it, "reencode" rewrites it from what ffmpeg decodes — for a
 * stream the page parses and then reads no frames from. Shared by the page,
 * the engine, the cloud routes and the worker. */
export const CONVERT_MODES = ["fit", "reencode"] as const;

export type ConvertMode = (typeof CONVERT_MODES)[number];

/** A request's `mode` field: absent is "fit"; anything else unknown is null. */
export function convertModeIn(value: unknown): ConvertMode | null {
  if (value === undefined) {
    return "fit";
  }
  return CONVERT_MODES.find((m) => m === value) ?? null;
}
