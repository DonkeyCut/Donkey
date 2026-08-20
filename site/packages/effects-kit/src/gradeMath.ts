/**
 * The extended grade's pixel math: one pure transform [0,1]³ → [0,1]³ that
 * every renderer consumes through the 3D LUT in gradeLut.ts. A grade resolves
 * to at most two layers — the preset (scaled by its amount, optionally kept
 * off skin tones) and the manual adjustments on top — and each layer applies
 * its stages in one canonical order:
 *
 *   gain → contrast → wheels → highlights/shadows → curves → cast tint →
 *   HSL (global hue/saturation, vibrance, feathered hue bands) → clamp
 *
 * The tonal stages reuse the exact fast-path formulas from colorGrade.ts, so
 * a scalar grade evaluated through the LUT lands on the fast path's result to
 * within quantization.
 */

import {
  type ColorGrade,
  type CurvePoint,
  type GradePresetRef,
  type HslBand,
  GRADE_MAX,
  HSL_BANDS,
  deriveGrade,
  gradeTint,
  gradeToCssFilter,
  isNeutralGrade,
  normalizeGrade,
} from "./colorGrade";
import { GRADE_PRESETS } from "./gradePresets";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/* ------------------------------------------------------------------ */
/* Monotone tone curves                                                */
/* ------------------------------------------------------------------ */

/**
 * Sample a control-point curve into a 256-entry LUT over [0,1] using the
 * Fritsch–Carlson monotone cubic — smooth through every point, no overshoot.
 * The curve holds flat outside its first and last points.
 */
export function curveLut(points: CurvePoint[]): Float32Array {
  const n = points.length;
  const xs = points.map((p) => p[0] / 255);
  const ys = points.map((p) => p[1] / 255);
  const out = new Float32Array(256);
  if (n === 1) {
    out.fill(clamp01(ys[0] ?? 0));
    return out;
  }
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
  for (let s = 0; s < 256; s++) {
    const x = s / 255;
    if (x <= xs[0]) {
      out[s] = clamp01(ys[0]);
      continue;
    }
    if (x >= xs[n - 1]) {
      out[s] = clamp01(ys[n - 1]);
      continue;
    }
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    out[s] =
      clamp01(
        ys[i] * (2 * t3 - 3 * t2 + 1) +
          h[i] * m[i] * (t3 - 2 * t2 + t) +
          ys[i + 1] * (-2 * t3 + 3 * t2) +
          h[i] * m[i + 1] * (t3 - t2)
      );
  }
  return out;
}

const sampleCurve = (lut: Float32Array, v: number) => {
  const x = clamp01(v) * 255;
  const i = Math.floor(x);
  const f = x - i;
  return i >= 255 ? lut[255] : lut[i] * (1 - f) + lut[i + 1] * f;
};

/* ------------------------------------------------------------------ */
/* Semantic curve helpers (chat tools compile to real control points)  */
/* ------------------------------------------------------------------ */

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
/* Color space                                                         */
/* ------------------------------------------------------------------ */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
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
/* Preset resolution                                                   */
/* ------------------------------------------------------------------ */

/** Scale a grade's every parameter toward neutral: scalars and tuples by t,
 * curve points toward the identity diagonal. Values go fractional — this
 * shape feeds the transform, never the doc. */
export function scaleGradeToward(g: ColorGrade, t: number): ColorGrade {
  if (t >= 1) return g;
  const out: ColorGrade = {};
  for (const k of [
    "brightness",
    "contrast",
    "saturation",
    "exposure",
    "temperature",
    "tint",
    "hue",
    "highlights",
    "shadows",
    "vibrance",
  ] as const) {
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
    for (const z of ["s", "m", "h"] as const) {
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
/* The transform                                                       */
/* ------------------------------------------------------------------ */

interface Layer {
  gain: number;
  contrast: number;
  saturate: number;
  hue: number;
  tint: { r: number; g: number; b: number } | null;
  highlights: number;
  shadows: number;
  vibrance: number;
  curves: { m?: Float32Array; r?: Float32Array; g?: Float32Array; b?: Float32Array } | null;
  wheels: { zone: "s" | "m" | "h"; chroma: [number, number, number]; luma: number }[];
  bands: { band: HslBand; hueShift: number; sat: number; lum: number }[];
  skinDamp: boolean;
}

function buildLayer(g: ColorGrade, skinDamp: boolean): Layer | null {
  const d = deriveGrade(g);
  const layer: Layer = {
    gain: d.gain,
    contrast: d.contrast,
    saturate: d.saturate,
    hue: d.hue,
    tint: d.tint,
    highlights: (g.highlights || 0) / GRADE_MAX,
    shadows: (g.shadows || 0) / GRADE_MAX,
    vibrance: (g.vibrance || 0) / GRADE_MAX,
    curves: null,
    wheels: [],
    bands: [],
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
    for (const zone of ["s", "m", "h"] as const) {
      const w = g.wheels[zone];
      if (!w || (!w[0] && !w[1] && !w[2])) continue;
      const radius = Math.min(1, Math.hypot(w[0], w[1]) / GRADE_MAX);
      let chroma: [number, number, number] = [0, 0, 0];
      if (radius > 0) {
        const hue = ((Math.atan2(w[1], w[0]) * 180) / Math.PI + 360) % 360;
        const p = hslToRgb(hue, 1, 0.5);
        const mean = (p[0] + p[1] + p[2]) / 3;
        chroma = [
          (p[0] - mean) * radius * 0.35,
          (p[1] - mean) * radius * 0.35,
          (p[2] - mean) * radius * 0.35,
        ];
      }
      layer.wheels.push({ zone, chroma, luma: (w[2] / GRADE_MAX) * 0.25 });
    }
  }
  if (g.hsl) {
    for (const band of HSL_BANDS) {
      const t = g.hsl[band.id];
      if (!t || (!t[0] && !t[1] && !t[2])) continue;
      layer.bands.push({
        band: band.id,
        hueShift: (t[0] / GRADE_MAX) * 30,
        sat: t[1] / GRADE_MAX,
        lum: t[2] / GRADE_MAX,
      });
    }
  }
  const active =
    layer.gain !== 1 ||
    layer.contrast !== 1 ||
    layer.saturate !== 1 ||
    layer.hue !== 0 ||
    layer.tint !== null ||
    layer.highlights !== 0 ||
    layer.shadows !== 0 ||
    layer.vibrance !== 0 ||
    layer.curves !== null ||
    layer.wheels.length > 0 ||
    layer.bands.length > 0;
  return active ? layer : null;
}

function applyLayer(v: [number, number, number], L: Layer, skinW: number): void {
  const chromaScale = L.skinDamp ? 1 - skinW : 1;
  // Tonal: the fast path's exact gain + mid-gray contrast, clipped like the
  // combined lutrgb expression.
  for (let c = 0; c < 3; c++) {
    v[c] = clamp01((clamp01(v[c] * L.gain) - 0.5) * L.contrast + 0.5);
  }
  if (L.wheels.length) {
    const Y = luma(v[0], v[1], v[2]);
    const wS = (1 - Y) * (1 - Y);
    const wH = Y * Y;
    const wM = Math.max(0, 1 - wS - wH);
    for (const w of L.wheels) {
      const weight = w.zone === "s" ? wS : w.zone === "h" ? wH : wM;
      if (weight <= 0) continue;
      for (let c = 0; c < 3; c++) {
        const shift = w.chroma[c] * chromaScale + w.luma;
        if (w.zone === "s") v[c] += shift * weight;
        else if (w.zone === "h") v[c] *= 1 + shift * weight;
        else v[c] = Math.pow(clamp01(v[c]), 1 / Math.max(0.2, 1 + shift * weight * 1.5));
      }
    }
    for (let c = 0; c < 3; c++) v[c] = clamp01(v[c]);
  }
  if (L.highlights || L.shadows) {
    const Y = luma(v[0], v[1], v[2]);
    const sh = L.shadows * 0.3 * (1 - Y) * (1 - Y);
    const hi = L.highlights * 0.3 * Y * Y;
    for (let c = 0; c < 3; c++) v[c] = clamp01(v[c] + sh + hi);
  }
  if (L.curves) {
    for (let c = 0; c < 3; c++) {
      let x = v[c];
      if (L.curves.m) x = sampleCurve(L.curves.m, x);
      const ch = c === 0 ? L.curves.r : c === 1 ? L.curves.g : L.curves.b;
      if (ch) x = sampleCurve(ch, x);
      v[c] = x;
    }
  }
  if (L.tint) {
    v[0] = clamp01(v[0] * (1 + (L.tint.r - 1) * chromaScale));
    v[1] = clamp01(v[1] * (1 + (L.tint.g - 1) * chromaScale));
    v[2] = clamp01(v[2] * (1 + (L.tint.b - 1) * chromaScale));
  }
  const needsHslStage =
    L.hue !== 0 || L.saturate !== 1 || L.vibrance !== 0 || L.bands.length > 0;
  if (needsHslStage) {
    let [h, s, l] = rgbToHsl(v[0], v[1], v[2]);
    const entryHue = h;
    if (L.hue) h += L.hue * chromaScale;
    if (L.saturate !== 1) s *= 1 + (L.saturate - 1) * chromaScale;
    if (L.vibrance) s += L.vibrance * 0.8 * s * (1 - s) * chromaScale;
    for (const b of L.bands) {
      const w = hueBandWeight(entryHue, b.band);
      if (w <= 0) continue;
      h += b.hueShift * w * chromaScale;
      s *= 1 + b.sat * w * chromaScale;
      l *= 1 + b.lum * 0.5 * w;
    }
    const rgb = hslToRgb(h, clamp01(s), clamp01(l));
    v[0] = clamp01(rgb[0]);
    v[1] = clamp01(rgb[1]);
    v[2] = clamp01(rgb[2]);
  }
}

export type GradeTransform = (r: number, g: number, b: number) => [number, number, number];

/**
 * Compile a grade into the pure pixel transform. Values are gamma-encoded
 * BT.709 RGB in [0,1]. Returns null for a neutral grade.
 */
export function createGradeTransform(g: ColorGrade | undefined | null): GradeTransform | null {
  const n = normalizeGrade(g);
  if (!n) return null;
  const layers: Layer[] = [];
  const presetGrade = resolvePreset(n.preset);
  if (presetGrade) {
    const layer = buildLayer(presetGrade, !!n.preset?.skin);
    if (layer) layers.push(layer);
  }
  const manual: ColorGrade = { ...n };
  delete manual.preset;
  const manualLayer = buildLayer(manual, false);
  if (manualLayer) layers.push(manualLayer);
  if (!layers.length) return null;
  const anySkin = layers.some((l) => l.skinDamp);
  return (r, g2, b) => {
    const v: [number, number, number] = [clamp01(r), clamp01(g2), clamp01(b)];
    let skinW = 0;
    if (anySkin) {
      const [h, s] = rgbToHsl(v[0], v[1], v[2]);
      skinW = skinWeight(h, s);
    }
    for (const layer of layers) applyLayer(v, layer, skinW);
    return v;
  };
}

/* ------------------------------------------------------------------ */
/* Filmstrip approximation                                             */
/* ------------------------------------------------------------------ */

/**
 * A DOM-CSS approximation of the whole grade for tiny always-on surfaces
 * (timeline filmstrips, preset tiles). Exact for the fast-path scalars with
 * the preset's scalars folded in by its amount; highlights/shadows and
 * vibrance become small brightness/contrast/saturation nudges; curves,
 * wheels, and hue bands are left out by design — the preview canvas and
 * exports render them for real.
 */
export function gradeCssApprox(
  g: ColorGrade | undefined | null
): { filter: string; tint: string | null } {
  const n = normalizeGrade(g);
  if (!n) return { filter: "", tint: null };
  const presetGrade = resolvePreset(n.preset);
  const eff: ColorGrade = {};
  const keys = [
    "brightness",
    "contrast",
    "saturation",
    "exposure",
    "temperature",
    "tint",
    "hue",
    "highlights",
    "shadows",
    "vibrance",
  ] as const;
  for (const k of keys) {
    const v = (presetGrade?.[k] || 0) + (n[k] || 0);
    if (v) eff[k] = v;
  }
  const approx: ColorGrade = {
    brightness: (eff.brightness || 0) + ((eff.shadows || 0) + (eff.highlights || 0)) * 0.2,
    contrast: (eff.contrast || 0) + ((eff.highlights || 0) - (eff.shadows || 0)) * 0.15,
    saturation: (eff.saturation || 0) + (eff.vibrance || 0) * 0.5,
    exposure: eff.exposure,
    temperature: eff.temperature,
    tint: eff.tint,
    hue: eff.hue,
  };
  if (isNeutralGrade(approx)) return { filter: "", tint: null };
  return { filter: gradeToCssFilter(approx), tint: gradeTint(approx) };
}
