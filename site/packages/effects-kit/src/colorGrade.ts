/** A tone-curve control point: [input, output], both 0..255. */
export type CurvePoint = [number, number];

/** Per-channel tone curves; an absent channel is identity. */
export interface GradeCurves {
  m?: CurvePoint[];
  r?: CurvePoint[];
  g?: CurvePoint[];
  b?: CurvePoint[];
}

/** A color wheel's state: [dx, dy, luma], each -50..50. dx/dy is the puck's
 * position on the wheel (a chroma offset direction and strength); luma is the
 * per-range brightness trim. */
export type WheelTuple = [number, number, number];

/** Shadows / midtones / highlights color wheels; an absent wheel is neutral. */
export interface GradeWheels {
  s?: WheelTuple;
  m?: WheelTuple;
  h?: WheelTuple;
}

export type HslBand =
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "aqua"
  | "blue"
  | "purple"
  | "magenta";

/** A hue band's adjustments: [hueShift, saturation, luminance], each -50..50.
 * hueShift spans about ±30 degrees at full range. */
export type HslTuple = [number, number, number];

/** A preset layered under the manual adjustments. `amount` 0..1 scales the
 * preset toward neutral (default 1); `skin` keeps the preset's color shifts
 * off skin tones. Unknown ids render as neutral, so docs can carry presets
 * from newer catalogs without breaking. */
export interface GradePresetRef {
  id: string;
  amount?: number;
  skin?: boolean;
}

/** Per-clip color adjustments. Integer sliders, 0 = neutral; every field is
 * absent when neutral, so untouched clips carry nothing. */
export interface ColorGrade {
  brightness?: number; // -50..50
  contrast?: number; // -50..50
  saturation?: number; // -50..50
  exposure?: number; // -50..50 (±1 EV)
  temperature?: number; // -50..50, positive = warm
  tint?: number; // -50..50, negative = green, positive = magenta
  hue?: number; // -180..180 degrees
  highlights?: number; // -50..50, luma-masked highlight trim
  shadows?: number; // -50..50, luma-masked shadow lift/crush
  vibrance?: number; // -50..50, low-saturation-weighted saturation
  curves?: GradeCurves;
  wheels?: GradeWheels;
  hsl?: Partial<Record<HslBand, HslTuple>>;
  preset?: GradePresetRef;
}

/** Slider range for every grade parameter except hue. */
export const GRADE_MAX = 50;
export const GRADE_HUE_MAX = 180;

/** The Basic tool's slider rows; the UI and the AI tool schema both derive
 * from this list. Legacy `brightness` and `hue` stay in the model and render
 * everywhere, surfaced by the UI only when a stored grade carries them. */
export const GRADE_BASIC_FIELDS: {
  key: "exposure" | "contrast" | "highlights" | "shadows" | "temperature" | "tint" | "saturation" | "vibrance";
  label: string;
  group: "light" | "color";
}[] = [
  { key: "exposure", label: "Exposure", group: "light" },
  { key: "contrast", label: "Contrast", group: "light" },
  { key: "highlights", label: "Highlights", group: "light" },
  { key: "shadows", label: "Shadows", group: "light" },
  { key: "temperature", label: "Temperature", group: "color" },
  { key: "tint", label: "Tint", group: "color" },
  { key: "saturation", label: "Saturation", group: "color" },
  { key: "vibrance", label: "Vibrance", group: "color" },
];

/** The HSL tool's hue bands: chip swatch plus the band's center hue used by
 * the renderer's feathered band weights. */
export const HSL_BANDS: { id: HslBand; label: string; center: number; swatch: string }[] = [
  { id: "red", label: "Red", center: 0, swatch: "hsl(0 70% 55%)" },
  { id: "orange", label: "Orange", center: 30, swatch: "hsl(30 70% 55%)" },
  { id: "yellow", label: "Yellow", center: 60, swatch: "hsl(55 70% 55%)" },
  { id: "green", label: "Green", center: 120, swatch: "hsl(110 60% 45%)" },
  { id: "aqua", label: "Aqua", center: 180, swatch: "hsl(178 60% 50%)" },
  { id: "blue", label: "Blue", center: 240, swatch: "hsl(222 70% 55%)" },
  { id: "purple", label: "Purple", center: 285, swatch: "hsl(275 60% 55%)" },
  { id: "magenta", label: "Magenta", center: 330, swatch: "hsl(320 65% 55%)" },
];

/**
 * One mapping, every renderer. Scalar-only grades (the fast path) derive both
 * filter strings from the numbers computed here, so what the sliders show is
 * what ffmpeg bakes: gain/contrast are per-channel multiplies and a mid-gray
 * pivot, mathematically identical on both sides; saturation/hue lean on each
 * side's native primitive (CSS saturate/hue-rotate vs ffmpeg's chroma-plane
 * `hue`), visually indistinguishable over these ranges.
 *
 * Fast-path application order everywhere: gain+contrast → saturation+hue →
 * cast tint. Grades that use curves, wheels, per-hue HSL, highlights/shadows,
 * vibrance, or a preset render through one shared 3D LUT instead — built in
 * gradeLut.ts from the transform in gradeMath.ts — applied by ffmpeg's lut3d,
 * the preview's WebGL pass, and the headless CPU pass alike.
 */

type ScalarKey =
  | "brightness"
  | "contrast"
  | "saturation"
  | "exposure"
  | "temperature"
  | "tint"
  | "hue"
  | "highlights"
  | "shadows"
  | "vibrance";

const FIELDS: [ScalarKey, number][] = [
  ["brightness", GRADE_MAX],
  ["contrast", GRADE_MAX],
  ["saturation", GRADE_MAX],
  ["exposure", GRADE_MAX],
  ["temperature", GRADE_MAX],
  ["tint", GRADE_MAX],
  ["hue", GRADE_HUE_MAX],
  ["highlights", GRADE_MAX],
  ["shadows", GRADE_MAX],
  ["vibrance", GRADE_MAX],
];

const clamp = (v: unknown, max: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(-max, Math.min(max, n));
};

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

const CURVE_CHANNELS = ["m", "r", "g", "b"] as const;
const WHEEL_ZONES = ["s", "m", "h"] as const;

/** Clamp a stored curve into shape: integer points inside 0..255, sorted by
 * input, one point per input; identity or degenerate curves become absent. */
function normalizeCurve(pts: unknown): CurvePoint[] | undefined {
  if (!Array.isArray(pts)) return undefined;
  const byInput = new Map<number, number>();
  for (const p of pts) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Math.max(0, Math.min(255, Math.round(Number(p[0]) || 0)));
    const y = Math.max(0, Math.min(255, Math.round(Number(p[1]) || 0)));
    byInput.set(x, y);
  }
  const out = [...byInput.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => [x, y] as CurvePoint);
  if (out.length < 2) return undefined;
  if (out.every(([x, y]) => x === y)) return undefined;
  return out;
}

function normalizeTuple(t: unknown, max = GRADE_MAX): [number, number, number] | undefined {
  if (!Array.isArray(t)) return undefined;
  const out: [number, number, number] = [
    Math.round(clamp(t[0], max)),
    Math.round(clamp(t[1], max)),
    Math.round(clamp(t[2], max)),
  ];
  return out.some((v) => v !== 0) ? out : undefined;
}

export function isNeutralGrade(g: ColorGrade | undefined | null): boolean {
  return !g || normalizeGrade(g) === undefined;
}

/** True when the grade uses primitives beyond the cheap ctx.filter path —
 * those render through the shared 3D LUT. Every legacy scalar-only grade
 * stays false and keeps the original render path byte for byte. */
export function gradeNeedsLut(g: ColorGrade | undefined | null): boolean {
  if (!g) return false;
  return !!(
    g.highlights ||
    g.shadows ||
    g.vibrance ||
    g.curves ||
    g.wheels ||
    g.hsl ||
    (g.preset?.id && (g.preset.amount ?? 1) > 0)
  );
}

/** True when the given Adjust tool holds a non-neutral value; drives the
 * panel's per-tool dirty dots. */
export function gradeToolDirty(
  g: ColorGrade | undefined | null,
  tool: "basic" | "curves" | "wheels" | "hsl"
): boolean {
  const n = normalizeGrade(g);
  if (!n) return false;
  if (tool === "curves") return !!n.curves;
  if (tool === "wheels") return !!n.wheels;
  if (tool === "hsl") return !!n.hsl;
  return FIELDS.some(([k]) => n[k]);
}

/** Clamp to slider ranges, drop zeros and identity shapes; an all-neutral
 * grade becomes absent. Also the sanitizer for grades arriving as client
 * JSON. Preset ids are kept structurally — an id the running catalog does not
 * know renders as neutral instead of being stripped from the doc. */
export function normalizeGrade(g: ColorGrade | undefined | null): ColorGrade | undefined {
  if (!g) return undefined;
  const out: ColorGrade = {};
  for (const [k, max] of FIELDS) {
    const v = clamp(g[k], max);
    if (v !== 0) out[k] = v;
  }
  if (g.curves && typeof g.curves === "object") {
    const curves: GradeCurves = {};
    for (const ch of CURVE_CHANNELS) {
      const c = normalizeCurve(g.curves[ch]);
      if (c) curves[ch] = c;
    }
    if (Object.keys(curves).length) out.curves = curves;
  }
  if (g.wheels && typeof g.wheels === "object") {
    const wheels: GradeWheels = {};
    for (const z of WHEEL_ZONES) {
      const w = normalizeTuple(g.wheels[z]);
      if (w) wheels[z] = w;
    }
    if (Object.keys(wheels).length) out.wheels = wheels;
  }
  if (g.hsl && typeof g.hsl === "object") {
    const hsl: Partial<Record<HslBand, HslTuple>> = {};
    for (const band of HSL_BANDS) {
      const t = normalizeTuple((g.hsl as Record<string, unknown>)[band.id]);
      if (t) hsl[band.id] = t;
    }
    if (Object.keys(hsl).length) out.hsl = hsl;
  }
  if (g.preset && typeof g.preset.id === "string" && g.preset.id) {
    const amount = Math.max(
      0,
      Math.min(1, typeof g.preset.amount === "number" && Number.isFinite(g.preset.amount) ? g.preset.amount : 1)
    );
    // Amount 0 is a preset turned all the way down, still applied — the tile
    // stays picked and the intensity slider can ride back up.
    out.preset = {
      id: g.preset.id,
      ...(amount !== 1 ? { amount } : {}),
      ...(g.preset.skin ? { skin: true } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The shared numeric model behind both filter strings. */
export function deriveGrade(g: ColorGrade) {
  const b = clamp(g.brightness, GRADE_MAX);
  const c = clamp(g.contrast, GRADE_MAX);
  const s = clamp(g.saturation, GRADE_MAX);
  const e = clamp(g.exposure, GRADE_MAX);
  const t = clamp(g.temperature, GRADE_MAX) / GRADE_MAX;
  const m = clamp(g.tint, GRADE_MAX) / GRADE_MAX;
  const H = clamp(g.hue, GRADE_HUE_MAX);
  // Warm shifts red up and blue down; magenta lowers green, green raises it.
  // Gains are normalized to ≤1 (a multiply tint can only darken); the excess
  // folds into the shared gain so a cast shift keeps overall luminance
  // instead of dimming the picture.
  const gr = 1 + 0.25 * t;
  const gg = 1 - 0.2 * m;
  const gb = 1 - 0.25 * t;
  const norm = Math.max(gr, gg, gb, 1);
  return {
    gain: (1 + b / 100) * Math.pow(2, e / GRADE_MAX) * norm,
    contrast: 1 + c / 100,
    saturate: Math.max(0, 1 + s / GRADE_MAX),
    hue: H,
    tint:
      t === 0 && m === 0 ? null : { r: gr / norm, g: gg / norm, b: gb / norm },
  };
}

/** Canvas 2D `ctx.filter` value; "" when nothing applies. The warm tint is not
 * expressible as a CSS filter function — apply `gradeTint` as a multiply pass
 * after drawing with this filter. */
export function gradeToCssFilter(g: ColorGrade | undefined | null): string {
  if (isNeutralGrade(g)) return "";
  const d = deriveGrade(g!);
  const parts: string[] = [];
  if (d.gain !== 1) parts.push(`brightness(${fmt(d.gain)})`);
  if (d.contrast !== 1) parts.push(`contrast(${fmt(d.contrast)})`);
  if (d.saturate !== 1) parts.push(`saturate(${fmt(d.saturate)})`);
  if (d.hue !== 0) parts.push(`hue-rotate(${fmt(d.hue)}deg)`);
  return parts.join(" ");
}

/** CSS color for the multiply tint pass, or null when temperature is neutral. */
export function gradeTint(g: ColorGrade | undefined | null): string | null {
  if (isNeutralGrade(g)) return null;
  const tint = deriveGrade(g!).tint;
  if (!tint) return null;
  const ch = (v: number) => Math.round(255 * v);
  return `rgb(${ch(tint.r)}, ${ch(tint.g)}, ${ch(tint.b)})`;
}

/**
 * Auto grade from a frame's RGBA pixels, following the classic auto-tone
 * pipeline rather than invented heuristics:
 *
 * 1. Exposure — the photographic auto-exposure convention: map the frame's
 *    log-average (geometric mean) luminance onto 18% middle gray, projected
 *    into this pipeline's gamma-encoded gain.
 * 2. Contrast — auto-levels: clip 0.5% off each end of the luma histogram
 *    (the common editor default) and stretch what remains toward full range,
 *    projected onto the symmetric mid-gray contrast knob.
 * 3. Temperature — gray-world white balance: choose the warm/cool gains that
 *    equalize the red and blue channel means.
 *
 * Corrections are damped and capped inside the slider range so the result is
 * a starting point the user refines. Classic auto-tone leaves saturation and
 * hue alone, and so does this.
 */
export function autoGradeFromImageData(data: Uint8ClampedArray): ColorGrade | undefined {
  const hist = new Float64Array(256);
  let count = 0;
  let logSum = 0;
  let sumR = 0;
  let sumB = 0;
  let mids = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(255, Math.round(luma))]++;
    // Approximate linear luminance for the log-average (γ≈2.2 decode).
    logSum += Math.log(Math.max(1e-4, Math.pow(luma / 255, 2.2)));
    count++;
    // Cast statistics from the midtones only — near-black and clipped pixels
    // carry no reliable illuminant signal.
    if (luma >= 16 && luma <= 240) {
      sumR += r;
      sumB += b;
      mids++;
    }
  }
  if (!count) return undefined;
  const percentile = (p: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= count * p) return v;
    }
    return 255;
  };

  const grade: ColorGrade = {};
  // EV against 18% gray in linear light; our gain multiplies gamma-encoded
  // values, so one encoded stop is γ linear stops (slider v: 2^(v/50)).
  const ev = Math.log2(0.18 / Math.exp(logSum / count));
  grade.exposure = Math.round((GRADE_MAX * ev * 0.8) / 2.2);
  // Auto-levels spread after the exposure shift moves it, on encoded values.
  // A near-flat histogram (solid color, title card) carries no tonal-range
  // signal — leave contrast alone rather than stretch noise.
  const gain = Math.pow(2, grade.exposure / GRADE_MAX);
  const lo = Math.min(255, percentile(0.005) * gain);
  const hi = Math.min(255, percentile(0.995) * gain);
  if (hi - lo >= 16) {
    grade.contrast = Math.max(
      -10,
      Math.min(40, Math.round((255 / (hi - lo) - 1) * 100 * 0.6))
    );
  }
  if (mids) {
    // Gray-world: t such that the temperature gains (1±0.25t) equalize the
    // red/blue means — a blue cast warms, an orange cast cools.
    const avgR = sumR / mids;
    const avgB = sumB / mids;
    const t = (avgB - avgR) / (0.25 * (avgR + avgB));
    grade.temperature = Math.max(-40, Math.min(40, Math.round(t * 0.6 * GRADE_MAX)));
  }
  return normalizeGrade(grade);
}

/** ffmpeg filter chain with a trailing comma, ready to sit between the color
 * conversion and the terminal `format=` of a clip's core chain; "" when
 * neutral. Uses only `lutrgb` and `hue` — the bundled build has no `eq`. */
export function gradeToFfmpegFilter(g: ColorGrade | undefined | null): string {
  if (isNeutralGrade(g)) return "";
  const d = deriveGrade(g!);
  const parts: string[] = [];
  if (d.gain !== 1 || d.contrast !== 1) {
    const expr = `clip((clip(val*${fmt(d.gain)},0,255)-128)*${fmt(d.contrast)}+128,0,255)`;
    parts.push(`lutrgb=r='${expr}':g='${expr}':b='${expr}'`);
  }
  if (d.saturate !== 1 || d.hue !== 0) {
    parts.push(`hue=h=${fmt(d.hue)}:s=${fmt(d.saturate)}`);
  }
  if (d.tint) {
    const ch = (v: number) => `'clip(val*${fmt(v)},0,255)'`;
    parts.push(`lutrgb=r=${ch(d.tint.r)}:g=${ch(d.tint.g)}:b=${ch(d.tint.b)}`);
  }
  return parts.length ? parts.join(",") + "," : "";
}
