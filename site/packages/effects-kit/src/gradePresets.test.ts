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

  test("no recipe carries a LUT or a spatial control", () => {
    for (const id of GRADE_PRESET_IDS) {
      const grade = GRADE_PRESETS[id].grade;
      expect(grade.lut).toBeUndefined();
      expect(grade.sharpen).toBeUndefined();
      expect(grade.clarity).toBeUndefined();
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
      { id: "good-one", label: "Good One", category: "mood", look: "a look", grade: { contrast: 10 } },
      { id: "Bad Id", label: "X", category: "mood", look: "a look", grade: { contrast: 10 } },
      { id: "no-label", label: "", category: "mood", look: "a look", grade: { contrast: 10 } },
      { id: "bad-cat", label: "X", category: "sparkle", look: "a look", grade: { contrast: 10 } },
      { id: "neutral", label: "X", category: "mood", look: "a look", grade: { contrast: 0 } },
      { id: "nested", label: "X", category: "mood", look: "a look", grade: { preset: { id: "mono" } } },
      { id: "good-one", label: "Duplicate", category: "mood", look: "a look", grade: { contrast: 5 } },
      { id: "with-lut", label: "X", category: "mood", look: "a look", grade: { contrast: 5, lut: { id: "lut:a" } } },
      { id: "spatial", label: "X", category: "mood", look: "a look", grade: { contrast: 5, sharpen: 10 } },
      { id: "clarity", label: "X", category: "mood", look: "a look", grade: { clarity: 10 } },
      { id: "no-look", label: "X", category: "mood", grade: { contrast: 10 } },
    ]);
    expect(presets.map((p) => p.id)).toEqual(["good-one"]);
    expect(errors.length).toBe(10);
  });

  test("recipes are normalized on the way in", () => {
    const { presets } = parseGradePresets([
      { id: "clamped", label: "Clamped", category: "warm", look: "a look", grade: { temperature: 999, tint: 0 } },
    ]);
    expect(presets[0].grade).toEqual({ temperature: 50 });
  });
});
