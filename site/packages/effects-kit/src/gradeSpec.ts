/**
 * The color-science spec the shipped grade presets are held to, as data the
 * tests and the preset tuner both read (gradeEval.test.ts runs it under
 * bun's expect; scripts/tune-grade-presets.ts sums how far each bound is
 * missed and fits the recipes to it). A check takes `expect` as an argument,
 * so the same lines are an assertion in a test and a penalty in a fit.
 */

import type { ColorGrade } from "./colorGrade";
import { displayToLab, labChromaHue } from "./colorDifference";
import { createClipTransform } from "./colorPipeline";
import { type OutputSpace, type SourceProfile, appleLogEncode, bt1886Encode, hlgOetf, hlgOetfInverse } from "./colorSpace";
import type { GradePreset } from "./gradePresets";
import type { ParsedLut } from "./lutFile";

export interface Expectation {
  toBe(v: unknown): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
}

export type Expect = (v: unknown) => Expectation;


/** ColorChecker Classic, sRGB. */
export const CHART: Record<string, [number, number, number]> = {
  darkSkin: [115, 82, 68],
  lightSkin: [194, 150, 130],
  blueSky: [98, 122, 157],
  foliage: [87, 108, 67],
  blueFlower: [133, 128, 177],
  bluishGreen: [103, 189, 170],
  orange: [214, 126, 44],
  purplishBlue: [80, 91, 166],
  moderateRed: [193, 90, 99],
  purple: [94, 60, 108],
  yellowGreen: [157, 188, 64],
  orangeYellow: [224, 163, 46],
  blue: [56, 61, 150],
  green: [70, 148, 73],
  red: [175, 54, 60],
  yellow: [231, 199, 31],
  magenta: [187, 86, 149],
  cyan: [8, 133, 161],
  white95: [243, 243, 242],
  neutral8: [200, 200, 200],
  neutral65: [160, 160, 160],
  neutral5: [122, 122, 121],
  neutral35: [85, 85, 85],
  black2: [52, 52, 52],
};

export const PATCHES = Object.keys(CHART);
export const SKIN = ["darkSkin", "lightSkin"];
export const COLORFUL = PATCHES.filter((n) => !/^(white|neutral|black)/.test(n) && !SKIN.includes(n));
/** The chart's gray ramp, darkest first. */
export const RAMP = ["black2", "neutral35", "neutral5", "neutral65", "neutral8", "white95"];
/** A synthetic exposure ramp for tone-response readings: index 0 is black. */
export const GRAY = [0, 32, 64, 128, 192, 224, 255];
export const [, SHADOW, , MID, , HIGH, WHITE] = GRAY.map((_, i) => i);

export const hsv = ([r, g, b]: number[]) => {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: mx ? d / mx : 0 };
};
export const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const hueDelta = (a: number, b: number) => {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
};



export interface Measured {
  /** The graded chart, by patch name. */
  patch: Record<string, number[]>;
  /** Pure black and pure white as rendered — the film toe and shoulder. */
  black: number;
  white: number;
  /** Mid gray as rendered: the look's overall level. */
  mid: number;
  /** Tone-curve slope across the middle of the range: contrast. */
  slope: number;
  /** R−B at shadow / mid / highlight. Positive is warm. */
  warm: { s: number; m: number; h: number };
  /** G − (R+B)/2 at shadow / mid / highlight. Positive is green, negative magenta. */
  green: { s: number; m: number; h: number };
  /** Mean saturation multiplier over the chart's colorful patches. */
  sat: number;
  /** Hue variety left in the chart: 1 is the full wheel, 0 is a single tone. */
  spread: number;
  /** R−B on the light-skin patch. */
  skinWarm: number;
}

export function measure(apply: (colors: number[][]) => number[][]): Measured {
  const chart = apply(PATCHES.map((n) => CHART[n]));
  const patch: Record<string, number[]> = {};
  PATCHES.forEach((n, i) => (patch[n] = chart[i]));
  const gray = apply(GRAY.map((s) => [s, s, s]));
  const warmOf = (c: number[]) => c[0] - c[2];
  const greenOf = (c: number[]) => Math.round(c[1] - (c[0] + c[2]) / 2);
  const mults = COLORFUL.map((n) => {
    const before = hsv(CHART[n]).s;
    return before > 0.05 ? hsv(patch[n]).s / before : 1;
  });
  // Circular mean of the surviving hues: a toning process collapses them all
  // onto one, which shows up here as a spread near zero.
  const hues = COLORFUL.filter((n) => hsv(patch[n]).s > 0.08).map((n) => hsv(patch[n]).h);
  const cx = hues.reduce((a, h) => a + Math.cos((h * Math.PI) / 180), 0) / (hues.length || 1);
  const cy = hues.reduce((a, h) => a + Math.sin((h * Math.PI) / 180), 0) / (hues.length || 1);
  return {
    patch,
    black: luma(gray[0]),
    white: luma(gray[WHITE]),
    mid: luma(gray[MID]),
    slope: (luma(gray[HIGH]) - luma(gray[SHADOW])) / (GRAY[HIGH] - GRAY[SHADOW]),
    warm: { s: warmOf(gray[SHADOW]), m: warmOf(gray[MID]), h: warmOf(gray[HIGH]) },
    green: { s: greenOf(gray[SHADOW]), m: greenOf(gray[MID]), h: greenOf(gray[HIGH]) },
    sat: mults.reduce((a, b) => a + b, 0) / mults.length,
    spread: 1 - Math.hypot(cx, cy),
    skinWarm: warmOf(patch.lightSkin),
  };
}

/** A toning process puts one hue over the whole frame, so the rails that
 * assume the grade preserved color relationships do not apply to it. */
export const isToned = (m: Measured) => m.spread <= 0.1;

/* ------------------------------------------------------------------ */
/* Tier 1: safety                                                      */
/* ------------------------------------------------------------------ */

/** Skin chroma a look may add, as a multiple of the face's own. */
export const SKIN_CHROMA_GAIN_MAX = 1.35;
/** Degrees of Lab hue a colored face may move off where it started. */
export const SKIN_HUE_DRIFT_MAX = 10;

/** Measured in CIELAB, where the chart's skin patches sit on the skin-tone
 * line near a 45° hue angle. A face may warm or cool along that line and
 * gain at most a third more chroma; past that it reads sunburned or painted.
 * While the face still carries color it holds the line. A muted face may
 * drift — with little chroma its hue no longer reads — and a toned
 * monochrome puts every subject on the tone's hue by definition. */
export function skinStaysSkin(m: Measured, expect: Expect): void {
  for (const name of SKIN) {
    const before = labChromaHue(displayToLab(...CHART[name]));
    const after = labChromaHue(displayToLab(...(m.patch[name] as [number, number, number])));
    expect(after.c / before.c).toBeLessThanOrEqual(SKIN_CHROMA_GAIN_MAX);
    if (after.c >= before.c * 0.6 && !isToned(m)) {
      expect(hueDelta(before.h, after.h)).toBeLessThanOrEqual(SKIN_HUE_DRIFT_MAX);
    }
  }
}

/** A grade may accent a hue; it never approaches doubling one, and the chart
 * as a whole gains at most ~40%. */
export function saturationBounded(m: Measured, expect: Expect): void {
  const mults = COLORFUL.map((n) => {
    const before = hsv(CHART[n]).s;
    return before > 0.05 ? hsv(m.patch[n]).s / before : 1;
  });
  expect(m.sat).toBeLessThanOrEqual(1.4);
  expect(Math.max(...mults)).toBeLessThanOrEqual(1.75);
}

/** The gray ramp stays monotonic — a reversal is solarization — chart black
 * keeps shadow detail, and a cast on the mid grays stays in warming-gel
 * range. A toning process is a deliberate wash, judged by its own rail. */
export function levelsHold(m: Measured, expect: Expect): void {
  const ramp = RAMP.map((n) => luma(m.patch[n]));
  for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThanOrEqual(ramp[i - 1] - 1);
  expect(luma(m.patch.black2)).toBeGreaterThanOrEqual(12);
  if (isToned(m)) return;
  for (const name of ["neutral5", "neutral65"]) {
    const c = m.patch[name];
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(48);
  }
}

/** Black and white carries no color on any patch. */
export function monochrome(m: Measured, expect: Expect): void {
  for (const name of PATCHES) {
    const c = m.patch[name];
    expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
  }
}

/* ------------------------------------------------------------------ */
/* Tier 2: identity                                                    */
/* ------------------------------------------------------------------ */


export interface Signature {
  /** What this preset is emulating, in the world. */
  process: string;
  /** What emulating it has to measure like on the chart. */
  holds(m: Measured, expect: Expect): void;
}

export const IDENTITY: Record<string, Signature> = {
  /* — cinematic ---------------------------------------------------- */
  "teal-orange": {
    process: "the complementary blockbuster split: shadows toward teal, skin and highlights toward orange",
    holds: (m, expect) => {
      expect(m.warm.s).toBeLessThanOrEqual(-15);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(30);
      expect(m.skinWarm).toBeGreaterThanOrEqual(40);
    },
  },
  "bleach-bypass": {
    process: "silver retention: the bleach step is skipped so metallic silver stays in the print — contrast climbs and color drains",
    holds: (m, expect) => {
      expect(m.sat).toBeLessThanOrEqual(0.75);
      expect(m.slope).toBeGreaterThanOrEqual(1.15);
      expect(m.black).toBeLessThanOrEqual(10);
    },
  },
  matinee: {
    process: "an old Hollywood matinee print: bright, warm, and full-blooded in color",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(3);
      expect(m.mid).toBeGreaterThanOrEqual(130);
      expect(m.sat).toBeGreaterThanOrEqual(1.1);
    },
  },
  thriller: {
    process: "the hard, cold tension grade: contrast up, everything pulled off warm",
    holds: (m, expect) => {
      expect(m.warm.m).toBeLessThanOrEqual(-10);
      expect(m.slope).toBeGreaterThanOrEqual(1.12);
      expect(m.black).toBeLessThanOrEqual(10);
    },
  },
  "night-market": {
    process: "a neon-lit street after dark: cool highlights over saturated signage color",
    holds: (m, expect) => {
      expect(m.warm.h).toBeLessThanOrEqual(-6);
      expect(m.sat).toBeGreaterThanOrEqual(1.08);
    },
  },
  "sci-fi": {
    process: "cold blue-cyan futurism, the cast deepening as it climbs the range",
    holds: (m, expect) => {
      expect(m.warm.h).toBeLessThanOrEqual(-25);
      expect(m.warm.h).toBeLessThan(m.warm.m);
    },
  },
  western: {
    process: "sun-baked dust: strongly warm, and muted by the haze",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.sat).toBeLessThanOrEqual(1.0);
    },
  },
  indie: {
    process: "the flat lifted-contrast indie look: milky blacks, gentle slope, drained color",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(14);
      expect(m.slope).toBeLessThanOrEqual(0.94);
      expect(m.sat).toBeLessThanOrEqual(0.82);
    },
  },

  /* — film --------------------------------------------------------- */
  "16mm": {
    process: "16mm color negative: a base-plus-fog toe, a gentle shoulder, and the stock's crossover from cool shadows into warm highlights",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(8);
      expect(m.white).toBeLessThanOrEqual(252);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(8);
      expect(m.sat).toBeLessThanOrEqual(1.05);
    },
  },
  "super-8": {
    process: "Super 8 home-movie reversal: warm, soft-shouldered, and lifted",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(14);
      expect(m.warm.m).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.0);
      expect(m.sat).toBeLessThanOrEqual(0.95);
    },
  },
  "faded-film": {
    process: "a faded release print: the cyan dye layer goes first, so the image drifts pink as it flattens",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(25);
      expect(m.slope).toBeLessThanOrEqual(0.82);
      expect(m.sat).toBeLessThanOrEqual(0.68);
      expect(m.green.m).toBeLessThanOrEqual(-4);
    },
  },
  chrome: {
    process: "Kodachrome-style reversal: dense blacks under famously rich color",
    holds: (m, expect) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.18);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  "push-process": {
    process: "pushed development: underexposure bought back in the tank — contrast and grain climb, the toe crushes, highlights blow, and color goes flat",
    holds: (m, expect) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.2);
      expect(m.black).toBeLessThanOrEqual(6);
      expect(m.sat).toBeLessThanOrEqual(0.96);
    },
  },
  "cine-print": {
    process: "print stock, the contrastiest link in the photochemical chain: dense blacks and controlled color",
    holds: (m, expect) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.12);
      expect(m.black).toBeLessThanOrEqual(12);
    },
  },
  tungsten: {
    process: "daylight stock under 3200K tungsten light: a source warming the whole scene, so the cast reaches down into the shadows",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(18);
      expect(m.warm.s).toBeGreaterThanOrEqual(12);
      expect(m.warm.h - m.warm.s).toBeLessThanOrEqual(28);
    },
  },
  instant: {
    process: "integral-tripack instant film: a milky toe, muted dyes, and cool shadows running into warm highlights",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(25);
      expect(m.slope).toBeLessThanOrEqual(0.88);
      expect(m.sat).toBeLessThanOrEqual(0.72);
      expect(m.warm.s).toBeLessThan(0);
      expect(m.warm.h).toBeGreaterThanOrEqual(5);
    },
  },
  expired: {
    process: "expired stock: the emulsion layers lose sensitivity at different rates, so a green-yellow cast settles over a fogged toe",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(20);
      expect(m.green.m).toBeGreaterThanOrEqual(6);
      expect(m.sat).toBeLessThanOrEqual(0.68);
      expect(m.slope).toBeLessThanOrEqual(0.92);
    },
  },

  /* — warm --------------------------------------------------------- */
  "golden-hour": {
    process: "low sun near the horizon: warm and bright, the light itself lifting the frame",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(16);
      expect(m.mid).toBeGreaterThanOrEqual(130);
    },
  },
  amber: {
    process: "an amber wash laid over the grade, weighted to the highlights the way a gel reads",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(20);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(30);
    },
  },
  honey: {
    process: "a soft honeyed warmth that leaves contrast where it found it",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.slope).toBeLessThanOrEqual(1.08);
    },
  },
  sunbaked: {
    process: "hard sun on dry ground: warm and slightly bleached",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.sat).toBeLessThanOrEqual(1.02);
    },
  },
  peach: {
    process: "a pale peach cast over a softly lifted toe",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(9);
      expect(m.black).toBeGreaterThanOrEqual(8);
    },
  },
  sepia: {
    process: "sepia toning: the print's silver is converted to silver sulfide, so the whole frame carries one brown tone",
    holds: (m, expect) => {
      expect(m.spread).toBeLessThanOrEqual(0.08);
      expect(m.warm.m).toBeGreaterThanOrEqual(28);
    },
  },
  ember: {
    process: "firelight: warm and contrasty, the glow strongest up top",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(17);
      expect(m.slope).toBeGreaterThanOrEqual(1.08);
    },
  },
  bronze: {
    process: "a burnished bronze cast, warm and slightly muted",
    holds: (m, expect) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(18);
      expect(m.sat).toBeLessThanOrEqual(1.02);
    },
  },

  /* — mood --------------------------------------------------------- */
  midnight: {
    process: "deep night: cool throughout and genuinely dark",
    holds: (m, expect) => {
      expect(m.warm.m).toBeLessThanOrEqual(-8);
      expect(m.mid).toBeLessThanOrEqual(120);
    },
  },
  moss: {
    process: "damp woodland green, strengthening through the highlights",
    holds: (m, expect) => {
      expect(m.green.m).toBeGreaterThanOrEqual(4);
      expect(m.green.h).toBeGreaterThanOrEqual(m.green.m);
    },
  },
  slate: {
    process: "cool grey stone: the cast pulled off warm and the color drained down",
    holds: (m, expect) => {
      expect(m.warm.m).toBeLessThanOrEqual(-4);
      expect(m.sat).toBeLessThanOrEqual(0.85);
    },
  },
  dusk: {
    process: "the light after sundown: cool, dimming, and going magenta up top",
    holds: (m, expect) => {
      expect(m.warm.m).toBeLessThan(0);
      expect(m.mid).toBeLessThanOrEqual(126);
    },
  },
  neon: {
    process: "neon: color pushed hard against a cool ground",
    holds: (m, expect) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.18);
      expect(m.warm.h).toBeLessThan(0);
    },
  },
  arctic: {
    process: "cold open daylight off snow: a strong blue cast climbing with the tone",
    holds: (m, expect) => {
      expect(m.warm.h).toBeLessThanOrEqual(-28);
      expect(m.warm.h).toBeLessThan(m.warm.m);
    },
  },
  storm: {
    process: "storm light: cool, dark, and drained",
    holds: (m, expect) => {
      expect(m.warm.m).toBeLessThanOrEqual(-5);
      expect(m.sat).toBeLessThanOrEqual(0.96);
      expect(m.mid).toBeLessThanOrEqual(124);
    },
  },
  velvet: {
    process: "deep low-light richness: color held up while the frame sits down",
    holds: (m, expect) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.15);
      expect(m.mid).toBeLessThanOrEqual(118);
    },
  },

  /* — black & white ------------------------------------------------ */
  mono: {
    process: "a straight panchromatic conversion: neutral, with normal contrast",
    holds: (m, expect) => {
      expect(m.black).toBeLessThanOrEqual(8);
      expect(m.slope).toBeGreaterThanOrEqual(1.0);
    },
  },
  silver: {
    process: "a silver-gelatin print: a gently lifted toe and a soft slope",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.05);
    },
  },
  ink: {
    process: "a hard graphic conversion: solid ink blacks, a steep clean slope, no veil in the toe",
    holds: (m, expect) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.2);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  "high-key": {
    process: "high-key lighting: the whole frame carried up, shadows opened",
    holds: (m, expect) => {
      expect(m.mid).toBeGreaterThanOrEqual(140);
      expect(m.black).toBeGreaterThanOrEqual(14);
    },
  },
  "low-key": {
    process: "low-key lighting: the frame carried down onto dense blacks",
    holds: (m, expect) => {
      expect(m.mid).toBeLessThanOrEqual(116);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  charcoal: {
    process: "charcoal on paper: a lifted toe under a soft, slightly dark rendering",
    holds: (m, expect) => {
      expect(m.black).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.0);
      expect(m.mid).toBeLessThanOrEqual(126);
    },
  },
  "soft-mono": {
    process: "a soft monochrome: low slope over an open toe",
    holds: (m, expect) => {
      expect(m.slope).toBeLessThanOrEqual(0.92);
      expect(m.black).toBeGreaterThanOrEqual(16);
    },
  },
  grit: {
    process: "pushed reportage monochrome: steep and harsh, but grain veils the toe — a pushed negative never scans to a clean black",
    holds: (m, expect) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.15);
      expect(m.black).toBeGreaterThanOrEqual(10);
    },
  },
};

/** What every preset on a shelf shares. A warm preset is warm — that is what
 * the shelf means. A film preset emulates a stock, and a stock has a
 * characteristic curve: a toe that lifts black, a shoulder that rolls
 * highlights, or a slope away from straight-through; a recipe that only
 * shifts color is a cast. */
export const PREMISE: Partial<Record<GradePreset["category"], (m: Measured, expect: Expect) => void>> = {
  warm: (m, expect) => expect(m.warm.m).toBeGreaterThanOrEqual(8),
  // The best of the three, each as its share of the way past its bound.
  film: (m, expect) =>
    expect(Math.max((m.black - 8) / 8, (250 - m.white) / 5, (Math.abs(m.slope - 1) - 0.1) / 0.1)).toBeGreaterThanOrEqual(0),
};

/* ------------------------------------------------------------------ */
/* Range                                                               */
/* ------------------------------------------------------------------ */

/**
 * Range retention: a look may move tones anywhere it likes, but it may not
 * throw picture away. A grey ramp in stops about 18% grey runs through the
 * real clip transform for each source; the window is every stop the ungraded
 * rendering shows as gradation — between near-black and near-white, at least
 * WINDOW_SLOPE code values per stop — and a grade loses the stops of that
 * window it pushes onto the floor or the ceiling of the 8-bit output. A hard clip or crush is exactly that loss; a soft shoulder or toe
 * keeps the stops, only closer together.
 */

const FLOOR = 2 / 255;
const CEILING = 253 / 255;
const WINDOW_LO = 8 / 255;
const WINDOW_HI = 250 / 255;
/** Gradation the base must show for a stop to count: 2 code values. */
const WINDOW_SLOPE = 2 / 255;
const STEP = 0.05;
/** A fold below a 10-bit step is invisible: a quarter of an 8-bit code. */
const FOLD_MAX = 0.25 / 255;
/** BT.2408 grey in an HLG signal. */
const HLG_GREY = 0.38;
/** The stops a look may give up in the visible window. */
export const LOOK_LOSS_MAX = 0.5;

/** Code value of a scene or display grey `stops` from 18% grey, per source. */
function rampCode(profile: SourceProfile, stops: number): number {
  const lin = 0.18 * 2 ** stops;
  if (profile === "apple-log" || profile === "apple-log-2") return appleLogEncode(lin);
  if (profile === "hlg") return hlgOetf(Math.min(1, hlgOetfInverse(HLG_GREY) * 2 ** stops));
  return bt1886Encode(Math.min(1, lin));
}

export function rangeRamp(profile: SourceProfile, output: OutputSpace, grade?: ColorGrade, lut?: ParsedLut): number[] {
  const t = createClipTransform({ profile, output, size: 33, ...(grade ? { grade } : {}) }, lut);
  const out: number[] = [];
  for (let s = -12; s <= 9 + 1e-9; s += STEP) {
    const c = rampCode(profile, s);
    out.push(t ? t(c, c, c)[1] : c);
  }
  return out;
}

/** Stops of the base window the graded ramp floors or ceilings. */
export function stopsLost(base: number[], graded: number[]): number {
  let lost = 0;
  for (let i = 1; i < base.length; i++) {
    if (base[i] < WINDOW_LO || base[i] > WINDOW_HI) continue;
    if ((base[i] - base[i - 1]) / STEP < WINDOW_SLOPE) continue;
    if (graded[i] <= FLOOR || graded[i] >= CEILING) lost += STEP;
  }
  return lost;
}

export function isMonotone(values: number[]): boolean {
  return values.every((v, i) => i === 0 || v >= values[i - 1] - FOLD_MAX);
}
