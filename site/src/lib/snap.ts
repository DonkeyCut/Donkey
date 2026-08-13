/** Fraction of a control's range around a detent that lands exactly on it. */
const SNAP_REACH = 0.025;

/** The detent within reach of `v`, or `v` unchanged. Reach scales with the
 * control's range, so paired controls over the same span detent identically. */
export function snapNear(v: number, detents: number[], min: number, max: number): number {
  const reach = (max - min) * SNAP_REACH;
  return detents.find((s) => Math.abs(v - s) <= reach) ?? v;
}
