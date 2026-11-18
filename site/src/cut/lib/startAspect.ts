// The frame a project made from Home starts at, read off the files picked to
// make it. The biggest picture decides, so one file sets the frame to its own
// shape and a mix of sizes follows the one with the most pixels. A shape the
// prompt asks for is the chat's to set on arrival.
import type { AssetRef } from "./assetRef";
import { normalizeAspect, type Aspect } from "./types";

/** The biggest picture's shape among `refs`, or null when none is a sized
 * video or image. Example: a 1080×1920 clip beside a 4K landscape → "16:9". */
export function startAspect(refs: AssetRef[]): Aspect | null {
  let best: AssetRef | null = null;
  for (const r of refs) {
    if ((r.kind !== "video" && r.kind !== "image") || !r.width || !r.height) {
      continue;
    }
    if (!best || r.width * r.height > best.width! * best.height!) {
      best = r;
    }
  }
  if (!best) {
    return null;
  }

  return aspectOfSize(best.width!, best.height!);
}

/** A pixel size as a frame ratio. A size whose reduced sides pass 999 lands
 * on its ratio to two places: 1997×1123 → "89:50". */
function aspectOfSize(w: number, h: number): Aspect | null {
  const exact = normalizeAspect(`${w}:${h}`);
  if (exact) {
    return exact;
  }

  return w >= h ? normalizeAspect(`${(w / h).toFixed(2)}:1`) : normalizeAspect(`1:${(h / w).toFixed(2)}`);
}
