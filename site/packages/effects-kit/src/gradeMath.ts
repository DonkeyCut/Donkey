/**
 * The grade's pixel math: one pure transform on display values that every
 * renderer consumes through the clip LUT (colorPipeline.ts). A grade
 * resolves to at most two layers — the preset (scaled by its amount,
 * optionally kept off skin tones) and the manual adjustments on top — and
 * each layer runs its stages in one order, on the container the project
 * delivers in (Rec.709/BT.1886 for SDR, Rec.2100 HLG or PQ for HDR):
 *
 *   light, in linear light (the container's transfer inverted):
 *     monochrome (a negative saturation slider, see below) → white balance
 *     (CAT02) → exposure (stops) → contrast (a power about 18% grey) →
 *     highlights / shadows / whites / blacks / brilliance (smooth luminance
 *     masks) → wheels (ASC CDL offset; lift / gamma / gain) → encode
 *   color, on display values:
 *     curves → hue / saturation / vibrance / HSL bands in OkLCh → fade
 *
 * Desaturation runs first. Toning — sepia and its relatives — is a black and
 * white image with a cast laid over it, so the chroma has to go before the
 * warmth and the wheels arrive; a saturation *increase* stays in the color
 * stage where it scales the chroma the light stage produced. The split keeps
 * the slider continuous through zero.
 *
 * Skin protection is one rule at the layer's end: the tone lands in full and
 * the chroma the layer moved blends back toward the pixel's own by the skin
 * weight.
 */

import {
  type ColorGrade,
  type CurvePoint,
  type GradePresetRef,
  type HslBand,
  type WheelZone,
  GRADE_LUT_SCALAR_KEYS,
  GRADE_MAX,
  HSL_BANDS,
  WHEEL_ZONES,
  normalizeGrade,
} from "./colorGrade";
import {
  type Mat3,
  type OutputSpace,
  type Primaries,
  D65,
  OKLAB_M2,
  OKLAB_M2_INV,
  REC2020_PRIMARIES,
  REC709_PRIMARIES,
  bt1886Decode,
  bt1886Encode,
  hlgOetf,
  hlgOetfInverse,
  illuminantXy,
  mat3Apply,
  oklabMatrices,
  pqDecode,
  pqEncode,
  spow,
  whiteBalanceMatrix,
} from "./colorSpace";
import { GRADE_PRESETS } from "./gradePresets";
import { monotoneCubic } from "./monotone";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------------ */
/* Slider semantics                                                    */
/* ------------------------------------------------------------------ */

/** Exposure at ±50 is ±2 stops. */
export const EXPOSURE_STOPS_AT_MAX = 2;
/** Temperature at ±50 assumes an illuminant 100 mireds from D65 (about
 * 3900 K warm, 18600 K cool). */
export const TEMPERATURE_MIREDS_AT_MAX = 100;
/** Tint at ±50 walks the isotherm by Δuv 0.035. */
export const TINT_DUV_AT_MAX = 0.035;
/** Contrast at ±50 is a power of 1.5 / 0.5 about 18% grey. */
export const CONTRAST_POWER_AT_MAX = 0.5;
/** Fade at 50 lifts black by this much of the display range. */
export const FADE_LIFT_AT_MAX = 0.22;

/** The luminance-mask amplitudes, in stops at their mask's peak. Highlights
 * is bounded so it never clips: 3.4·V²(1−V) stops keeps Y·2^stops ≤ 1 for
 * every V. */
const HIGHLIGHTS_STOPS = 3.4;
const SHADOWS_STOPS = 6.75;
const WHITES_STOPS = 0.7;
const BRILLIANCE_STOPS = 0.5;
/** Blacks is an additive offset in linear light, so it reaches black. The
 * slider maps to it through its signed square: a linear offset shows on the
 * encoded ramp as its 1/2.4 power, so the first notches would otherwise jump. */
const BLACKS_OFFSET = 0.03;

/** Wheel amplitudes at a full puck / luma trim. */
const WHEEL_LIFT = 0.03;
const WHEEL_GAMMA = 0.35;
const WHEEL_GAIN = 0.5;
const WHEEL_OFFSET = 0.05;

/* ------------------------------------------------------------------ */
/* The container a grade works in                                      */
/* ------------------------------------------------------------------ */

export interface GradeSpace {
  output: OutputSpace;
  primaries: Primaries;
  /** Signal → linear light (display-linear for SDR and PQ, scene-linear for
   * HLG, as each standard defines it). */
  decode(v: number): number;
  encode(l: number): number;
  /** Linear value of an 18% grey card (BT.2408 for the HDR containers). */
  pivot: number;
  /** Luminance weights of the container's primaries. */
  luma: [number, number, number];
  oklab: { toLms: Mat3; fromLms: Mat3 };
}

const spaces = new Map<OutputSpace, GradeSpace>();

export function gradeSpaceFor(output: OutputSpace): GradeSpace {
  let s = spaces.get(output);
  if (s) return s;
  if (output === "sdr") {
    s = {
      output,
      primaries: REC709_PRIMARIES,
      decode: bt1886Decode,
      encode: bt1886Encode,
      pivot: 0.18,
      luma: [0.2126, 0.7152, 0.0722],
      oklab: oklabMatrices(REC709_PRIMARIES),
    };
  } else if (output === "hlg") {
    s = {
      output,
      primaries: REC2020_PRIMARIES,
      decode: (v) => (v < 0 ? -hlgOetfInverse(-v) : hlgOetfInverse(v)),
      encode: (l) => (l < 0 ? -hlgOetf(-l) : hlgOetf(l)),
      pivot: hlgOetfInverse(0.38),
      luma: [0.2627, 0.678, 0.0593],
      oklab: oklabMatrices(REC2020_PRIMARIES),
    };
  } else {
    s = {
      output,
      primaries: REC2020_PRIMARIES,
      decode: (v) => (v < 0 ? -pqDecode(-v) / 1000 : pqDecode(v) / 1000),
      encode: (l) => (l < 0 ? -pqEncode(-l * 1000) : pqEncode(l * 1000)),
      pivot: 26 / 1000,
      luma: [0.2627, 0.678, 0.0593],
      oklab: oklabMatrices(REC2020_PRIMARIES),
    };
  }
  spaces.set(output, s);
  return s;
}

/* ------------------------------------------------------------------ */
/* Monotone tone curves                                                */
/* ------------------------------------------------------------------ */

/**
 * Sample a control-point curve into a 256-entry LUT over [0,1] using the
 * Fritsch–Carlson monotone cubic — smooth through every point, no overshoot.
 * The curve holds flat outside its first and last points.
 */
export function curveLut(points: CurvePoint[]): Float32Array {
  const xs = points.map((p) => p[0] / 255);
  const ys = points.map((p) => p[1] / 255);
  const at = monotoneCubic(xs, ys);
  const out = new Float32Array(256);
  for (let s = 0; s < 256; s++) out[s] = clamp01(at(s / 255));
  return out;
}

const sampleCurve = (lut: Float32Array, v: number) => {
  const x = clamp01(v) * 255;
  const i = Math.floor(x);
  const f = x - i;
  return i >= 255 ? lut[255] : lut[i] * (1 - f) + lut[i + 1] * f;
};

/**
 * Build master-curve control points from two semantic knobs: `contrast`
 * (-50..50, an s-curve around mid-gray) and `fade` (0..50, lifted blacks).
 * Returns undefined when both are neutral.
 */
export function semanticMasterCurve(contrast: number, fade: number): CurvePoint[] | undefined {
  const c = Math.max(-GRADE_MAX, Math.min(GRADE_MAX, contrast || 0)) / GRADE_MAX;
  const f = Math.max(0, Math.min(GRADE_MAX, fade || 0)) / GRADE_MAX;
  if (!c && !f) return undefined;
  const bend = Math.round(c * 28);
  const lift = Math.round(f * 56);
  const pts: CurvePoint[] = [
    [0, lift],
    [64, Math.max(0, Math.min(255, 64 - bend + Math.round(lift * 0.4)))],
    [192, Math.max(0, Math.min(255, 192 + bend))],
    [255, 255],
  ];
  return pts;
}

/* ------------------------------------------------------------------ */
/* Hue helpers                                                         */
/* ------------------------------------------------------------------ */

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1) || 1e-6);
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, Math.min(1, s), l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
};

const hueDist = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
};

/** How strongly a pixel reads as skin: a feathered hue window around warm
 * orange, gated to plausibly-skin saturation. Used to keep a preset's color
 * shifts off faces when its `skin` flag is set. */
export function skinWeight(hueDeg: number, sat: number): number {
  const d = hueDist(hueDeg, 25);
  const hueW = d <= 12 ? 1 : 1 - smoothstep(12, 28, d);
  const satW = smoothstep(0.05, 0.15, sat) * (1 - smoothstep(0.55, 0.78, sat));
  return hueW * satW;
}

/** Feathered partition-of-unity weight of a hue band at a given hue: 1 at the
 * band's center, ramping linearly to 0 at each neighbor's center. */
export function hueBandWeight(hueDeg: number, band: HslBand): number {
  const idx = HSL_BANDS.findIndex((b) => b.id === band);
  if (idx < 0) return 0;
  const c = HSL_BANDS[idx].center;
  const prev = HSL_BANDS[(idx + HSL_BANDS.length - 1) % HSL_BANDS.length].center;
  const next = HSL_BANDS[(idx + 1) % HSL_BANDS.length].center;
  const h = ((hueDeg % 360) + 360) % 360;
  const span = (from: number, to: number) => (((to - from) % 360) + 360) % 360;
  const up = span(prev, c) || 360;
  const down = span(c, next) || 360;
  const fromPrev = span(prev, h);
  if (fromPrev <= up) return fromPrev / up;
  const fromC = span(c, h);
  if (fromC <= down) return 1 - fromC / down;
  return 0;
}

/* ------------------------------------------------------------------ */
/* White balance                                                       */
/* ------------------------------------------------------------------ */

/** The RGB matrix for the temperature and tint sliders in a container: the
 * assumed illuminant sits `temperature` mireds *toward cool* of D65 (a warm
 * result comes from neutralizing a cool light) and `tint` toward green
 * (a magenta result from neutralizing a green light). */
export function whiteBalanceFor(temperature: number, tint: number, primaries: Primaries): Mat3 | null {
  if (!temperature && !tint) return null;
  const mired = -(temperature / GRADE_MAX) * TEMPERATURE_MIREDS_AT_MAX;
  const duv = (tint / GRADE_MAX) * TINT_DUV_AT_MAX;
  const xy = illuminantXy(mired, duv);
  if (Math.abs(xy[0] - D65[0]) < 1e-9 && Math.abs(xy[1] - D65[1]) < 1e-9) return null;
  return whiteBalanceMatrix(primaries, xy);
}

/* ------------------------------------------------------------------ */
/* Preset resolution                                                   */
/* ------------------------------------------------------------------ */

/** Scale a grade's every parameter toward neutral: scalars and tuples by t,
 * curve points toward the identity diagonal. Values go fractional — this
 * shape feeds the transform, never the doc. */
export function scaleGradeToward(g: ColorGrade, t: number): ColorGrade {
  if (t >= 1) return g;
  const out: ColorGrade = {};
  for (const k of GRADE_LUT_SCALAR_KEYS) {
    const v = g[k];
    if (v) out[k] = v * t;
  }
  if (g.curves) {
    const curves: NonNullable<ColorGrade["curves"]> = {};
    for (const ch of ["m", "r", "g", "b"] as const) {
      const pts = g.curves[ch];
      if (pts) curves[ch] = pts.map(([x, y]) => [x, x + (y - x) * t] as CurvePoint);
    }
    out.curves = curves;
  }
  if (g.wheels) {
    const wheels: NonNullable<ColorGrade["wheels"]> = {};
    for (const z of WHEEL_ZONES) {
      const w = g.wheels[z];
      if (w) wheels[z] = [w[0] * t, w[1] * t, w[2] * t];
    }
    out.wheels = wheels;
  }
  if (g.hsl) {
    const hsl: NonNullable<ColorGrade["hsl"]> = {};
    for (const band of HSL_BANDS) {
      const v = g.hsl[band.id];
      if (v) hsl[band.id] = [v[0] * t, v[1] * t, v[2] * t];
    }
    out.hsl = hsl;
  }
  return out;
}

/** Look up a preset ref in the catalog and scale it by its amount. Unknown
 * ids resolve to nothing, so docs from newer catalogs render ungraded. */
export function resolvePreset(ref: GradePresetRef | undefined): ColorGrade | undefined {
  if (!ref?.id) return undefined;
  const preset = GRADE_PRESETS[ref.id];
  if (!preset) return undefined;
  const amount = typeof ref.amount === "number" ? Math.max(0, Math.min(1, ref.amount)) : 1;
  if (amount <= 0) return undefined;
  return scaleGradeToward(preset.grade, amount);
}

/* ------------------------------------------------------------------ */
/* Layers                                                              */
/* ------------------------------------------------------------------ */

interface Wheel {
  zone: WheelZone;
  /** Per-channel amount: the zero-sum chroma direction plus the luma trim. */
  amount: [number, number, number];
}

interface Band {
  /** Neighbor centers and own center, degrees, for the feathered weight. */
  prev: number;
  center: number;
  next: number;
  hueShift: number;
  sat: number;
  lum: number;
}

interface Layer {
  desaturate: number; // 0..1 chroma kept before the light stage (1 = all)
  wb: Mat3 | null;
  gain: number; // linear multiplier from exposure and legacy brightness
  contrast: number; // power about the pivot
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  brilliance: number;
  masks: boolean;
  wheels: Wheel[];
  light: boolean;
  curves: { m?: Float32Array; r?: Float32Array; g?: Float32Array; b?: Float32Array } | null;
  hue: number;
  saturate: number; // chroma multiplier ≥ 1 in the color stage
  vibrance: number;
  bands: Band[];
  color: boolean;
  fade: number;
  skinDamp: boolean;
}

function wheelAmount(w: [number, number, number]): [number, number, number] | null {
  if (!w[0] && !w[1] && !w[2]) return null;
  const radius = Math.min(1, Math.hypot(w[0], w[1]) / GRADE_MAX);
  let chroma: [number, number, number] = [0, 0, 0];
  if (radius > 0) {
    const hue = ((Math.atan2(w[1], w[0]) * 180) / Math.PI + 360) % 360;
    const p = hslToRgb(hue, 1, 0.5);
    const mean = (p[0] + p[1] + p[2]) / 3;
    chroma = [(p[0] - mean) * radius, (p[1] - mean) * radius, (p[2] - mean) * radius];
  }
  const luma = w[2] / GRADE_MAX;
  return [chroma[0] + luma, chroma[1] + luma, chroma[2] + luma];
}

function buildLayer(g: ColorGrade, space: GradeSpace, skinDamp: boolean): Layer | null {
  const s = (g.saturation || 0) / GRADE_MAX;
  const brightness = 1 + (g.brightness || 0) / 100;
  const layer: Layer = {
    desaturate: s < 0 ? 1 + s : 1,
    wb: whiteBalanceFor(g.temperature || 0, g.tint || 0, space.primaries),
    gain: Math.pow(2, ((g.exposure || 0) / GRADE_MAX) * EXPOSURE_STOPS_AT_MAX) * Math.pow(brightness, 2.4),
    contrast: 1 + ((g.contrast || 0) / GRADE_MAX) * CONTRAST_POWER_AT_MAX,
    highlights: (g.highlights || 0) / GRADE_MAX,
    shadows: (g.shadows || 0) / GRADE_MAX,
    whites: (g.whites || 0) / GRADE_MAX,
    blacks: (g.blacks || 0) / GRADE_MAX,
    brilliance: (g.brilliance || 0) / GRADE_MAX,
    masks: false,
    wheels: [],
    light: false,
    curves: null,
    hue: g.hue || 0,
    saturate: s > 0 ? 1 + s : 1,
    vibrance: (g.vibrance || 0) / GRADE_MAX,
    bands: [],
    color: false,
    fade: Math.max(0, g.fade || 0) / GRADE_MAX,
    skinDamp,
  };
  if (g.curves) {
    layer.curves = {};
    for (const ch of ["m", "r", "g", "b"] as const) {
      const pts = g.curves[ch];
      if (pts && pts.length >= 2) layer.curves[ch] = curveLut(pts);
    }
    if (!Object.keys(layer.curves).length) layer.curves = null;
  }
  if (g.wheels) {
    for (const zone of WHEEL_ZONES) {
      const w = g.wheels[zone];
      if (!w) continue;
      const amount = wheelAmount(w);
      if (amount) layer.wheels.push({ zone, amount });
    }
  }
  if (g.hsl) {
    HSL_BANDS.forEach((band, idx) => {
      const t = g.hsl?.[band.id];
      if (!t || (!t[0] && !t[1] && !t[2])) return;
      layer.bands.push({
        prev: HSL_BANDS[(idx + HSL_BANDS.length - 1) % HSL_BANDS.length].center,
        center: band.center,
        next: HSL_BANDS[(idx + 1) % HSL_BANDS.length].center,
        hueShift: (t[0] / GRADE_MAX) * 30,
        sat: t[1] / GRADE_MAX,
        lum: t[2] / GRADE_MAX,
      });
    });
  }
  layer.masks =
    layer.highlights !== 0 || layer.shadows !== 0 || layer.whites !== 0 || layer.blacks !== 0 || layer.brilliance !== 0;
  layer.light = layer.wb !== null || layer.gain !== 1 || layer.contrast !== 1 || layer.masks || layer.wheels.length > 0;
  layer.color = layer.hue !== 0 || layer.saturate !== 1 || layer.vibrance !== 0 || layer.bands.length > 0;
  const active = layer.desaturate !== 1 || layer.light || layer.curves !== null || layer.color || layer.fade !== 0;
  return active ? layer : null;
}

function bandWeight(h: number, b: Band): number {
  const span = (from: number, to: number) => (((to - from) % 360) + 360) % 360;
  const up = span(b.prev, b.center) || 360;
  const down = span(b.center, b.next) || 360;
  const fromPrev = span(b.prev, h);
  if (fromPrev <= up) return fromPrev / up;
  const fromC = span(b.center, h);
  if (fromC <= down) return 1 - fromC / down;
  return 0;
}

/** Scratch for the per-pixel work, module-level so a layer application
 * allocates nothing and the functions below stay monomorphic. */
const M2 = OKLAB_M2;
const M2I = OKLAB_M2_INV;
let R = 0;
let G = 0;
let B = 0;
/** Whether R, G, B currently hold linear light (true) or display values. */
let LIN = false;

function toLinear(space: GradeSpace): void {
  if (LIN) return;
  R = space.decode(R);
  G = space.decode(G);
  B = space.decode(B);
  LIN = true;
}

function toDisplay(space: GradeSpace): void {
  if (!LIN) return;
  R = space.encode(R);
  G = space.encode(G);
  B = space.encode(B);
  LIN = false;
}

/** Chroma scale in Oklab on the linear scratch values, lightness kept. */
function scaleChroma(space: GradeSpace, k: number): void {
  const T = space.oklab.toLms;
  const F = space.oklab.fromLms;
  const l = Math.cbrt(T[0] * R + T[1] * G + T[2] * B);
  const m = Math.cbrt(T[3] * R + T[4] * G + T[5] * B);
  const s = Math.cbrt(T[6] * R + T[7] * G + T[8] * B);
  const Lk = M2[0] * l + M2[1] * m + M2[2] * s;
  const a = (M2[3] * l + M2[4] * m + M2[5] * s) * k;
  const bb = (M2[6] * l + M2[7] * m + M2[8] * s) * k;
  fromOklab(F, Lk, a, bb);
}

function fromOklab(F: Mat3, Lk: number, a: number, bb: number): void {
  const l2 = M2I[0] * Lk + M2I[1] * a + M2I[2] * bb;
  const m2 = M2I[3] * Lk + M2I[4] * a + M2I[5] * bb;
  const s2 = M2I[6] * Lk + M2I[7] * a + M2I[8] * bb;
  const l3 = l2 * l2 * l2;
  const m3 = m2 * m2 * m2;
  const s3 = s2 * s2 * s2;
  R = F[0] * l3 + F[1] * m3 + F[2] * s3;
  G = F[3] * l3 + F[4] * m3 + F[5] * s3;
  B = F[6] * l3 + F[7] * m3 + F[8] * s3;
}

function applyLayer(v: [number, number, number], L: Layer, space: GradeSpace, skinW: number): void {
  const damp = L.skinDamp ? skinW : 0;
  const pre0 = v[0];
  const pre1 = v[1];
  const pre2 = v[2];
  R = v[0];
  G = v[1];
  B = v[2];
  // The stages alternate between linear light and display values; a stage
  // only converts when the one before it left the other representation.
  LIN = false;

  if (L.desaturate !== 1) {
    toLinear(space);
    scaleChroma(space, L.desaturate);
  }

  // ---- light stage, in linear light ----
  if (L.light) {
    toLinear(space);
    if (L.wb) {
      const m = L.wb;
      const r2 = m[0] * R + m[1] * G + m[2] * B;
      const g2 = m[3] * R + m[4] * G + m[5] * B;
      const b2 = m[6] * R + m[7] * G + m[8] * B;
      R = r2;
      G = g2;
      B = b2;
    }
    if (L.gain !== 1) {
      R *= L.gain;
      G *= L.gain;
      B *= L.gain;
    }
    if (L.contrast !== 1) {
      const p = space.pivot;
      R = p * spow(R / p, L.contrast);
      G = p * spow(G / p, L.contrast);
      B = p * spow(B / p, L.contrast);
    }
    if (L.masks) {
      const y = space.luma[0] * R + space.luma[1] * G + space.luma[2] * B;
      const yl = clamp01(y);
      const V = clamp01(space.encode(yl));
      const iv = 1 - V;
      let stops = 0;
      if (L.highlights) stops += L.highlights * HIGHLIGHTS_STOPS * V * V * iv;
      if (L.shadows) stops += L.shadows * SHADOWS_STOPS * iv * iv * V;
      if (L.whites) stops += L.whites * WHITES_STOPS * V * V * V * V;
      if (L.brilliance) stops += L.brilliance * BRILLIANCE_STOPS * (1 - 2 * V) * 4 * V * iv;
      if (stops) {
        const k = Math.pow(2, stops);
        R *= k;
        G *= k;
        B *= k;
      }
      if (L.blacks) {
        // The mask is on linear luminance: an offset masked on the encoded
        // value would rise faster than the signal near black and fold the
        // ramp over.
        const iy = 1 - yl;
        const off = L.blacks * Math.abs(L.blacks) * BLACKS_OFFSET * iy * iy * iy;
        R += off;
        G += off;
        B += off;
      }
    }
    for (const w of L.wheels) {
      const a = w.amount;
      if (w.zone === "s") {
        R += WHEEL_LIFT * a[0] * (1 - R);
        G += WHEEL_LIFT * a[1] * (1 - G);
        B += WHEEL_LIFT * a[2] * (1 - B);
      } else if (w.zone === "m") {
        R = spow(R, 1 / (1 + WHEEL_GAMMA * a[0]));
        G = spow(G, 1 / (1 + WHEEL_GAMMA * a[1]));
        B = spow(B, 1 / (1 + WHEEL_GAMMA * a[2]));
      } else if (w.zone === "h") {
        R *= 1 + WHEEL_GAIN * a[0];
        G *= 1 + WHEEL_GAIN * a[1];
        B *= 1 + WHEEL_GAIN * a[2];
      } else {
        R += WHEEL_OFFSET * a[0];
        G += WHEEL_OFFSET * a[1];
        B += WHEEL_OFFSET * a[2];
      }
    }
  }

  // ---- color stage, on display values ----
  if (L.curves) {
    toDisplay(space);
    if (L.curves.m) {
      R = sampleCurve(L.curves.m, R);
      G = sampleCurve(L.curves.m, G);
      B = sampleCurve(L.curves.m, B);
    }
    if (L.curves.r) R = sampleCurve(L.curves.r, R);
    if (L.curves.g) G = sampleCurve(L.curves.g, G);
    if (L.curves.b) B = sampleCurve(L.curves.b, B);
  }
  if (L.color) {
    let entryHue = 0;
    if (L.bands.length) {
      entryHue = LIN
        ? rgbToHsl(clamp01(space.encode(R)), clamp01(space.encode(G)), clamp01(space.encode(B)))[0]
        : rgbToHsl(clamp01(R), clamp01(G), clamp01(B))[0];
    }
    toLinear(space);
    const T = space.oklab.toLms;
    const l = Math.cbrt(T[0] * R + T[1] * G + T[2] * B);
    const m = Math.cbrt(T[3] * R + T[4] * G + T[5] * B);
    const s = Math.cbrt(T[6] * R + T[7] * G + T[8] * B);
    let Lk = M2[0] * l + M2[1] * m + M2[2] * s;
    const a0 = M2[3] * l + M2[4] * m + M2[5] * s;
    const b0 = M2[6] * l + M2[7] * m + M2[8] * s;
    let C = Math.hypot(a0, b0);
    let h = (Math.atan2(b0, a0) * 180) / Math.PI;
    if (L.hue) h += L.hue;
    if (L.saturate !== 1) C *= L.saturate;
    // Vibrance boosts muted colors most; 0.3 is about the chroma of a pure
    // display primary in Oklab, so a saturated color is left alone.
    if (L.vibrance) C *= 1 + L.vibrance * 0.8 * (1 - Math.min(1, C / 0.3));
    for (const band of L.bands) {
      const w = bandWeight(entryHue, band);
      if (w <= 0) continue;
      h += band.hueShift * w;
      C *= 1 + band.sat * w;
      Lk *= 1 + band.lum * 0.5 * w;
    }
    if (C < 0) C = 0;
    const rad = (h * Math.PI) / 180;
    fromOklab(space.oklab.fromLms, Lk, C * Math.cos(rad), C * Math.sin(rad));
  }
  if (L.fade) {
    toDisplay(space);
    const lift = L.fade * FADE_LIFT_AT_MAX;
    R = clamp01(R);
    G = clamp01(G);
    B = clamp01(B);
    R += lift * (1 - R) * (1 - R);
    G += lift * (1 - G) * (1 - G);
    B += lift * (1 - B) * (1 - B);
  }
  toDisplay(space);

  if (damp > 0) {
    // The protected color is the pixel's own, carried to wherever the layer's
    // tone landed: scaling by the luma ratio keeps hue and saturation exactly.
    const y0 = space.luma[0] * pre0 + space.luma[1] * pre1 + space.luma[2] * pre2;
    const y1 = space.luma[0] * R + space.luma[1] * G + space.luma[2] * B;
    const k = y0 > 1e-4 ? y1 / y0 : 1;
    R = R * (1 - damp) + pre0 * k * damp;
    G = G * (1 - damp) + pre1 * k * damp;
    B = B * (1 - damp) + pre2 * k * damp;
  }
  v[0] = R;
  v[1] = G;
  v[2] = B;
}

export type GradeTransform = (r: number, g: number, b: number) => [number, number, number];

/**
 * Compile a grade into the pure pixel transform on display values of the
 * given container, in [0,1] (values may leave the range between stages; the
 * pipeline clamps once at the end). Returns null for a neutral grade.
 */
export function createGradeTransform(
  g: ColorGrade | undefined | null,
  output: OutputSpace = "sdr"
): GradeTransform | null {
  const n = normalizeGrade(g);
  if (!n) return null;
  const space = gradeSpaceFor(output);
  const layers: Layer[] = [];
  const presetGrade = resolvePreset(n.preset);
  if (presetGrade) {
    const layer = buildLayer(presetGrade, space, !!n.preset?.skin);
    if (layer) layers.push(layer);
  }
  const manual: ColorGrade = { ...n };
  delete manual.preset;
  delete manual.lut;
  delete manual.sharpen;
  delete manual.clarity;
  const manualLayer = buildLayer(manual, space, false);
  if (manualLayer) layers.push(manualLayer);
  if (!layers.length) return null;
  const anySkin = layers.some((l) => l.skinDamp);
  return (r, g2, b) => {
    const v: [number, number, number] = [r, g2, b];
    let skinW = 0;
    if (anySkin) {
      const [h, s] = rgbToHsl(clamp01(r), clamp01(g2), clamp01(b));
      skinW = skinWeight(h, s);
    }
    for (const layer of layers) applyLayer(v, layer, space, skinW);
    return v;
  };
}

/* ------------------------------------------------------------------ */
/* Filmstrip approximation                                             */
/* ------------------------------------------------------------------ */

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

/**
 * A DOM-CSS approximation of the grade for tiny always-on surfaces on
 * Rec.709 sources (timeline filmstrips, preset tiles): exposure and the
 * luminance masks become a brightness gain, contrast a contrast(), the
 * saturation and vibrance a saturate(), hue a hue-rotate(), and white
 * balance a multiply tint from the CAT02 matrix's response to white. Curves,
 * wheels, hue bands, LUTs and the source conversion are left out by design —
 * the preview canvas and exports render them for real.
 */
export function gradeCssApprox(
  g: ColorGrade | undefined | null
): { filter: string; tint: string | null } {
  const n = normalizeGrade(g);
  if (!n) return { filter: "", tint: null };
  const presetGrade = resolvePreset(n.preset);
  const eff: Record<string, number> = {};
  for (const k of GRADE_LUT_SCALAR_KEYS) {
    const v = (presetGrade?.[k] || 0) + (n[k] || 0);
    if (v) eff[k] = v;
  }
  const u = (k: string) => (eff[k] || 0) / GRADE_MAX;
  // A linear gain shows on encoded values as its 1/2.4 power.
  const stops =
    u("exposure") * EXPOSURE_STOPS_AT_MAX +
    (u("shadows") + u("highlights") * 0.5 + u("whites") * 0.3 + u("blacks") * 0.3 + u("brilliance") * 0.2) * 0.35;
  const gain = Math.pow(2, stops / 2.4) * (1 + (eff.brightness || 0) / 100) * (1 + u("fade") * 0.08);
  const contrast = (1 + u("contrast") * CONTRAST_POWER_AT_MAX) * (1 - u("fade") * 0.2) * (1 - u("brilliance") * 0.1);
  const saturate = Math.max(0, 1 + u("saturation") + u("vibrance") * 0.5);
  const hue = eff.hue || 0;
  const parts: string[] = [];
  if (Math.abs(gain - 1) > 1e-3) parts.push(`brightness(${fmt(gain)})`);
  if (Math.abs(contrast - 1) > 1e-3) parts.push(`contrast(${fmt(contrast)})`);
  if (Math.abs(saturate - 1) > 1e-3) parts.push(`saturate(${fmt(saturate)})`);
  if (hue) parts.push(`hue-rotate(${fmt(hue)}deg)`);
  let tint: string | null = null;
  const wb = whiteBalanceFor(eff.temperature || 0, eff.tint || 0, REC709_PRIMARIES);
  if (wb) {
    // The matrix's response to white, normalized so the multiply pass only
    // ever dims a channel; the lost level rides the brightness term.
    const w = mat3Apply(wb, 1, 1, 1);
    const top = Math.max(w[0], w[1], w[2], 1e-6);
    const ch = (x: number) => Math.max(0, Math.min(255, Math.round(255 * bt1886Encode(Math.max(0, x / top)))));
    tint = `rgb(${ch(w[0])}, ${ch(w[1])}, ${ch(w[2])})`;
    const lift = bt1886Encode(top);
    if (Math.abs(lift - 1) > 1e-3) {
      const i = parts.findIndex((p) => p.startsWith("brightness("));
      const total = gain * lift;
      const term = `brightness(${fmt(total)})`;
      if (i >= 0) parts[i] = term;
      else parts.unshift(term);
    }
  }
  return { filter: parts.join(" "), tint };
}
