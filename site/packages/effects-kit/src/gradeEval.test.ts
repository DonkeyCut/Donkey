import { describe, expect, test } from "bun:test";
import { applyLutToImageData, buildGradeLut, type GradeLut } from "./gradeLut";
import { GRADE_PRESETS, type GradePreset } from "./gradePresets";

/**
 * Color-science evals for the shipped preset catalog, in two tiers.
 *
 * The first tier is safety, held against the references colorists grade with.
 * The chart is the X-Rite ColorChecker Classic in its published sRGB
 * renderings — the card every camera and pipeline is verified against. Skin is
 * held to the vectorscope's skin-tone line, where graded skin of every
 * complexion sits in one narrow warm band and saturation pushed past it reads
 * sunburned. Levels follow broadcast practice in the spirit of EBU R103: the
 * gray ramp stays monotonic, chart blacks keep shadow detail, and a
 * white-balance cast stays in warming-gel range.
 *
 * The second tier is identity: every preset names something real — a film
 * stock, a lab process, a lighting condition — and has to measure like the
 * thing it names. A "bleach bypass" that does not retain silver, or an
 * "expired" stock with no dye crossover, is a mislabeled look however
 * pleasant it is on one frame. Each entry states its referent and the
 * signature that referent has on a chart, and the catalog is walked so a
 * preset added to the JSON must declare one.
 *
 * Both tiers measure through the preset's real lookup table with the same
 * tetrahedral pass the preview, the export, and the worker apply.
 */

/** ColorChecker Classic, sRGB. */
const CHART: Record<string, [number, number, number]> = {
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

const PATCHES = Object.keys(CHART);
const SKIN = ["darkSkin", "lightSkin"];
const COLORFUL = PATCHES.filter((n) => !/^(white|neutral|black)/.test(n) && !SKIN.includes(n));
/** The chart's gray ramp, darkest first. */
const RAMP = ["black2", "neutral35", "neutral5", "neutral65", "neutral8", "white95"];
/** A synthetic exposure ramp for tone-response readings: index 0 is black. */
const GRAY = [0, 32, 64, 128, 192, 224, 255];
const [, SHADOW, , MID, , HIGH, WHITE] = GRAY.map((_, i) => i);

const hsv = ([r, g, b]: number[]) => {
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
const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hueDelta = (a: number, b: number) => {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
};

/** Push a list of colors through a LUT with the production tetrahedral pass. */
function through(lut: GradeLut, colors: number[][]): number[][] {
  const px = new Uint8ClampedArray(colors.length * 4);
  colors.forEach((c, i) => {
    px[i * 4] = c[0];
    px[i * 4 + 1] = c[1];
    px[i * 4 + 2] = c[2];
    px[i * 4 + 3] = 255;
  });
  applyLutToImageData(px, lut);
  return colors.map((_, i) => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
}

interface Measured {
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

function measure(lut: GradeLut): Measured {
  const chart = through(
    lut,
    PATCHES.map((n) => CHART[n])
  );
  const patch: Record<string, number[]> = {};
  PATCHES.forEach((n, i) => (patch[n] = chart[i]));
  const gray = through(
    lut,
    GRAY.map((s) => [s, s, s])
  );
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

const lutOf = (p: GradePreset, extra: { amount?: number; skin?: boolean } = {}): GradeLut => {
  const lut = buildGradeLut({ preset: { id: p.id, ...extra } });
  if (!lut) throw new Error(`${p.id}: preset builds no LUT`);
  return lut;
};

const presets = Object.values(GRADE_PRESETS);
const colorPresets = presets.filter((p) => p.category !== "bw");
const bwPresets = presets.filter((p) => p.category === "bw");
/** A toning process puts one hue over the whole frame, so the rails that
 * assume the grade preserved color relationships do not apply to it. */
const isToned = (m: Measured) => m.spread <= 0.1;

/* ------------------------------------------------------------------ */
/* Tier 1: safety                                                      */
/* ------------------------------------------------------------------ */

describe("skin stays skin", () => {
  for (const p of colorPresets)
    test(p.id, () => {
      const m = measure(lutOf(p));
      for (const name of SKIN) {
        const before = hsv(CHART[name]);
        const after = hsv(m.patch[name]);
        // Saturation may deepen by at most about a fifth of the scale, and a
        // face never reads more saturated than sunburn territory.
        expect(after.s - before.s).toBeLessThanOrEqual(0.22);
        expect(after.s).toBeLessThanOrEqual(0.7);
        // While the face still carries color it holds the skin-tone line: the
        // warm band, close to where it started. A muted face may drift — with
        // little chroma its hue no longer reads — and a toned monochrome puts
        // every subject on the tone's hue by definition, so only the band
        // applies there.
        if (after.s >= 0.3) {
          expect(after.h).toBeGreaterThanOrEqual(5);
          expect(after.h).toBeLessThanOrEqual(45);
          if (!isToned(m)) expect(hueDelta(before.h, after.h)).toBeLessThanOrEqual(12);
        }
      }
    });
});

describe("saturation energy is bounded", () => {
  for (const p of colorPresets)
    test(p.id, () => {
      const m = measure(lutOf(p));
      const mults = COLORFUL.map((n) => {
        const before = hsv(CHART[n]).s;
        return before > 0.05 ? hsv(m.patch[n]).s / before : 1;
      });
      // A grade may accent a hue; it never approaches doubling one, and the
      // chart as a whole gains at most ~40%.
      expect(m.sat).toBeLessThanOrEqual(1.4);
      expect(Math.max(...mults)).toBeLessThanOrEqual(1.75);
    });
});

describe("levels hold broadcast discipline", () => {
  for (const p of presets)
    test(p.id, () => {
      const m = measure(lutOf(p));
      // The gray ramp stays monotonic — a reversal is solarization.
      const ramp = RAMP.map((n) => luma(m.patch[n]));
      for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeGreaterThanOrEqual(ramp[i - 1] - 1);
      // Chart black keeps shadow detail.
      expect(luma(m.patch.black2)).toBeGreaterThanOrEqual(12);
      // A cast on the mid grays stays in warming-gel range. A toning process
      // is a deliberate wash over the whole frame, judged by its own rail
      // below instead.
      if (!isToned(m)) {
        for (const name of ["neutral5", "neutral65"]) {
          const c = m.patch[name];
          expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(48);
        }
      }
    });
});

describe("black & white means black & white", () => {
  for (const p of bwPresets)
    test(p.id, () => {
      const m = measure(lutOf(p));
      for (const name of PATCHES) {
        const c = m.patch[name];
        expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
      }
    });
});

describe("intensity scales toward neutral", () => {
  for (const p of presets)
    test(p.id, () => {
      const full = measure(lutOf(p));
      const half = measure(lutOf(p, { amount: 0.5 }));
      // At half intensity every skin channel sits between the original and the
      // full grade (small tolerance for LUT quantization), so the slider walks
      // the look in rather than to somewhere else.
      for (const name of SKIN) {
        for (let ch = 0; ch < 3; ch++) {
          const lo = Math.min(CHART[name][ch], full.patch[name][ch]) - 6;
          const hi = Math.max(CHART[name][ch], full.patch[name][ch]) + 6;
          expect(half.patch[name][ch]).toBeGreaterThanOrEqual(lo);
          expect(half.patch[name][ch]).toBeLessThanOrEqual(hi);
        }
      }
    });
});

describe("the skin flag protects faces", () => {
  for (const p of colorPresets)
    test(p.id, () => {
      const plain = measure(lutOf(p));
      const guarded = measure(lutOf(p, { skin: true }));
      for (const name of SKIN) {
        const before = hsv(CHART[name]);
        const plainShift = Math.abs(hsv(plain.patch[name]).s - before.s);
        const guardedShift = Math.abs(hsv(guarded.patch[name]).s - before.s);
        // Protection never adds chroma shift, and where the plain grade moved
        // skin saturation meaningfully it takes most of that move off.
        expect(guardedShift).toBeLessThanOrEqual(plainShift + 0.02);
        if (plainShift > 0.1) expect(guardedShift).toBeLessThanOrEqual(plainShift * 0.6);
      }
    });
});

/* ------------------------------------------------------------------ */
/* Tier 2: identity                                                    */
/* ------------------------------------------------------------------ */

interface Signature {
  /** What this preset is emulating, in the world. */
  process: string;
  /** What emulating it has to measure like on the chart. */
  holds(m: Measured): void;
}

const IDENTITY: Record<string, Signature> = {
  /* — cinematic ---------------------------------------------------- */
  "teal-orange": {
    process: "the complementary blockbuster split: shadows toward teal, skin and highlights toward orange",
    holds: (m) => {
      expect(m.warm.s).toBeLessThanOrEqual(-15);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(30);
      expect(m.skinWarm).toBeGreaterThanOrEqual(40);
    },
  },
  "bleach-bypass": {
    process: "silver retention: the bleach step is skipped so metallic silver stays in the print — contrast climbs and color drains",
    holds: (m) => {
      expect(m.sat).toBeLessThanOrEqual(0.75);
      expect(m.slope).toBeGreaterThanOrEqual(1.15);
      expect(m.black).toBeLessThanOrEqual(10);
    },
  },
  matinee: {
    process: "an old Hollywood matinee print: bright, warm, and full-blooded in color",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(3);
      expect(m.mid).toBeGreaterThanOrEqual(130);
      expect(m.sat).toBeGreaterThanOrEqual(1.1);
    },
  },
  thriller: {
    process: "the hard, cold tension grade: contrast up, everything pulled off warm",
    holds: (m) => {
      expect(m.warm.m).toBeLessThanOrEqual(-10);
      expect(m.slope).toBeGreaterThanOrEqual(1.12);
      expect(m.black).toBeLessThanOrEqual(10);
    },
  },
  "night-market": {
    process: "a neon-lit street after dark: cool highlights over saturated signage color",
    holds: (m) => {
      expect(m.warm.h).toBeLessThanOrEqual(-6);
      expect(m.sat).toBeGreaterThanOrEqual(1.08);
    },
  },
  "sci-fi": {
    process: "cold blue-cyan futurism, the cast deepening as it climbs the range",
    holds: (m) => {
      expect(m.warm.h).toBeLessThanOrEqual(-25);
      expect(m.warm.h).toBeLessThan(m.warm.m);
    },
  },
  western: {
    process: "sun-baked dust: strongly warm, and muted by the haze rather than punchy",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.sat).toBeLessThanOrEqual(1.0);
    },
  },
  indie: {
    process: "the flat lifted-contrast indie look: milky blacks, gentle slope, drained color",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(14);
      expect(m.slope).toBeLessThanOrEqual(0.94);
      expect(m.sat).toBeLessThanOrEqual(0.82);
    },
  },

  /* — film --------------------------------------------------------- */
  "16mm": {
    process: "16mm color negative: a base-plus-fog toe, a gentle shoulder, and the stock's crossover from cool shadows into warm highlights",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(8);
      expect(m.white).toBeLessThanOrEqual(252);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(8);
      expect(m.sat).toBeLessThanOrEqual(1.05);
    },
  },
  "super-8": {
    process: "Super 8 home-movie reversal: warm, soft-shouldered, and lifted",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(14);
      expect(m.warm.m).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.0);
      expect(m.sat).toBeLessThanOrEqual(0.95);
    },
  },
  "faded-film": {
    process: "a faded release print: the cyan dye layer goes first, so the image drifts pink as it flattens",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(25);
      expect(m.slope).toBeLessThanOrEqual(0.82);
      expect(m.sat).toBeLessThanOrEqual(0.68);
      expect(m.green.m).toBeLessThanOrEqual(-4);
    },
  },
  chrome: {
    process: "Kodachrome-style reversal: dense blacks under famously rich color",
    holds: (m) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.18);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  "push-process": {
    process: "pushed development: underexposure bought back in the tank — contrast and grain climb, the toe crushes, highlights blow, and color goes flat",
    holds: (m) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.2);
      expect(m.black).toBeLessThanOrEqual(6);
      expect(m.sat).toBeLessThanOrEqual(0.96);
    },
  },
  "cine-print": {
    process: "print stock, the contrastiest link in the photochemical chain: dense blacks and controlled color",
    holds: (m) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.12);
      expect(m.black).toBeLessThanOrEqual(12);
    },
  },
  tungsten: {
    process: "daylight stock under 3200K tungsten light: a source warming the whole scene, so the cast reaches the shadows rather than washing only the highlights",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(18);
      expect(m.warm.s).toBeGreaterThanOrEqual(12);
      expect(m.warm.h - m.warm.s).toBeLessThanOrEqual(28);
    },
  },
  instant: {
    process: "integral-tripack instant film: a milky toe, muted dyes, and cool shadows running into warm highlights",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(25);
      expect(m.slope).toBeLessThanOrEqual(0.88);
      expect(m.sat).toBeLessThanOrEqual(0.72);
      expect(m.warm.s).toBeLessThan(0);
      expect(m.warm.h).toBeGreaterThanOrEqual(5);
    },
  },
  expired: {
    process: "expired stock: the emulsion layers lose sensitivity at different rates, so a green-yellow cast settles over a fogged toe",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(20);
      expect(m.green.m).toBeGreaterThanOrEqual(6);
      expect(m.sat).toBeLessThanOrEqual(0.68);
      expect(m.slope).toBeLessThanOrEqual(0.92);
    },
  },

  /* — warm --------------------------------------------------------- */
  "golden-hour": {
    process: "low sun near the horizon: warm and bright, the light itself lifting the frame",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(16);
      expect(m.mid).toBeGreaterThanOrEqual(130);
    },
  },
  amber: {
    process: "an amber wash laid over the grade, weighted to the highlights the way a gel reads rather than a room light",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(20);
      expect(m.warm.h - m.warm.s).toBeGreaterThanOrEqual(30);
    },
  },
  honey: {
    process: "a soft honeyed warmth that leaves contrast where it found it",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.slope).toBeLessThanOrEqual(1.08);
    },
  },
  sunbaked: {
    process: "hard sun on dry ground: warm and slightly bleached",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(12);
      expect(m.sat).toBeLessThanOrEqual(1.02);
    },
  },
  peach: {
    process: "a pale peach cast over a softly lifted toe",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(9);
      expect(m.black).toBeGreaterThanOrEqual(8);
    },
  },
  sepia: {
    process: "sepia toning: the print's silver is converted to silver sulfide, so the whole frame carries one brown tone rather than a tint over surviving color",
    holds: (m) => {
      expect(m.spread).toBeLessThanOrEqual(0.08);
      expect(m.warm.m).toBeGreaterThanOrEqual(28);
    },
  },
  ember: {
    process: "firelight: warm and contrasty, the glow strongest up top",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(17);
      expect(m.slope).toBeGreaterThanOrEqual(1.08);
    },
  },
  bronze: {
    process: "a burnished bronze cast, warm and slightly muted",
    holds: (m) => {
      expect(m.warm.m).toBeGreaterThanOrEqual(18);
      expect(m.sat).toBeLessThanOrEqual(1.02);
    },
  },

  /* — mood --------------------------------------------------------- */
  midnight: {
    process: "deep night: cool throughout and genuinely dark",
    holds: (m) => {
      expect(m.warm.m).toBeLessThanOrEqual(-8);
      expect(m.mid).toBeLessThanOrEqual(120);
    },
  },
  moss: {
    process: "damp woodland green, strengthening through the highlights",
    holds: (m) => {
      expect(m.green.m).toBeGreaterThanOrEqual(4);
      expect(m.green.h).toBeGreaterThanOrEqual(m.green.m);
    },
  },
  slate: {
    process: "cool grey stone: the cast pulled off warm and the color drained down",
    holds: (m) => {
      expect(m.warm.m).toBeLessThanOrEqual(-4);
      expect(m.sat).toBeLessThanOrEqual(0.85);
    },
  },
  dusk: {
    process: "the light after sundown: cool, dimming, and going magenta up top",
    holds: (m) => {
      expect(m.warm.m).toBeLessThan(0);
      expect(m.mid).toBeLessThanOrEqual(126);
    },
  },
  neon: {
    process: "neon: color pushed hard against a cool ground",
    holds: (m) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.18);
      expect(m.warm.h).toBeLessThan(0);
    },
  },
  arctic: {
    process: "cold open daylight off snow: a strong blue cast climbing with the tone",
    holds: (m) => {
      expect(m.warm.h).toBeLessThanOrEqual(-28);
      expect(m.warm.h).toBeLessThan(m.warm.m);
    },
  },
  storm: {
    process: "storm light: cool, dark, and drained",
    holds: (m) => {
      expect(m.warm.m).toBeLessThanOrEqual(-5);
      expect(m.sat).toBeLessThanOrEqual(0.96);
      expect(m.mid).toBeLessThanOrEqual(124);
    },
  },
  velvet: {
    process: "deep low-light richness: color held up while the frame sits down",
    holds: (m) => {
      expect(m.sat).toBeGreaterThanOrEqual(1.15);
      expect(m.mid).toBeLessThanOrEqual(118);
    },
  },

  /* — black & white ------------------------------------------------ */
  mono: {
    process: "a straight panchromatic conversion: neutral, with normal contrast",
    holds: (m) => {
      expect(m.black).toBeLessThanOrEqual(8);
      expect(m.slope).toBeGreaterThanOrEqual(1.0);
    },
  },
  silver: {
    process: "a silver-gelatin print: a gently lifted toe and a soft slope",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.05);
    },
  },
  ink: {
    process: "a hard graphic conversion: solid ink blacks, a steep clean slope, no veil in the toe",
    holds: (m) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.2);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  "high-key": {
    process: "high-key lighting: the whole frame carried up, shadows opened",
    holds: (m) => {
      expect(m.mid).toBeGreaterThanOrEqual(140);
      expect(m.black).toBeGreaterThanOrEqual(14);
    },
  },
  "low-key": {
    process: "low-key lighting: the frame carried down onto dense blacks",
    holds: (m) => {
      expect(m.mid).toBeLessThanOrEqual(116);
      expect(m.black).toBeLessThanOrEqual(8);
    },
  },
  charcoal: {
    process: "charcoal on paper: a lifted toe under a soft, slightly dark rendering",
    holds: (m) => {
      expect(m.black).toBeGreaterThanOrEqual(10);
      expect(m.slope).toBeLessThanOrEqual(1.0);
      expect(m.mid).toBeLessThanOrEqual(126);
    },
  },
  "soft-mono": {
    process: "a soft monochrome: low slope over an open toe",
    holds: (m) => {
      expect(m.slope).toBeLessThanOrEqual(0.92);
      expect(m.black).toBeGreaterThanOrEqual(16);
    },
  },
  grit: {
    process: "pushed reportage monochrome: steep and harsh, but grain veils the toe — a pushed negative never scans to a clean black",
    holds: (m) => {
      expect(m.slope).toBeGreaterThanOrEqual(1.15);
      expect(m.black).toBeGreaterThanOrEqual(10);
    },
  },
};

describe("every preset declares what it emulates", () => {
  test("the catalog and the identity table cover each other", () => {
    const catalog = presets.map((p) => p.id).sort();
    const declared = Object.keys(IDENTITY).sort();
    // A preset added to the JSON has to say what it is; an entry left behind
    // by a removed preset has to go with it.
    expect(declared).toEqual(catalog);
  });
});

describe("a preset measures like the thing it names", () => {
  for (const p of presets) {
    const sig = IDENTITY[p.id];
    if (!sig) continue; // the coverage test above is what reports this
    test(`${p.id} — ${sig.process}`, () => {
      sig.holds(measure(lutOf(p)));
    });
  }
});

describe("no two presets are the same look", () => {
  // The whole graded chart is the signature; two recipes that land on it
  // together are one preset wearing two names, and a shelf of those wastes
  // the user's time however good each one is on its own.
  const signature = (p: GradePreset) => {
    const lut = lutOf(p);
    return through(
      lut,
      PATCHES.map((n) => CHART[n])
    ).flat();
  };
  const signed = presets.map((p) => ({ id: p.id, sig: signature(p) }));
  for (let i = 0; i < signed.length; i++)
    for (let j = i + 1; j < signed.length; j++) {
      const a = signed[i];
      const b = signed[j];
      test(`${a.id} vs ${b.id}`, () => {
        const apart = a.sig.reduce((sum, v, k) => sum + Math.abs(v - b.sig[k]), 0) / a.sig.length;
        expect(apart).toBeGreaterThanOrEqual(3);
      });
    }
});

describe("presets in a category share its premise", () => {
  const premise: Partial<Record<GradePreset["category"], (m: Measured) => void>> = {
    // A warm preset is warm — no exceptions, that is what the shelf means.
    warm: (m) => expect(m.warm.m).toBeGreaterThanOrEqual(8),
    // A film preset emulates a stock, and a stock has a characteristic curve:
    // a toe that lifts black, a shoulder that rolls highlights, or a slope
    // away from straight-through. A recipe that only shifts color is a cast,
    // not a stock.
    film: (m) =>
      expect(m.black >= 8 || m.white <= 250 || Math.abs(m.slope - 1) >= 0.1).toBe(true),
  };
  for (const p of presets) {
    const check = premise[p.category];
    if (!check) continue;
    test(`${p.category}: ${p.id}`, () => check(measure(lutOf(p))));
  }
});
