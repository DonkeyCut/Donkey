/** Per-clip manual color adjustments. Integer sliders, 0 = neutral; the whole
 * field is absent when every value is 0, so untouched clips carry nothing. */
export interface ColorGrade {
  brightness?: number; // -50..50
  contrast?: number; // -50..50
  saturation?: number; // -50..50
  exposure?: number; // -50..50 (±1 EV)
  temperature?: number; // -50..50, positive = warm
  hue?: number; // -180..180 degrees
}

/** Slider range for every grade parameter except hue. */
export const GRADE_MAX = 50;
export const GRADE_HUE_MAX = 180;

/**
 * One mapping, two renderers. The preview canvas and the export filtergraph
 * both derive from the numbers computed here, so what the sliders show is what
 * ffmpeg bakes. Brightness/exposure/contrast/temperature are per-channel
 * multiplies and a mid-gray pivot — mathematically identical on both sides;
 * saturation/hue lean on each side's native primitive (CSS saturate/hue-rotate
 * vs ffmpeg's chroma-plane `hue`), which stay visually indistinguishable over
 * these ranges.
 *
 * Application order everywhere: gain+contrast → saturation+hue → warm tint.
 */

const FIELDS: [keyof ColorGrade, number][] = [
  ["brightness", GRADE_MAX],
  ["contrast", GRADE_MAX],
  ["saturation", GRADE_MAX],
  ["exposure", GRADE_MAX],
  ["temperature", GRADE_MAX],
  ["hue", GRADE_HUE_MAX],
];

const clamp = (v: unknown, max: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(-max, Math.min(max, n));
};

const fmt = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3);

export function isNeutralGrade(g: ColorGrade | undefined | null): boolean {
  return !g || FIELDS.every(([k]) => !g[k]);
}

/** Clamp to slider ranges, drop zeros; an all-neutral grade becomes absent.
 * Also the sanitizer for grades arriving as client JSON. */
export function normalizeGrade(g: ColorGrade | undefined | null): ColorGrade | undefined {
  if (!g) return undefined;
  const out: ColorGrade = {};
  for (const [k, max] of FIELDS) {
    const v = clamp(g[k], max);
    if (v !== 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The shared numeric model behind both filter strings. */
function derive(g: ColorGrade) {
  const b = clamp(g.brightness, GRADE_MAX);
  const c = clamp(g.contrast, GRADE_MAX);
  const s = clamp(g.saturation, GRADE_MAX);
  const e = clamp(g.exposure, GRADE_MAX);
  const t = clamp(g.temperature, GRADE_MAX) / GRADE_MAX;
  const H = clamp(g.hue, GRADE_HUE_MAX);
  // Warm shifts red up and blue down. Gains are normalized to ≤1 (a multiply
  // tint can only darken); the excess folds into the shared gain so warmth
  // keeps overall luminance instead of dimming the picture.
  const gr = 1 + 0.25 * t;
  const gb = 1 - 0.25 * t;
  const norm = Math.max(gr, 1, gb);
  return {
    gain: (1 + b / 100) * Math.pow(2, e / GRADE_MAX) * norm,
    contrast: 1 + c / 100,
    saturate: Math.max(0, 1 + s / GRADE_MAX),
    hue: H,
    tint: t === 0 ? null : { r: gr / norm, g: 1 / norm, b: gb / norm },
  };
}

/** Canvas 2D `ctx.filter` value; "" when nothing applies. The warm tint is not
 * expressible as a CSS filter function — apply `gradeTint` as a multiply pass
 * after drawing with this filter. */
export function gradeToCssFilter(g: ColorGrade | undefined | null): string {
  if (isNeutralGrade(g)) return "";
  const d = derive(g!);
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
  const tint = derive(g!).tint;
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
  const d = derive(g!);
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
