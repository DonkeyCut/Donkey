/**
 * Fritsch–Carlson monotone cubic interpolation: smooth through every control
 * point, never overshooting between two of them. The tone curves and the speed
 * curves both sample it — a tone curve that overshoots clips a highlight, a
 * speed curve that overshoots runs the footage backward.
 */

/**
 * A sampler for the curve through `(xs[i], ys[i])`, `xs` ascending. The curve
 * holds its end values outside the first and last point.
 */
export function monotoneCubic(xs: number[], ys: number[]): (x: number) => number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return () => 0;
  if (n === 1) return () => ys[0];
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = Math.max(1e-6, xs[i + 1] - xs[i]);
    h.push(dx);
    d.push((ys[i + 1] - ys[i]) / dx);
  }
  const m: number[] = [d[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  }
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // Binary search for the segment holding `x`.
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      ys[i] * (2 * t3 - 3 * t2 + 1) +
      h[i] * m[i] * (t3 - 2 * t2 + t) +
      ys[i + 1] * (-2 * t3 + 3 * t2) +
      h[i] * m[i + 1] * (t3 - t2)
    );
  };
}
