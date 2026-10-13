/**
 * Measuring pictures and fitting grades to them: color statistics off a
 * frame, the auto grade, and reference matching. Every fit is expressed in
 * the grade's own parameters (exposure in stops, white balance as an
 * illuminant, contrast about grey), so the result is an ordinary ColorGrade
 * the user or the assistant refines afterward. Stats and the auto grade read
 * the base rendering — the picture after the source conversion — so a log
 * clip is measured as the display sees it; a match renders the clip's code
 * values through its real recipe for every grade it tries.
 */

import { type ColorGrade, GRADE_MAX, normalizeGrade } from "./colorGrade";
import { displayToLab } from "./colorDifference";
import { type ClipColorRecipe, createClipTransform } from "./colorPipeline";
import { bt1886Decode } from "./colorSpace";
import { CONTRAST_POWER_AT_MAX } from "./gradeMath";

/** Quantile probes used by stats and matching. */
export const STAT_QUANTILES = [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98] as const;

export interface ColorStats {
  /** Per-channel values 0..255 at each STAT_QUANTILES probe. */
  r: number[];
  g: number[];
  b: number[];
  luma: number[];
  /** Channel means 0..255. */
  meanR: number;
  meanG: number;
  meanB: number;
  /** Mean HSL saturation 0..1. */
  meanSat: number;
  /** Red/blue mean ratio in the midtones; >1 reads warm, <1 reads cool. */
  warmth: number;
  /** CIELAB lightness L* (0..100) at each STAT_QUANTILES probe. */
  lightness: number[];
  /** The color of the shadows, midtones and highlights (TONE_BANDS): the
   * share of pixels in the band, the mean a* and b* — its cast, green–magenta
   * and blue–yellow — and their spread, which saturation scales. */
  tones: ToneColor[];
}

export interface ToneColor {
  share: number;
  a: number;
  b: number;
  spreadA: number;
  spreadB: number;
}

/** Upper L* edge of each tonal band, darkest first. */
const TONE_BANDS = [35, 70, 100];

/** Lightness bins per L* unit: a tenth of the smallest step anyone sees. */
const L_BINS_PER_UNIT = 10;

export function colorStatsFromImageData(data: Uint8ClampedArray): ColorStats | undefined {
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const lightHist = new Float64Array(100 * L_BINS_PER_UNIT + 1);
  // Per band: count, Σa, Σb, Σa², Σb².
  const bands = TONE_BANDS.map(() => [0, 0, 0, 0, 0]);
  let count = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSat = 0;
  let midR = 0;
  let midB = 0;
  let mids = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[0][r]++;
    hist[1][g]++;
    hist[2][b]++;
    hist[3][Math.min(255, Math.round(luma))]++;
    sumR += r;
    sumG += g;
    sumB += b;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l2 = max + min;
    sumSat += max === min ? 0 : (max - min) / (l2 <= 255 ? l2 : 510 - l2);
    if (luma >= 16 && luma <= 240) {
      midR += r;
      midB += b;
      mids++;
    }
    const [L, a, lb] = displayToLab(r, g, b);
    lightHist[Math.max(0, Math.min(lightHist.length - 1, Math.round(L * L_BINS_PER_UNIT)))]++;
    const band = bands[Math.max(0, TONE_BANDS.findIndex((top) => L <= top))];
    band[0]++;
    band[1] += a;
    band[2] += lb;
    band[3] += a * a;
    band[4] += lb * lb;
    count++;
  }
  if (!count) return undefined;
  const quantiles = (h: Float64Array, scale = 1) =>
    STAT_QUANTILES.map((p) => {
      let acc = 0;
      for (let v = 0; v < h.length; v++) {
        acc += h[v];
        if (acc >= count * p) return v / scale;
      }
      return (h.length - 1) / scale;
    });
  return {
    r: quantiles(hist[0]),
    g: quantiles(hist[1]),
    b: quantiles(hist[2]),
    luma: quantiles(hist[3]),
    meanR: sumR / count,
    meanG: sumG / count,
    meanB: sumB / count,
    meanSat: sumSat / count,
    warmth: mids ? midR / Math.max(1, midB) : 1,
    lightness: quantiles(lightHist, L_BINS_PER_UNIT),
    tones: bands.map(([n, sa, sb, saa, sbb]) => {
      if (!n) return { share: 0, a: 0, b: 0, spreadA: 0, spreadB: 0 };
      const a = sa / n;
      const b = sb / n;
      return {
        share: n / count,
        a,
        b,
        spreadA: Math.sqrt(Math.max(0, saa / n - a * a)),
        spreadB: Math.sqrt(Math.max(0, sbb / n - b * b)),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Auto grade                                                          */
/* ------------------------------------------------------------------ */

/** Pixels of a frame rendered through its recipe with a candidate grade. */
type PixelRender = (grade: ColorGrade | undefined) => Uint8ClampedArray;

/** The most pixels a fit renders per try: enough for quantiles a tenth of
 * an L* apart, few enough that a few hundred tries take well under a second. */
const FIT_SAMPLE = 4096;

/** A PixelRender over a frame's code values (RGBA) and the recipe that draws
 * them, with the candidate grade in the recipe's place: every try runs the
 * real pipeline, so a log clip is fitted in scene light exactly as the
 * preview renders it. At most FIT_SAMPLE pixels, evenly spaced. */
function recipeRender(px: Uint8ClampedArray, recipe: ClipColorRecipe): PixelRender {
  const total = px.length >> 2;
  const stride = Math.max(1, Math.ceil(total / FIT_SAMPLE));
  const sample = new Float32Array(Math.ceil(total / stride) * 3);
  let n = 0;
  for (let i = 0; i < total; i += stride) {
    sample[n * 3] = px[i * 4] / 255;
    sample[n * 3 + 1] = px[i * 4 + 1] / 255;
    sample[n * 3 + 2] = px[i * 4 + 2] / 255;
    n++;
  }
  return (grade) => {
    const fn = createClipTransform({ ...recipe, grade });
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const r = sample[i * 3];
      const g = sample[i * 3 + 1];
      const b = sample[i * 3 + 2];
      const v = fn ? fn(r, g, b) : [r, g, b];
      out[i * 4] = Math.round(v[0] * 255);
      out[i * 4 + 1] = Math.round(v[1] * 255);
      out[i * 4 + 2] = Math.round(v[2] * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  };
}

const lumaOf = (data: Uint8ClampedArray, i: number) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];

/** Geometric mean of display luminance: where the frame's exposure sits. */
function logAverage(data: Uint8ClampedArray): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += Math.log(Math.max(1e-4, bt1886Decode(lumaOf(data, i) / 255)));
  return Math.exp(sum / Math.max(1, data.length >> 2));
}

/** Mean red minus mean blue of the midtones in display light — the cast
 * grey-world reads; darker and clipped pixels carry no reliable illuminant. */
function midtoneCast(data: Uint8ClampedArray): number {
  let gap = 0;
  let mids = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luma = lumaOf(data, i);
    if (luma < 16 || luma > 240) continue;
    gap += bt1886Decode(data[i] / 255) - bt1886Decode(data[i + 2] / 255);
    mids++;
  }
  return mids ? gap / mids : 0;
}

/** The slider value in [-GRADE_MAX, GRADE_MAX] where a monotone `f` crosses
 * zero by bisection, or the end nearer zero when it never does. */
function sliderRoot(f: (v: number) => number): number {
  let lo = -GRADE_MAX;
  let hi = GRADE_MAX;
  let flo = f(lo);
  const fhi = f(hi);
  if (Math.sign(flo) === Math.sign(fhi)) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.sign(fm) === Math.sign(flo)) {
      lo = mid;
      flo = fm;
    } else hi = mid;
  }
  return (lo + hi) / 2;
}

/** How much of each measured correction Auto applies: a starting point the
 * user refines, short of a full normalization. */
const AUTO_EXPOSURE_SHARE = 0.8;
const AUTO_CONTRAST_SHARE = 0.6;
const AUTO_WB_SHARE = 0.6;
const AUTO_CONTRAST_RANGE = [-10, 40] as const;
const AUTO_WB_MAX = 40;

/**
 * Auto grade from a frame's code values (RGBA) and the recipe that draws
 * them, the classic auto-tone pipeline measured through the real render:
 *
 * 1. Exposure — the slider that moves the rendered frame's log-average
 *    luminance AUTO_EXPOSURE_SHARE of the way to 18% middle grey.
 * 2. Contrast — auto-levels: clip 0.5% off each end of the rendered luma
 *    histogram and stretch what remains toward full range, expressed as the
 *    power about grey the contrast slider applies.
 * 3. White balance — grey-world: the temperature whose render brings the
 *    midtones' red and blue means together, applied in part.
 *
 * Saturation and hue are left alone.
 */
export function autoGrade(px: Uint8ClampedArray, recipe: ClipColorRecipe): ColorGrade | undefined {
  if (px.length < 4) return undefined;
  const render = recipeRender(px, recipe);
  const grade: ColorGrade = {};

  const start = Math.log(logAverage(render(undefined)));
  const target = start + AUTO_EXPOSURE_SHARE * (Math.log(0.18) - start);
  grade.exposure = Math.round(sliderRoot((e) => Math.log(logAverage(render({ exposure: e }))) - target));

  // Auto-levels on the exposed render. A near-flat histogram (solid color,
  // title card) carries no tonal-range signal: contrast stays.
  const exposed = render(normalizeGrade(grade));
  const hist = new Float64Array(256);
  for (let i = 0; i < exposed.length; i += 4) hist[Math.min(255, Math.round(lumaOf(exposed, i)))]++;
  const count = exposed.length >> 2;
  const percentile = (p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= count * p) return v;
    }
    return 255;
  };
  const lo = percentile(0.005);
  const hi = percentile(0.995);
  if (hi - lo >= 16) {
    const power = 255 / (hi - lo);
    const [min, max] = AUTO_CONTRAST_RANGE;
    grade.contrast = Math.max(min, Math.min(max, Math.round(((power - 1) * AUTO_CONTRAST_SHARE * GRADE_MAX) / CONTRAST_POWER_AT_MAX)));
  }

  const toned = normalizeGrade(grade);
  const balanced = sliderRoot((t) => midtoneCast(render({ ...toned, temperature: t })));
  grade.temperature = Math.max(-AUTO_WB_MAX, Math.min(AUTO_WB_MAX, Math.round(balanced * AUTO_WB_SHARE)));
  return normalizeGrade(grade);
}

/* ------------------------------------------------------------------ */
/* Reference matching                                                  */
/* ------------------------------------------------------------------ */

/** The fields a match moves: exposure and contrast about grey, the two ends
 * of the range, white balance and saturation — the corrections that bring
 * one shot to another. Each is a slider the user reads afterward. */
const MATCH_FIELDS = ["exposure", "contrast", "highlights", "shadows", "temperature", "tint", "saturation"] as const;

/** Cost of a slider's distance from zero, in squared ΔL* units at full
 * throw: when two settings fit equally, the smaller one wins, so a field the
 * reference does not need stays at zero. */
const MATCH_PULL = 4;

/** Slider step of the finite differences the fit takes its slopes from. */
const MATCH_PROBE = 2;

/** The fit stops once no slider would move by more than this much. */
const MATCH_SETTLED = 0.25;
const MATCH_ITERATIONS = 40;

/** The stats of a frame rendered with a candidate grade. */
export type StatsRender = (grade: ColorGrade | undefined) => ColorStats | undefined;

/** How far apart two frames read, as residuals in CIELAB units: the
 * lightness distribution probe by probe, and each tonal band's cast and
 * spread weighted by the share of the reference it holds — the moments a Lab
 * color transfer matches, read per band so a split tone counts too. */
function statsResiduals(a: ColorStats, b: ColorStats): number[] {
  const out = a.lightness.map((l, i) => l - b.lightness[i]);
  for (let i = 0; i < b.tones.length; i++) {
    const p = a.tones[i];
    const q = b.tones[i];
    const w = Math.sqrt(TONE_BANDS.length * q.share);
    out.push(w * (p.a - q.a), w * (p.b - q.b), w * (p.spreadA - q.spreadA), w * (p.spreadB - q.spreadB));
  }
  return out;
}

/** Solve A x = y for a small dense system by Gaussian elimination with
 * partial pivoting; null when A is singular. */
function solve(A: number[][], y: number[]): number[] | null {
  const n = y.length;
  const m = A.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    if (Math.abs(m[pivot][c]) < 1e-12) return null;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = m[r][n];
    for (let k = r + 1; k < n; k++) v -= m[r][k] * x[k];
    x[r] = v / m[r][r];
  }
  return x;
}

/** A StatsRender over a frame's code values (RGBA) and the recipe that
 * draws them: recipeRender, measured. */
export function recipeStatsRender(px: Uint8ClampedArray, recipe: ClipColorRecipe): StatsRender {
  const render = recipeRender(px, recipe);
  return (grade) => colorStatsFromImageData(render(grade));
}

/**
 * The grade that brings a frame to `reference`, fitted in the grade's own
 * sliders: Levenberg–Marquardt least squares over MATCH_FIELDS, every try
 * rendered through `render` and scored by statsResiduals in CIELAB, with a
 * light pull toward zero on each slider. `strength` (0..1) scales the fitted
 * sliders — for a reference whose content differs from the clip's (a bright
 * window for a dark room), where the full match lifts or crushes what the
 * reference never had. Returns undefined when the frames already agree.
 */
export function matchGrade(render: StatsRender, reference: ColorStats, strength = 1): ColorGrade | undefined {
  const k = Math.max(0, Math.min(1, strength));
  if (k === 0) return undefined;
  const gradeOf = (p: number[]): ColorGrade => Object.fromEntries(MATCH_FIELDS.map((f, i) => [f, p[i]]));
  const pull = Math.sqrt(MATCH_PULL) / GRADE_MAX;
  const residuals = (p: number[]): number[] | null => {
    const stats = render(normalizeGrade(gradeOf(p)));
    return stats ? [...statsResiduals(stats, reference), ...p.map((v) => pull * v)] : null;
  };
  const sumSq = (r: number[]) => r.reduce((a, v) => a + v * v, 0);
  const clampSlider = (v: number) => Math.max(-GRADE_MAX, Math.min(GRADE_MAX, v));

  // Levenberg–Marquardt: slopes by finite differences, a damped
  // Gauss–Newton step, damping eased after a step that helps and raised
  // after one that does not.
  let p = MATCH_FIELDS.map(() => 0);
  let r = residuals(p);
  if (!r) return undefined;
  let damping = 1e-2;
  for (let it = 0; it < MATCH_ITERATIONS; it++) {
    const J = p.map((v, j) => {
      const q = [...p];
      q[j] = v + MATCH_PROBE <= GRADE_MAX ? v + MATCH_PROBE : v - MATCH_PROBE;
      const rq = residuals(q) ?? r!;
      return rq.map((x, i) => (x - r![i]) / (q[j] - v));
    });
    const A = J.map((ci) => J.map((cj) => ci.reduce((a, x, i) => a + x * cj[i], 0)));
    const g = J.map((ci) => ci.reduce((a, x, i) => a + x * r![i], 0));
    let stepped = false;
    let largest = 0;
    while (damping < 1e6) {
      const damped = A.map((row, i) => row.map((v, j) => (i === j ? v * (1 + damping) + 1e-9 : v)));
      const delta = solve(damped, g.map((v) => -v));
      if (!delta) break;
      const next = p.map((v, i) => clampSlider(v + delta[i]));
      largest = Math.max(...next.map((v, i) => Math.abs(v - p[i])));
      const rn = residuals(next);
      if (rn && sumSq(rn) < sumSq(r)) {
        p = next;
        r = rn;
        damping = Math.max(1e-6, damping / 3);
        stepped = true;
        break;
      }
      damping *= 4;
    }
    if (!stepped || largest < MATCH_SETTLED) break;
  }

  const scaled: ColorGrade = {};
  MATCH_FIELDS.forEach((f, i) => {
    const v = Math.round(p[i] * k);
    if (v) scaled[f] = v;
  });
  return normalizeGrade(scaled);
}
