import { describe, expect, test } from "bun:test";
import {
  GRADE_BASIC_FIELDS,
  GRADE_DETAIL_FIELDS,
  GRADE_LUT_SCALAR_KEYS,
  GRADE_SCALAR_FIELDS,
  WHEEL_ZONES,
  gradeToolDirty,
  gradeWithoutDetail,
  isNeutralGrade,
  normalizeGrade,
} from "./colorGrade";
import { gradeCssApprox } from "./gradeMath";

describe("neutrality", () => {
  test("absent, empty, and all-zero grades are neutral", () => {
    expect(isNeutralGrade(undefined)).toBe(true);
    expect(isNeutralGrade({})).toBe(true);
    expect(isNeutralGrade({ brightness: 0, hue: 0, whites: 0, fade: 0 })).toBe(true);
    expect(isNeutralGrade({ saturation: -5 })).toBe(false);
    expect(isNeutralGrade({ lut: { id: "lut:a" } })).toBe(false);
  });

  test("normalize strips zeros and collapses to undefined", () => {
    expect(normalizeGrade({ brightness: 0, contrast: 0, sharpen: 0 })).toBeUndefined();
    expect(normalizeGrade({ brightness: 10, contrast: 0 })).toEqual({ brightness: 10 });
  });

  test("normalize clamps every scalar to its own range and drops garbage input", () => {
    expect(normalizeGrade({ brightness: 999, hue: -999 })).toEqual({ brightness: 50, hue: -180 });
    expect(normalizeGrade({ fade: -20, sharpen: 80, clarity: -3, whites: 70 })).toEqual({ sharpen: 50, whites: 50 });
    expect(normalizeGrade({ contrast: Number.NaN, saturation: Infinity })).toBeUndefined();
  });

  test("normalize keeps preset and LUT references structurally", () => {
    expect(normalizeGrade({ preset: { id: "mono", amount: 0 } })).toEqual({ preset: { id: "mono", amount: 0 } });
    expect(normalizeGrade({ preset: { id: "mono", amount: 1, skin: false } })).toEqual({ preset: { id: "mono" } });
    expect(normalizeGrade({ lut: { id: "lut:a", amount: 2 } })).toEqual({ lut: { id: "lut:a" } });
    expect(normalizeGrade({ lut: { id: "lut:a", amount: 0.25 } })).toEqual({ lut: { id: "lut:a", amount: 0.25 } });
    expect(normalizeGrade({ lut: { id: "" } })).toBeUndefined();
  });

  test("normalize keeps the offset wheel and drops identity tuples", () => {
    expect(normalizeGrade({ wheels: { o: [0, 0, 0], s: [10, 0, 0] } })).toEqual({ wheels: { s: [10, 0, 0] } });
    expect(normalizeGrade({ wheels: { o: [0, 20, 0] } })).toEqual({ wheels: { o: [0, 20, 0] } });
    expect(WHEEL_ZONES).toEqual(["s", "m", "h", "o"]);
  });
});

describe("field catalogs", () => {
  test("basic and detail fields are scalar fields, and the LUT keys leave out the spatial ones", () => {
    const scalar = new Set(GRADE_SCALAR_FIELDS.map(([k]) => k));
    for (const f of GRADE_BASIC_FIELDS) expect(scalar.has(f.key)).toBe(true);
    for (const f of GRADE_DETAIL_FIELDS) expect(scalar.has(f.key)).toBe(true);
    expect(GRADE_LUT_SCALAR_KEYS).not.toContain("sharpen");
    expect(GRADE_LUT_SCALAR_KEYS).not.toContain("clarity");
    expect(GRADE_LUT_SCALAR_KEYS).toContain("exposure");
    expect(GRADE_BASIC_FIELDS.map((f) => f.key)).toEqual([
      "exposure",
      "contrast",
      "highlights",
      "shadows",
      "whites",
      "blacks",
      "brilliance",
      "fade",
      "temperature",
      "tint",
      "saturation",
      "vibrance",
    ]);
  });

  test("tool dirtiness follows the field a tool owns", () => {
    expect(gradeToolDirty({ fade: 10 }, "basic")).toBe(true);
    expect(gradeToolDirty({ fade: 10 }, "detail")).toBe(false);
    expect(gradeToolDirty({ sharpen: 10 }, "detail")).toBe(true);
    expect(gradeToolDirty({ lut: { id: "lut:a" } }, "lut")).toBe(true);
    expect(gradeToolDirty({ wheels: { o: [1, 0, 0] } }, "wheels")).toBe(true);
    expect(gradeToolDirty({ curves: { m: [[0, 10], [255, 255]] } }, "curves")).toBe(true);
    expect(gradeToolDirty({ hsl: { red: [5, 0, 0] } }, "hsl")).toBe(true);
    expect(gradeToolDirty(undefined, "basic")).toBe(false);
  });

  test("gradeWithoutDetail keeps the LUT-baked part only", () => {
    expect(gradeWithoutDetail({ sharpen: 10, clarity: 5 })).toBeUndefined();
    expect(gradeWithoutDetail({ sharpen: 10, contrast: 5 })).toEqual({ contrast: 5 });
  });
});

describe("gradeCssApprox", () => {
  test("neutral grades emit nothing", () => {
    expect(gradeCssApprox(undefined)).toEqual({ filter: "", tint: null });
    expect(gradeCssApprox({ brightness: 0 })).toEqual({ filter: "", tint: null });
  });

  test("exposure brightens, contrast and saturation map to their filters, warmth tints", () => {
    const up = gradeCssApprox({ exposure: 25 });
    expect(up.filter).toMatch(/brightness\(1\.\d+\)/);
    expect(gradeCssApprox({ exposure: -25 }).filter).toMatch(/brightness\(0\.\d+\)/);
    expect(gradeCssApprox({ contrast: 25 }).filter).toMatch(/contrast\(1\.\d+\)/);
    expect(gradeCssApprox({ saturation: -50 }).filter).toMatch(/saturate\(0\.0+\)/);
    expect(gradeCssApprox({ hue: 90 }).filter).toContain("hue-rotate(90");
    const warm = gradeCssApprox({ temperature: 50 });
    expect(warm.tint).toMatch(/^rgb\(/);
    const [r, , b] = warm.tint!.match(/\d+/g)!.map(Number);
    expect(r).toBeGreaterThan(b);
    const cool = gradeCssApprox({ temperature: -50 });
    const [cr, , cb] = cool.tint!.match(/\d+/g)!.map(Number);
    expect(cb).toBeGreaterThan(cr);
  });

  test("a monochrome preset reads as desaturated", () => {
    expect(gradeCssApprox({ preset: { id: "mono" } }).filter).toContain("saturate(0");
  });
});
