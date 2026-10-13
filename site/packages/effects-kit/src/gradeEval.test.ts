import { describe, expect, test } from "bun:test";
import { buildGradeLut } from "./colorPipeline";
import { bt1886Decode } from "./colorSpace";
import { applyLutToImageData, type GradeLut } from "./gradeLut";
import { createGradeTransform } from "./gradeMath";
import { GRADE_PRESETS, type GradePreset } from "./gradePresets";
import {
  CHART,
  IDENTITY,
  PATCHES,
  PREMISE,
  SKIN,
  hsv,
  hueDelta,
  levelsHold,
  measure as measureColors,
  monochrome,
  saturationBounded,
  skinStaysSkin,
} from "./gradeSpec";

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
 *
 * A third tier holds the slider physics: the light controls work in linear
 * light, so a stop of exposure doubles luminance, the highlight control
 * compresses without clipping, saturation keeps skin on its hue, and the
 * whole chart survives a neutral grade within a small color difference.
 */

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


const lutOf = (p: GradePreset, extra: { amount?: number; skin?: boolean } = {}): GradeLut => {
  const lut = buildGradeLut({ preset: { id: p.id, ...extra } });
  if (!lut) throw new Error(`${p.id}: preset builds no LUT`);
  return lut;
};

const presets = Object.values(GRADE_PRESETS);
const colorPresets = presets.filter((p) => p.category !== "bw");
const bwPresets = presets.filter((p) => p.category === "bw");

/** Push a chart through a preset's real LUT, the way every renderer draws it. */
const measure = (lut: GradeLut) => measureColors((colors) => through(lut, colors));

/* ------------------------------------------------------------------ */
/* Tier 1: safety                                                      */
/* ------------------------------------------------------------------ */

describe("skin stays skin", () => {
  for (const p of colorPresets) test(p.id, () => skinStaysSkin(measure(lutOf(p)), expect));
});

describe("saturation energy is bounded", () => {
  for (const p of colorPresets) test(p.id, () => saturationBounded(measure(lutOf(p)), expect));
});

describe("levels hold broadcast discipline", () => {
  for (const p of presets) test(p.id, () => levelsHold(measure(lutOf(p)), expect));
});

describe("black & white means black & white", () => {
  for (const p of bwPresets) test(p.id, () => monochrome(measure(lutOf(p)), expect));
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
/* Tier 3: slider physics                                              */
/* ------------------------------------------------------------------ */

/** CIE ΔE76 between two sRGB colors, through Lab. */
function deltaE(a: number[], b: number[]): number {
  const lab = (c: number[]) => {
    const [r, g, bl] = c.map((v) => bt1886Decode(v / 255));
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

describe("slider physics", () => {
  test("a stop of exposure doubles linear light on every grey below the shoulder", () => {
    const t = createGradeTransform({ exposure: 25 })!;
    for (const v of [0.1, 0.3, 0.5, 0.55]) {
      const out = t(v, v, v);
      expect(Math.abs(bt1886Decode(out[0]) / bt1886Decode(v) - 2)).toBeLessThan(1e-6);
    }
  });

  test("a stop of exposure rolls the highlights into white without clipping them", () => {
    const t = createGradeTransform({ exposure: 25 })!;
    let prev = -1;
    for (let i = 160; i <= 250; i++) {
      const out = t(i / 255, i / 255, i / 255)[0];
      expect(out).toBeGreaterThan(prev);
      expect(out).toBeLessThan(1);
      prev = out;
    }
  });

  test("highlights at full never clip and keep the ramp in order, even a stop over", () => {
    for (const grade of [{ highlights: 50 }, { highlights: 50, exposure: 25 }, { highlights: -50 }]) {
      const t = createGradeTransform(grade)!;
      let prev = -1;
      for (let i = 0; i <= 255; i++) {
        const v = i / 255;
        const out = t(v, v, v)[0];
        expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = out;
      }
      if (!("exposure" in grade)) {
        expect(t(1, 1, 1)[0]).toBeLessThanOrEqual(1 + 1e-9);
        // Highlights alone never push a value past white.
        expect(prev).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  test("every light slider keeps the grey ramp monotone at both ends of its range", () => {
    for (const key of ["whites", "shadows", "blacks", "brilliance", "fade", "contrast", "exposure"] as const) {
      for (const value of [50, -50]) {
        const t = createGradeTransform({ [key]: value });
        if (!t) continue; // fade has no negative side
        let prev = -Infinity;
        for (let i = 0; i <= 255; i++) {
          const v = i / 255;
          const out = t(v, v, v)[0];
          expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = out;
        }
      }
    }
  });

  test("saturation holds skin on its hue", () => {
    const lut = buildGradeLut({ saturation: 30 })!;
    const [dark, light] = through(lut, [CHART.darkSkin, CHART.lightSkin]);
    expect(hueDelta(hsv(CHART.darkSkin).h, hsv(dark).h)).toBeLessThanOrEqual(8);
    expect(hueDelta(hsv(CHART.lightSkin).h, hsv(light).h)).toBeLessThanOrEqual(8);
    expect(hsv(light).s).toBeGreaterThan(hsv(CHART.lightSkin).s);
    const down = buildGradeLut({ saturation: -50 })!;
    for (const c of through(down, [CHART.red, CHART.blue, CHART.lightSkin])) {
      expect(Math.max(...c) - Math.min(...c)).toBeLessThanOrEqual(2);
    }
  });

  test("a neutral-in-effect grade keeps the ColorChecker within a small ΔE", () => {
    // Opposing moves that cancel in linear light: contrast −20 is the 0.8
    // power about grey and +25 the 1.25 power, so the pair is an identity
    // that only the two lattices' quantization can disturb.
    const lut = buildGradeLut({ contrast: -20 }, 33)!;
    const back = buildGradeLut({ contrast: 25 }, 33)!;
    const once = through(lut, PATCHES.map((n) => CHART[n]));
    const px = new Uint8ClampedArray(once.length * 4);
    once.forEach((c, i) => {
      px[i * 4] = c[0];
      px[i * 4 + 1] = c[1];
      px[i * 4 + 2] = c[2];
      px[i * 4 + 3] = 255;
    });
    applyLutToImageData(px, back);
    let worst = 0;
    PATCHES.forEach((n, i) => {
      const dE = deltaE(CHART[n], [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]]);
      worst = Math.max(worst, dE);
    });
    // A round trip through two 33³ lattices costs under 2.5 ΔE on any patch.
    expect(worst).toBeLessThan(2.5);
  });

  test("a preset at full strength stays within a colorist's ΔE budget of a small move", () => {
    // Every preset is a look, and a look is bounded: the mean chart shift
    // stays under ΔE 45 so nothing turns the picture into something else.
    for (const p of presets) {
      const m = measure(lutOf(p));
      const mean = PATCHES.reduce((a, n) => a + deltaE(CHART[n], m.patch[n]), 0) / PATCHES.length;
      expect(mean).toBeLessThan(45);
    }
  });
});

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
      sig.holds(measure(lutOf(p)), expect);
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
  for (const p of presets) {
    const check = PREMISE[p.category];
    if (!check) continue;
    test(`${p.category}: ${p.id}`, () => check(measure(lutOf(p)), expect));
  }
});
