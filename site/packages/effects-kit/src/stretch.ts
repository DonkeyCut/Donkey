/**
 * Per-axis scale, split into the two numbers every renderer reads: a uniform
 * `scale` and a stretch on each axis over it. Readers that only know uniform
 * size (extents, selection chrome) take `scale`, the larger axis; the
 * painters multiply the stretch in. A TV switching off is x 1, y 0.02: scale
 * 1, sy 0.02. A flip through zero is x 1, y -1: scale 1, sy -1.
 */
export interface Stretched {
  scale: number;
  /** Width over `scale`; absent = 1. */
  sx?: number;
  /** Height over `scale`; absent = 1. */
  sy?: number;
}

/** Two axes differing by less than this are the same size. */
const SAME_AXIS = 1e-6;

/** The uniform scale and stretch for a picture `x` wide and `y` tall
 * (multiples of its drawn size). */
export function splitScale(x: number, y: number): Stretched {
  if (Math.abs(x - y) < SAME_AXIS) {
    return { scale: x };
  }
  const m = Math.max(Math.abs(x), Math.abs(y));
  return { scale: m, sx: x / m, sy: y / m };
}

/** The picture's width multiple: uniform scale times its x stretch. */
export function scaleXOf(s: Stretched): number {
  return s.scale * (s.sx ?? 1);
}

/** The picture's height multiple: uniform scale times its y stretch. */
export function scaleYOf(s: Stretched): number {
  return s.scale * (s.sy ?? 1);
}
