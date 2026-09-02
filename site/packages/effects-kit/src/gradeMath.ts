/**
 * The extended grade's pixel math: one pure transform [0,1]³ → [0,1]³ that
 * every renderer consumes through the 3D LUT in gradeLut.ts. A grade resolves
 * to at most two layers — the preset (scaled by its amount, optionally kept
 * off skin tones) and the manual adjustments on top — and each layer applies
 * its stages in one canonical order:
 *
 *   gain → contrast → wheels → highlights/shadows → curves →
 *   HSL (global hue/saturation, vibrance, feathered hue bands) → cast tint →
 *   clamp
 *
 * The cast lands last because a cast is a print-side process — the silver is
 * replaced by a colored compound, a density multiply over the finished image.
 * Applying it before the saturation stage would let a desaturating grade strip
 * the very tone it just laid down, which is what makes a toned monochrome
 * (sepia and its relatives) expressible at all.
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
import { monotoneCubic } from "./monotone";

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
  // Skin protection is one rule applied at the layer's end: the layer's tone
  // lands in full, and the chroma it moved blends back toward the pixel's own
  // by the skin weight. Every stage — casts, curves, hue bands, saturation —
  // is covered by construction, so a stage added later cannot leak color onto
  // faces and no stage has to remember to damp itself.
  const damp = L.skinDamp ? skinW : 0;
  const pre: [number, number, number] | null = damp > 0 ? [v[0], v[1], v[2]] : null;
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
        const shift = w.chroma[c] + w.luma;
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
  const needsHslStage =
    L.hue !== 0 || L.saturate !== 1 || L.vibrance !== 0 || L.bands.length > 0;
  if (needsHslStage) {
    let [h, s, l] = rgbToHsl(v[0], v[1], v[2]);
    const entryHue = h;
    if (L.hue) h += L.hue;
    if (L.saturate !== 1) s *= L.saturate;
    if (L.vibrance) s += L.vibrance * 0.8 * s * (1 - s);
    for (const b of L.bands) {
      const w = hueBandWeight(entryHue, b.band);
      if (w <= 0) continue;
      h += b.hueShift * w;
      s *= 1 + b.sat * w;
      l *= 1 + b.lum * 0.5 * w;
    }
    const rgb = hslToRgb(h, clamp01(s), clamp01(l));
    v[0] = clamp01(rgb[0]);
    v[1] = clamp01(rgb[1]);
    v[2] = clamp01(rgb[2]);
  }
  if (L.tint) {
    v[0] = clamp01(v[0] * L.tint.r);
    v[1] = clamp01(v[1] * L.tint.g);
    v[2] = clamp01(v[2] * L.tint.b);
  }
  if (pre) {
    // The protected color is the pixel's own, carried to wherever the layer's
    // tone landed: scaling by the luma ratio keeps hue and saturation exactly,
    // where holding the chroma difference instead would raise saturation
    // whenever the layer darkened.
    const y0 = luma(pre[0], pre[1], pre[2]);
    const y1 = luma(v[0], v[1], v[2]);
    const k = y0 > 1e-4 ? y1 / y0 : 1;
    for (let c = 0; c < 3; c++) {
      v[c] = clamp01(v[c] * (1 - damp) + clamp01(pre[c] * k) * damp);
    }
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
