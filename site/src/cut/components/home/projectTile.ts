// How big a project card is in Home's row. A card keeps its project's shape,
// and its long side is the same for every shape: a wide card is as wide as a
// tall card is tall.
import { parseRatio } from "@/cut/lib/types";

/** The long side of every card in the row, in pixels. */
export const TILE_LONG_SIDE = 280;

// Projects without an aspect are 9:16.
const DEFAULT_FRAME = { w: 9, h: 16 };

/** A card's width and height for a project's aspect, e.g. 9:16 → 158×280 and
 * 16:9 → 280×158. */
export function projectTileSize(aspect: string | undefined): { width: number; height: number } {
  const frame = (aspect ? parseRatio(aspect) : null) ?? DEFAULT_FRAME;
  if (frame.w >= frame.h) {
    return { width: TILE_LONG_SIDE, height: Math.round((TILE_LONG_SIDE * frame.h) / frame.w) };
  }
  return { width: Math.round((TILE_LONG_SIDE * frame.w) / frame.h), height: TILE_LONG_SIDE };
}
