import { describe, expect, test } from "bun:test";
import type { ColorGrade } from "./colorGrade";
import { gradeNeedsLut, normalizeGrade } from "./colorGrade";
import { applyLutToImageData, buildGradeLut, gradeKey, lutToCube } from "./gradeLut";
import { createGradeTransform, curveLut, scaleGradeToward, skinWeight } from "./gradeMath";

const px = (...rgb: [number, number, number][]): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(rgb.length * 4);
  rgb.forEach(([r, g, b], i) => {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  });
  return data;
};

describe("gradeKey", () => {
  test("neutral is empty, key order is stable", () => {
    expect(gradeKey(undefined)).toBe("");
    expect(gradeKey({ contrast: 0 })).toBe("");
    expect(gradeKey({ contrast: 10, exposure: 5 })).toBe(gradeKey({ exposure: 5, contrast: 10 }));
  });

  test("distinct grades get distinct keys", () => {
    expect(gradeKey({ contrast: 10 })).not.toBe(gradeKey({ contrast: 11 }));
    expect(gradeKey({ preset: { id: "mono" } })).not.toBe(gradeKey({ preset: { id: "silver" } }));
  });
});

describe("buildGradeLut", () => {
  test("neutral grade builds no LUT", () => {
    expect(buildGradeLut(undefined)).toBe(null);
    expect(buildGradeLut({ contrast: 0 })).toBe(null);
  });

  test("an identity-adjacent grade stays near identity through the LUT", () => {
    const lut = buildGradeLut({ curves: { m: [[0, 1], [128, 128], [255, 255]] } })!;
    const data = px([0, 0, 0], [128, 128, 128], [255, 255, 255], [200, 40, 90]);
    const before = [...data];
    applyLutToImageData(data, lut);
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(data[i] - before[i])).toBeLessThanOrEqual(3);
    }
  });

  test("LUT application agrees with the direct transform", () => {
    const grade: ColorGrade = {
      contrast: 20,
      exposure: 8,
      shadows: 12,
      curves: { m: [[0, 20], [128, 118], [255, 250]] },
      hsl: { blue: [10, 20, -8] },
    };
    const lut = buildGradeLut(grade)!;
    const transform = createGradeTransform(grade)!;
    const samples: [number, number, number][] = [
      [12, 40, 200],
      [128, 128, 128],
      [240, 180, 60],
      [70, 160, 90],
    ];
    const data = px(...samples);
    applyLutToImageData(data, lut);
    samples.forEach(([r, g, b], i) => {
      const direct = transform(r / 255, g / 255, b / 255);
      for (let c = 0; c < 3; c++) {
        // Tetrahedral interpolation over a 33³ lattice of a smooth transform
        // lands within a few 8-bit steps of the exact evaluation.
        expect(Math.abs(data[i * 4 + c] - direct[c] * 255)).toBeLessThanOrEqual(4);
      }
    });
  });

  test("fast-path scalar fields match the LUT within quantization", () => {
    // gain + contrast are the exact fast-path formulas; a LUT-only render of
    // them must agree with the direct math.
    const grade: ColorGrade = { exposure: 10, contrast: 15, brightness: 5 };
    const transform = createGradeTransform(grade)!;
    const gain = (1 + 5 / 100) * Math.pow(2, 10 / 50);
    const c = 1 + 15 / 100;
    for (const v of [0.1, 0.4, 0.7]) {
      const expected = Math.min(1, Math.max(0, (Math.min(1, v * gain) - 0.5) * c + 0.5));
      const got = transform(v, v, v);
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(got[ch] - expected)).toBeLessThan(1e-6);
    }
  });
});

describe("lutToCube", () => {
  test("serializes header and every node", () => {
    const lut = buildGradeLut({ contrast: 20 }, 5)!;
    const cube = lutToCube(lut);
    expect(cube).toContain("LUT_3D_SIZE 5");
    const rows = cube.trim().split("\n").filter((l) => /^[0-9]/.test(l));
    expect(rows.length).toBe(125);
    expect(rows[0].split(" ").length).toBe(3);
  });
});

describe("intensity", () => {
  test("scaling toward neutral is monotone", () => {
    const grade: ColorGrade = {
      contrast: 30,
      temperature: 20,
      curves: { m: [[0, 40], [255, 255]] },
      wheels: { s: [20, 10, 5] },
      hsl: { red: [10, 20, 0] },
    };
    const v: [number, number, number] = [0.3, 0.5, 0.6];
    const full = createGradeTransform(grade)!(...v);
    const half = createGradeTransform(scaleGradeToward(grade, 0.5))!(...v);
    const zeroish = createGradeTransform(scaleGradeToward(grade, 0.001));
    for (let c = 0; c < 3; c++) {
      const dFull = Math.abs(full[c] - v[c]);
      const dHalf = Math.abs(half[c] - v[c]);
      expect(dHalf).toBeLessThanOrEqual(dFull + 1e-6);
    }
    if (zeroish) {
      const out = zeroish(...v);
      for (let c = 0; c < 3; c++) expect(Math.abs(out[c] - v[c])).toBeLessThan(0.01);
    }
  });
});

describe("skin protection", () => {
  test("skin weight peaks on warm skin hues and dies on gray and neon", () => {
    expect(skinWeight(25, 0.3)).toBeGreaterThan(0.9);
    expect(skinWeight(25, 0.01)).toBe(0);
    expect(skinWeight(25, 0.95)).toBe(0);
    expect(skinWeight(220, 0.3)).toBe(0);
  });

  test("a skin-flagged preset damps color shifts on skin but grades the rest", () => {
    const grade: ColorGrade = { preset: { id: "teal-orange", skin: true } };
    const plain: ColorGrade = { preset: { id: "teal-orange" } };
    // A skin tone: warm orange, mid saturation.
    const skin: [number, number, number] = [0.8, 0.55, 0.42];
    const sky: [number, number, number] = [0.4, 0.6, 0.85];
    const withSkin = createGradeTransform(grade)!(...skin);
    const noSkin = createGradeTransform(plain)!(...skin);
    const dWith = Math.hypot(withSkin[0] - skin[0], withSkin[1] - skin[1], withSkin[2] - skin[2]);
    const dWithout = Math.hypot(noSkin[0] - skin[0], noSkin[1] - skin[1], noSkin[2] - skin[2]);
    expect(dWith).toBeLessThan(dWithout);
    // Non-skin pixels still take the full grade.
    const skySkin = createGradeTransform(grade)!(...sky);
    const skyPlain = createGradeTransform(plain)!(...sky);
    for (let c = 0; c < 3; c++) expect(Math.abs(skySkin[c] - skyPlain[c])).toBeLessThan(0.02);
  });
});

describe("gradeNeedsLut", () => {
  test("legacy scalar grades keep the fast path", () => {
    expect(gradeNeedsLut({ brightness: 10, contrast: -5, hue: 90, temperature: 20 })).toBe(false);
    expect(gradeNeedsLut({ tint: 10 })).toBe(false);
  });

  test("new primitives take the LUT path", () => {
    expect(gradeNeedsLut({ highlights: 5 })).toBe(true);
    expect(gradeNeedsLut({ curves: { m: [[0, 10], [255, 255]] } })).toBe(true);
    expect(gradeNeedsLut({ preset: { id: "mono" } })).toBe(true);
  });

  test("a preset turned all the way down stays applied and renders neutral", () => {
    // Intensity 0 keeps the pick (the tile stays selected, the slider can ride
    // back up) while costing the renderer nothing.
    const g = normalizeGrade({ preset: { id: "mono", amount: 0 } })!;
    expect(g.preset).toEqual({ id: "mono", amount: 0 });
    expect(gradeNeedsLut(g)).toBe(false);
    expect(buildGradeLut(g)).toBe(null);
  });
});

describe("curveLut", () => {
  test("monotone through control points without overshoot", () => {
    const lut = curveLut([
      [0, 0],
      [64, 32],
      [192, 224],
      [255, 255],
    ]);
    expect(lut[0]).toBeCloseTo(0, 3);
    expect(lut[64]).toBeCloseTo(32 / 255, 2);
    expect(lut[255]).toBeCloseTo(1, 3);
    for (let i = 1; i < 256; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1] - 1e-6);
  });
});
