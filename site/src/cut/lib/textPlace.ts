import { TEXT_GRID } from "./watch/signatures";
import type { SafeArea } from "./guides";

/** Where a card can sit over a stretch of footage without covering anything.
 *
 * A watch already measures, for every frame it keeps, how much hard edge each
 * cell of the picture holds — that is how it tells a caption landing from a
 * mouth moving. The same numbers answer a different question: a face, a hand,
 * a sign and the source's own burned-in type are all edges, and the parts of
 * the frame that stay quiet across every frame of a stretch are the parts a
 * title can take without hiding any of it.
 *
 * The answer is arithmetic over numbers the watch already has, so it costs
 * nothing extra and it holds wherever the watch runs. Placement is judged
 * against the WORST frame of the stretch, because a card sits still while the
 * picture moves under it.
 */

export interface TextSpot {
  /** Where it sits in the frame, as fractions of width and height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the spot sits, in the words someone would use for it. */
  where: string;
  /** How quiet it stays across the whole stretch, 1 quietest. */
  clear: number;
}

/** The bands a card is actually placed in: a full-width strip, because text
 * runs across. Vertical thirds of the safe area, then its halves, so a frame
 * whose subject sits high still offers the lower half whole. */
const BANDS: { top: number; height: number; where: string }[] = [
  { top: 0, height: 1 / 3, where: "across the top third" },
  { top: 1 / 3, height: 1 / 3, where: "across the middle" },
  { top: 2 / 3, height: 1 / 3, where: "across the lower third" },
  { top: 0, height: 0.5, where: "over the top half" },
  { top: 0.5, height: 0.5, where: "over the bottom half" },
];

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The mean edge energy inside a rect of the frame, for one frame's grid.
 * Cells are weighted by how much of them the rect covers, so a band edge
 * falling inside a cell does not count the whole cell. */
function energyIn(grid: Float32Array, r: { x: number; y: number; w: number; h: number }): number {
  const g = TEXT_GRID;
  let sum = 0;
  let weight = 0;
  for (let row = 0; row < g; row++) {
    const cy0 = row / g;
    const overlapY = Math.min(cy0 + 1 / g, r.y + r.h) - Math.max(cy0, r.y);
    if (overlapY <= 0) continue;
    for (let col = 0; col < g; col++) {
      const cx0 = col / g;
      const overlapX = Math.min(cx0 + 1 / g, r.x + r.w) - Math.max(cx0, r.x);
      if (overlapX <= 0) continue;
      const w = overlapX * overlapY;
      sum += grid[row * g + col] * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : 0;
}

/** The spots a card can take over this stretch, quietest first.
 *
 * `safe` bounds every spot, so a platform's own UI is already out of the way
 * before the footage is consulted. With no frames measured there is nothing to
 * judge, and the safe area itself comes back as the only answer. */
export function textSpots(edges: Float32Array[], safe: SafeArea, limit = 3): TextSpot[] {
  const whole = { x: safe.x, y: safe.y, w: safe.w, h: safe.h };
  if (edges.length === 0)
    return [{ ...whole, where: "anywhere inside the safe area", clear: 1 }];
  const rects = BANDS.map((b) => ({
    where: b.where,
    x: safe.x,
    w: safe.w,
    y: safe.y + b.top * safe.h,
    h: b.height * safe.h,
  }));
  // A card sits still while the picture moves, so a band is only as clear as
  // its busiest frame.
  const scored = rects.map((r) => ({
    rect: r,
    worst: Math.max(...edges.map((g) => energyIn(g, r))),
  }));
  // Clearness is relative to the busiest band of this footage: a talking head
  // and a title card hold different amounts of edge overall, and what matters
  // is which part of THIS picture is free.
  const loudest = Math.max(...scored.map((s) => s.worst), 1e-6);
  return scored
    .map((s) => ({
      x: round3(s.rect.x),
      y: round3(s.rect.y),
      w: round3(s.rect.w),
      h: round3(s.rect.h),
      where: s.rect.where,
      clear: round3(1 - s.worst / loudest),
    }))
    .sort((a, b) => b.clear - a.clear)
    .slice(0, Math.max(1, limit));
}
