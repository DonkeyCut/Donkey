import { describe, expect, test } from "bun:test";
import type { ColorGrade } from "./colorGrade";
import { createGradeTransform } from "./gradeMath";
import { type Lab, deltaE2000, displayToLab } from "./colorDifference";
import { type ClipColorRecipe, createClipTransform } from "./colorPipeline";
import { type SourceProfile, appleLogEncode, bt1886Decode } from "./colorSpace";
import { autoGrade, colorStatsFromImageData, matchGrade, recipeStatsRender } from "./gradeMatch";

/** A synthetic frame with tonal and color variety. */
function testFrame(): Uint8ClampedArray {
  const w = 64;
  const h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / (w - 1)) * 255);
      data[o + 1] = Math.round((y / (h - 1)) * 255);
      data[o + 2] = Math.round(((x + y) / (w + h - 2)) * 200 + 20);
      data[o + 3] = 255;
    }
  }
  return data;
}

/** A clip's code values rendered through its recipe with `grade`, as pixels. */
function rendered(px: Uint8ClampedArray, recipe: ClipColorRecipe, grade?: ColorGrade): Lab[] {
  const fn = createClipTransform({ ...recipe, grade });
  const out: Lab[] = [];
  for (let i = 0; i < px.length; i += 4) {
    const v = fn ? fn(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255) : [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    out.push(displayToLab(Math.round(v[0] * 255), Math.round(v[1] * 255), Math.round(v[2] * 255)));
  }
  return out;
}

const meanDeltaE = (a: Lab[], b: Lab[]) => a.reduce((s, p, i) => s + deltaE2000(p, b[i]), 0) / a.length;

const recipeFor = (profile: SourceProfile): ClipColorRecipe => ({ profile, output: "sdr", size: 0 });

describe("matchGrade", () => {
  test("a frame matched to itself is neutral", () => {
    const render = recipeStatsRender(testFrame(), recipeFor("rec709"));
    expect(matchGrade(render, render(undefined)!)).toBeUndefined();
  });

  // The eval: a reference made by grading the clip's own frame with a known
  // grade, so a perfect match exists. The fitted grade has to land the frame
  // on that reference pixel for pixel — mean CIEDE2000 under 1, below what
  // an observer sees across a cut — on Rec.709 and on Apple Log graded in
  // scene light.
  const TARGETS: ColorGrade[] = [
    { exposure: 12, temperature: 20 },
    { contrast: 25, temperature: -18, saturation: 10 },
    { exposure: -10, tint: 12, saturation: -25 },
    { highlights: -20, shadows: 15, temperature: 10 },
  ];
  for (const profile of ["rec709", "apple-log-2"] as SourceProfile[]) {
    for (const target of TARGETS) {
      test(`${profile}: recovers ${JSON.stringify(target)}`, () => {
        const px = testFrame();
        const recipe = recipeFor(profile);
        const render = recipeStatsRender(px, recipe);
        const grade = matchGrade(render, render(target)!);
        expect(grade).toBeDefined();
        expect(meanDeltaE(rendered(px, recipe, grade), rendered(px, recipe, target))).toBeLessThan(1);
      });
    }
  }

  test("strength scales every fitted slider", () => {
    const render = recipeStatsRender(testFrame(), recipeFor("rec709"));
    const reference = render({ exposure: 16, temperature: 24 })!;
    const full = matchGrade(render, reference)!;
    const half = matchGrade(render, reference, 0.5)!;
    for (const [k, v] of Object.entries(full)) {
      expect(Math.abs((half as Record<string, number>)[k] ?? 0) - Math.abs((v as number) / 2)).toBeLessThanOrEqual(0.5);
    }
    expect(matchGrade(render, reference, 0)).toBeUndefined();
  });

  test("stats read lightness and each band's cast in CIELAB", () => {
    const grey = colorStatsFromImageData(frame([119, 119, 119]))!;
    // BT.1886 code 119 is 16% luminance: L* 47.
    expect(Math.abs(grey.lightness[3] - 47)).toBeLessThan(1);
    const mid = grey.tones[1];
    expect(mid.share).toBe(1);
    expect(Math.abs(mid.a) + Math.abs(mid.b)).toBeLessThan(0.5);
    const warm = colorStatsFromImageData(frame([160, 120, 90], [40, 60, 90]))!;
    expect(warm.tones[1].b).toBeGreaterThan(10);
    expect(warm.tones[0].b).toBeLessThan(-10);
  });

  test("stats expose warmth and saturation for the assistant", () => {
    const stats = colorStatsFromImageData(testFrame())!;
    expect(stats.meanSat).toBeGreaterThan(0);
    expect(stats.warmth).toBeGreaterThan(0);
    expect(stats.luma.length).toBe(7);
  });
});

/** RGBA frame from repeating [r,g,b] pixel patterns. */
function frame(...pixels: [number, number, number][]): Uint8ClampedArray {
  const per = 64;
  const data = new Uint8ClampedArray(pixels.length * per * 4);
  pixels.forEach(([r, g, b], p) => {
    for (let i = 0; i < per; i++) {
      const o = (p * per + i) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  });
  return data;
}

const autoGrade709 = (px: Uint8ClampedArray) => autoGrade(px, recipeFor("rec709"));

describe("autoGrade", () => {
  test("a mid-gray frame needs nearly nothing", () => {
    const g = autoGrade709(frame([125, 125, 125]));
    expect(Math.abs(g?.exposure ?? 0) <= 1).toBe(true);
    expect(g?.contrast).toBeUndefined();
    expect(g?.temperature).toBeUndefined();
  });

  test("a dark frame gets pushed up toward middle gray, in stops", () => {
    const g = autoGrade709(frame([30, 30, 30], [50, 50, 50]));
    expect((g?.exposure ?? 0) > 10).toBe(true);
    expect(g?.exposure ?? 0).toBeLessThanOrEqual(50);
  });

  test("a compressed tonal range gets a contrast stretch", () => {
    const g = autoGrade709(frame([100, 100, 100], [150, 150, 150]));
    expect((g?.contrast ?? 0) > 0).toBe(true);
  });

  test("gray-world counters color casts both ways and leaves hue and saturation alone", () => {
    const cool = autoGrade709(frame([90, 120, 170]));
    expect((cool?.temperature ?? 0) > 0).toBe(true);
    const warm = autoGrade709(frame([170, 120, 90]));
    expect((warm?.temperature ?? 0) < 0).toBe(true);
    expect(cool?.saturation).toBeUndefined();
    expect(cool?.hue).toBeUndefined();
    expect(Math.abs(cool?.temperature ?? 0)).toBeLessThanOrEqual(40);
  });

  test("the fitted white balance neutralizes the cast it measured", () => {
    const cast: [number, number, number] = [150, 120, 95];
    const g = autoGrade709(frame(cast))!;
    const t = createGradeTransform({ temperature: g.temperature })!;
    const out = t(cast[0] / 255, cast[1] / 255, cast[2] / 255);
    // Damped correction: the red/blue gap closes by at least half.
    expect(Math.abs(out[0] - out[2])).toBeLessThan((cast[0] - cast[2]) / 255 / 2);
  });

  test("an empty sample yields no grade", () => {
    expect(autoGrade709(new Uint8ClampedArray(0))).toBeUndefined();
  });

  test("on Apple Log the exposure lands the rendered frame on its target in true stops", () => {
    // A flat log frame two stops under: grey card codes from a scene at 4.5%.
    const recipe = recipeFor("apple-log-2");
    const code = Math.round(appleLogEncode(0.045) * 255);
    const px = frame([code, code, code], [code + 30, code + 30, code + 30]);
    const g = autoGrade(px, recipe)!;
    const before = Math.log2(renderedLogAverage(px, recipe));
    const after = Math.log2(renderedLogAverage(px, recipe, { exposure: g.exposure }));
    const want = before + 0.8 * (Math.log2(0.18) - before);
    expect(Math.abs(after - want)).toBeLessThan(0.1);
  });
});

/** Geometric mean display luminance of a frame rendered through a recipe. */
function renderedLogAverage(px: Uint8ClampedArray, recipe: ClipColorRecipe, grade?: ColorGrade): number {
  const fn = createClipTransform({ ...recipe, grade });
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const v = fn ? fn(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255) : [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    const luma = 0.2126 * Math.round(v[0] * 255) + 0.7152 * Math.round(v[1] * 255) + 0.0722 * Math.round(v[2] * 255);
    sum += Math.log(Math.max(1e-4, bt1886Decode(luma / 255)));
    n++;
  }
  return Math.exp(sum / n);
}
