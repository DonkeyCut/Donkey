import { describe, expect, test } from "bun:test";
import { normalizeGrade } from "./colorGrade";
import { EFFECT_LABELS } from "./effects";
import { LOOK_LABELS } from "./looks";
import {
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESET_IDS,
  GRADE_PRESET_PARSE_ERRORS,
  GRADE_PRESETS,
  gradePresetCatalogText,
  gradePresetsInCategory,
  parseGradePresets,
} from "./gradePresets";

describe("shipped catalog", () => {
  test("every shipped JSON entry parses", () => {
    expect(GRADE_PRESET_PARSE_ERRORS).toEqual([]);
  });

  test("ids are unique", () => {
    expect(new Set(GRADE_PRESET_IDS).size).toBe(GRADE_PRESET_IDS.length);
  });

  test("every category ships 6 to 10 presets", () => {
    for (const cat of GRADE_PRESET_CATEGORIES) {
      const n = gradePresetsInCategory(cat.id).length;
      expect(n).toBeGreaterThanOrEqual(6);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  test("labels collide with no effect or look label", () => {
    const taken = new Set(
      [...Object.values(EFFECT_LABELS), ...Object.values(LOOK_LABELS)].map((l) =>
        l.toLowerCase()
      )
    );
    for (const id of GRADE_PRESET_IDS) {
      expect(taken.has(GRADE_PRESETS[id].label.toLowerCase())).toBe(false);
    }
  });

  test("every recipe is already in range: normalize is a no-op", () => {
    for (const id of GRADE_PRESET_IDS) {
      const grade = GRADE_PRESETS[id].grade;
      expect(normalizeGrade(grade)).toEqual(grade);
    }
  });

  test("catalog text names every category and preset id", () => {
    const text = gradePresetCatalogText();
    for (const cat of GRADE_PRESET_CATEGORIES) expect(text).toContain(cat.label);
    for (const id of GRADE_PRESET_IDS) expect(text).toContain(id);
  });
});

describe("parseGradePresets", () => {
  test("rejects a non-array with a reason", () => {
    const { presets, errors } = parseGradePresets({ id: "x" });
    expect(presets).toEqual([]);
    expect(errors.length).toBe(1);
  });

  test("rejects bad entries individually and keeps good ones", () => {
    const { presets, errors } = parseGradePresets([
      { id: "good-one", label: "Good One", category: "mood", grade: { contrast: 10 } },
      { id: "Bad Id", label: "X", category: "mood", grade: { contrast: 10 } },
      { id: "no-label", label: "", category: "mood", grade: { contrast: 10 } },
      { id: "bad-cat", label: "X", category: "sparkle", grade: { contrast: 10 } },
      { id: "neutral", label: "X", category: "mood", grade: { contrast: 0 } },
      { id: "nested", label: "X", category: "mood", grade: { preset: { id: "mono" } } },
      { id: "good-one", label: "Duplicate", category: "mood", grade: { contrast: 5 } },
    ]);
    expect(presets.map((p) => p.id)).toEqual(["good-one"]);
    expect(errors.length).toBe(6);
  });

  test("recipes are normalized on the way in", () => {
    const { presets } = parseGradePresets([
      { id: "clamped", label: "Clamped", category: "warm", grade: { temperature: 999, tint: 0 } },
    ]);
    expect(presets[0].grade).toEqual({ temperature: 50 });
  });
});
