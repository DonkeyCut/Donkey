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

/** The four wheels: lift (s), gamma (m), gain (h) and offset (o); an absent
 * wheel is neutral. */
export interface GradeWheels {
  s?: WheelTuple;
  m?: WheelTuple;
  h?: WheelTuple;
  o?: WheelTuple;
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

/** A library LUT applied to the clip before the grade. `id` is the library
 * asset id (`lut:<contentKey>`); `amount` 0..1 mixes the LUT's result with
 * its input (default 1). */
export interface GradeLutRef {
  id: string;
  amount?: number;
}

/** Per-clip color adjustments. Integer sliders, 0 = neutral; every field is
 * absent when neutral, so untouched clips carry nothing. */
export interface ColorGrade {
  brightness?: number; // -50..50 (legacy; stored docs only)
  contrast?: number; // -50..50
  saturation?: number; // -50..50
  exposure?: number; // -50..50 (±2 stops)
  temperature?: number; // -50..50, positive = warm (±100 mireds)
  tint?: number; // -50..50, negative = green, positive = magenta
  hue?: number; // -180..180 degrees (legacy; stored docs only)
  highlights?: number; // -50..50
  shadows?: number; // -50..50
  whites?: number; // -50..50
  blacks?: number; // -50..50
  brilliance?: number; // -50..50
  vibrance?: number; // -50..50
  fade?: number; // 0..50, lifted blacks
  sharpen?: number; // 0..50, spatial
  clarity?: number; // 0..50, spatial
  curves?: GradeCurves;
  wheels?: GradeWheels;
  hsl?: Partial<Record<HslBand, HslTuple>>;
  preset?: GradePresetRef;
  lut?: GradeLutRef;
}

/** Slider range for every grade parameter except hue. */
export const GRADE_MAX = 50;
export const GRADE_HUE_MAX = 180;

export type GradeBasicKey =
  | "exposure"
  | "contrast"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "brilliance"
  | "fade"
  | "temperature"
  | "tint"
  | "saturation"
  | "vibrance";

/** The Basic tool's slider rows; the UI and the AI tool schema both derive
 * from this list. Legacy `brightness` and `hue` stay in the model and render
 * everywhere, surfaced by the UI only when a stored grade carries them.
 * `min` is 0 for the one-sided sliders. */
export const GRADE_BASIC_FIELDS: {
  key: GradeBasicKey;
  label: string;
  group: "light" | "color";
  min: number;
}[] = [
  { key: "exposure", label: "Exposure", group: "light", min: -GRADE_MAX },
  { key: "contrast", label: "Contrast", group: "light", min: -GRADE_MAX },
  { key: "highlights", label: "Highlights", group: "light", min: -GRADE_MAX },
  { key: "shadows", label: "Shadows", group: "light", min: -GRADE_MAX },
  { key: "whites", label: "Whites", group: "light", min: -GRADE_MAX },
  { key: "blacks", label: "Blacks", group: "light", min: -GRADE_MAX },
  { key: "brilliance", label: "Brilliance", group: "light", min: -GRADE_MAX },
  { key: "fade", label: "Fade", group: "light", min: 0 },
  { key: "temperature", label: "Temperature", group: "color", min: -GRADE_MAX },
  { key: "tint", label: "Tint", group: "color", min: -GRADE_MAX },
  { key: "saturation", label: "Saturation", group: "color", min: -GRADE_MAX },
  { key: "vibrance", label: "Vibrance", group: "color", min: -GRADE_MAX },
];

export type GradeDetailKey = "sharpen" | "clarity";

/** The spatial controls: applied on the picture after the LUT, so they are
 * left out of the LUT and its key. */
export const GRADE_DETAIL_FIELDS: { key: GradeDetailKey; label: string; min: number }[] = [
  { key: "sharpen", label: "Sharpen", min: 0 },
  { key: "clarity", label: "Clarity", min: 0 },
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

/** The wheels, in the order the tool shows them. */
export const WHEEL_ZONES = ["s", "m", "h", "o"] as const;
export type WheelZone = (typeof WHEEL_ZONES)[number];

export const WHEEL_LABELS: Record<WheelZone, string> = {
  s: "Lift",
  m: "Gamma",
  h: "Gain",
  o: "Offset",
};

/** Every scalar slider with its range: [key, min, max]. */
export const GRADE_SCALAR_FIELDS: [keyof ColorGrade & string, number, number][] = [
  ["brightness", -GRADE_MAX, GRADE_MAX],
  ["contrast", -GRADE_MAX, GRADE_MAX],
  ["saturation", -GRADE_MAX, GRADE_MAX],
  ["exposure", -GRADE_MAX, GRADE_MAX],
  ["temperature", -GRADE_MAX, GRADE_MAX],
  ["tint", -GRADE_MAX, GRADE_MAX],
  ["hue", -GRADE_HUE_MAX, GRADE_HUE_MAX],
  ["highlights", -GRADE_MAX, GRADE_MAX],
  ["shadows", -GRADE_MAX, GRADE_MAX],
  ["whites", -GRADE_MAX, GRADE_MAX],
  ["blacks", -GRADE_MAX, GRADE_MAX],
  ["brilliance", -GRADE_MAX, GRADE_MAX],
  ["vibrance", -GRADE_MAX, GRADE_MAX],
  ["fade", 0, GRADE_MAX],
  ["sharpen", 0, GRADE_MAX],
  ["clarity", 0, GRADE_MAX],
];

export type GradeScalarKey =
  | "brightness"
  | "contrast"
  | "saturation"
  | "exposure"
  | "temperature"
  | "tint"
  | "hue"
  | "highlights"
  | "shadows"
  | "whites"
  | "blacks"
  | "brilliance"
  | "vibrance"
  | "fade"
  | "sharpen"
  | "clarity";

/** The scalar fields that bake into the LUT; sharpen and clarity are spatial. */
export const GRADE_LUT_SCALAR_KEYS: GradeScalarKey[] = GRADE_SCALAR_FIELDS.map(([k]) => k as GradeScalarKey).filter(
  (k) => k !== "sharpen" && k !== "clarity"
);

const clampRange = (v: unknown, min: number, max: number) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  return Math.max(min, Math.min(max, n));
};

const CURVE_CHANNELS = ["m", "r", "g", "b"] as const;

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
    Math.round(clampRange(t[0], -max, max)),
    Math.round(clampRange(t[1], -max, max)),
    Math.round(clampRange(t[2], -max, max)),
  ];
  return out.some((v) => v !== 0) ? out : undefined;
}

export function isNeutralGrade(g: ColorGrade | undefined | null): boolean {
  return !g || normalizeGrade(g) === undefined;
}

/** True when the given Adjust tool holds a non-neutral value; drives the
 * panel's per-tool dirty dots. */
export function gradeToolDirty(
  g: ColorGrade | undefined | null,
  tool: "basic" | "curves" | "wheels" | "hsl" | "detail" | "lut"
): boolean {
  const n = normalizeGrade(g);
  if (!n) return false;
  if (tool === "curves") return !!n.curves;
  if (tool === "wheels") return !!n.wheels;
  if (tool === "hsl") return !!n.hsl;
  if (tool === "lut") return !!n.lut;
  if (tool === "detail") return GRADE_DETAIL_FIELDS.some((f) => n[f.key]);
  return GRADE_SCALAR_FIELDS.some(([k]) => k !== "sharpen" && k !== "clarity" && n[k as GradeScalarKey]);
}

/** Clamp to slider ranges, drop zeros and identity shapes; an all-neutral
 * grade becomes absent. Also the sanitizer for grades arriving as client
 * JSON. Preset and LUT ids are kept structurally — an id the running catalog
 * or library does not know renders as neutral instead of being stripped from
 * the doc. */
export function normalizeGrade(g: ColorGrade | undefined | null): ColorGrade | undefined {
  if (!g) return undefined;
  const out: ColorGrade = {};
  for (const [k, min, max] of GRADE_SCALAR_FIELDS) {
    const v = clampRange(g[k as GradeScalarKey], min, max);
    if (v !== 0) out[k as GradeScalarKey] = v;
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
  if (g.lut && typeof g.lut.id === "string" && g.lut.id) {
    const amount = Math.max(
      0,
      Math.min(1, typeof g.lut.amount === "number" && Number.isFinite(g.lut.amount) ? g.lut.amount : 1)
    );
    out.lut = { id: g.lut.id, ...(amount !== 1 ? { amount } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** The grade without its spatial controls: what the LUT bakes. */
export function gradeWithoutDetail(g: ColorGrade | undefined | null): ColorGrade | undefined {
  const n = normalizeGrade(g);
  if (!n) return undefined;
  if (!n.sharpen && !n.clarity) return n;
  const out = { ...n };
  delete out.sharpen;
  delete out.clarity;
  return Object.keys(out).length ? out : undefined;
}
