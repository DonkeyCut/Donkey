// How big a project card is in Home's row. A card keeps its project's shape,
// and every shape covers the same area as a 16:9 card, so a square sits
// smaller than a wide card is wide. No side passes the long side.
import { parseRatio } from "@/cut/lib/types";

/** How much room Home's rows take: `roomy` on the web, `compact` in the
 * ChatGPT card, which is about as wide as one column of a conversation. */
export type HomeDensity = "roomy" | "compact";

/** The long side of every card in the row, in pixels. */
export const TILE_LONG_SIDE: Record<HomeDensity, number> = { roomy: 280, compact: 170 };

// Projects without an aspect are 9:16.
const DEFAULT_FRAME = { w: 9, h: 16 };

/** A card's width and height for a project's aspect, e.g. on the web 9:16 →
 * 158×280, 16:9 → 280×158 and 1:1 → 210×210. */
export function projectTileSize(aspect: string | undefined, density: HomeDensity): { width: number; height: number } {
  const frame = (aspect ? parseRatio(aspect) : null) ?? DEFAULT_FRAME;
  const ratio = frame.w / frame.h;
  const long = TILE_LONG_SIDE[density];

  // The area every card covers: a 16:9 card's, 280×157.5 on the web.
  const area = (long * long * 9) / 16;

  // Equal area first; a shape past 16:9 either way is held to the long side.
  const width = Math.min(Math.sqrt(area * ratio), long, long * ratio);
  const height = Math.min(width / ratio, long);
  return { width: Math.round(height * ratio), height: Math.round(height) };
}
