/**
 * Pattern fills: a fill color laid down as a repeating figure.
 *
 * A pattern is measured in design px (1080 short side) and anchored at the
 * top-left of the box it fills, turning about the box center. The canvas
 * painter here and the preview's SVG <pattern> read the same geometry, so the
 * lines land on the same pixels in the preview and every export.
 */

/** The figures a fill can repeat. */
export const PATTERN_KINDS = ["stripes"] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

/** Parallel lines in the fill color with clear gaps between them. */
export interface StripesPattern {
  kind: "stripes";
  /** Line direction in degrees, clockwise; absent or 0 = vertical lines. */
  angle?: number;
  /** Line thickness, px at 1080. */
  width: number;
  /** Clear space between lines, px at 1080. */
  gap: number;
}

/** A pattern fill. Each kind is one member, keyed by `kind`. */
export type PatternSpec = StripesPattern;

/** Slider and schema bounds for stripe line and gap, px at 1080. */
export const STRIPE_LINE_MIN = 0.5;
export const STRIPE_LINE_MAX = 40;
export const STRIPE_GAP_MAX = 40;

/** The default stripes: 2 px lines with 1 px gaps, a loading-bar fill. */
export const STRIPES_DEFAULT: StripesPattern = { kind: "stripes", width: 2, gap: 1 };

/** Stripes in output px: line thickness, line-to-line period and angle. */
export interface StripeGeometry {
  line: number;
  period: number;
  angle: number;
}

/** Resolve stripes to output px at `scale` (output px per design px). */
export function stripeGeometry(spec: StripesPattern, scale: number): StripeGeometry {
  const line = Math.max(STRIPE_LINE_MIN, spec.width) * scale;
  const gap = Math.max(0, spec.gap) * scale;
  return { line, period: line + gap, angle: spec.angle ?? 0 };
}

/** Below this period (output px) the lines blur into one coat. */
const STRIPE_PERIOD_MIN = 0.25;

/** Stripes that draw as a flat coat: no gap, or lines finer than a pixel,
 * where a loop of thousands of rects buys a picture no one can tell apart. */
export function stripesSolid(g: StripeGeometry): boolean {
  return g.period < STRIPE_PERIOD_MIN || g.line >= g.period;
}

/**
 * Paint a pattern over the box [0, 0, w, h] of the current transform in
 * `color`. Figures run a little past the box edge, so the caller clips to the
 * outline it fills (a shape's path, a glyph run's ink).
 */
export function paintPattern(
  ctx: CanvasRenderingContext2D,
  spec: PatternSpec,
  w: number,
  h: number,
  color: string,
  scale: number
): void {
  paintStripes(ctx, spec, w, h, color, scale);
}

function paintStripes(
  ctx: CanvasRenderingContext2D,
  spec: StripesPattern,
  w: number,
  h: number,
  color: string,
  scale: number
): void {
  const g = stripeGeometry(spec, scale);
  ctx.save();
  ctx.fillStyle = color;

  // A flat coat needs one rect.
  if (stripesSolid(g)) {
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    return;
  }

  // Turn about the box center; a turned box needs lines across its whole
  // diagonal to stay covered.
  let x0 = 0;
  let x1 = w;
  let y0 = 0;
  let y1 = h;
  if (g.angle) {
    const r = Math.hypot(w, h) / 2;
    ctx.translate(w / 2, h / 2);
    ctx.rotate((g.angle * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    x0 = w / 2 - r;
    x1 = w / 2 + r;
    y0 = h / 2 - r;
    y1 = h / 2 + r;
  }

  // One line per period from the box origin, one fill for the lot.
  // Example: 2 px lines, 1 px gaps → lines at 0, 3, 6, … each 2 px wide.
  ctx.beginPath();
  const kEnd = Math.ceil(x1 / g.period);
  for (let k = Math.floor(x0 / g.period); k < kEnd; k++) {
    ctx.rect(k * g.period, y0, g.line, y1 - y0);
  }
  ctx.fill();
  ctx.restore();
}
