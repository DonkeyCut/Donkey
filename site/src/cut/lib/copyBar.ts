/** The share of a copy's bar shown before any file has landed, so the bar
 * reads as started while the project is being made. */
const START_SHARE = 0.05;

/**
 * How full a template copy's bar is, 0 to 1. It starts at a sliver while no
 * count has arrived and fills the rest file by file, so it only ever grows:
 * 0 of 0 and 0 of 11 both draw the sliver, 11 of 11 draws it full.
 */
export function copyBarShare(done: number, total: number): number {
  if (total <= 0) {
    return START_SHARE;
  }
  return START_SHARE + (1 - START_SHARE) * Math.min(1, done / total);
}
