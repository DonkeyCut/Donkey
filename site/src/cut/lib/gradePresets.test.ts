import { describe, expect, test } from "bun:test";
import { isGradePresetTemplate, rememberSavedGrades, savedGradeOf, savedGradesKnown } from "./gradePresets";
import type { LibraryTemplate } from "./types";

// A saved grade is a template carrying only a grade: the template shelves
// leave it out, the Color panel lists it, and the chat can name it.

const bare = (extra: Partial<LibraryTemplate>): LibraryTemplate & { residency: "cloud" } => ({
  id: "t1",
  name: "Warm",
  addedAt: 1,
  duration: 0,
  media: [],
  layers: [],
  audio: [],
  texts: [],
  cues: [],
  residency: "cloud",
  ...extra,
});

describe("saved grades", () => {
  test("a template carrying only a grade is a saved grade", () => {
    const t = bare({ grade: { temperature: 12, lut: { id: "lut:abc" } } });
    expect(isGradePresetTemplate(t)).toBe(true);
    expect(savedGradeOf(t)).toEqual({
      id: "t1",
      name: "Warm",
      residency: "cloud",
      grade: { temperature: 12, lut: { id: "lut:abc" } },
    });
  });

  test("a template with media, a sound preset or a neutral grade is not one", () => {
    expect(isGradePresetTemplate(bare({}))).toBe(false);
    expect(isGradePresetTemplate(bare({ sound: { limiter: { ceiling: -1 } } }))).toBe(false);
    expect(
      isGradePresetTemplate(
        bare({
          grade: { exposure: 3 },
          media: [{ fileName: "a.mp4", name: "a", type: "video", duration: 1 }],
        })
      )
    ).toBe(false);
    expect(savedGradeOf(bare({ grade: { exposure: 0 } }))).toBeNull();
  });

  test("the last listing is what the editor state names", () => {
    rememberSavedGrades([{ id: "g1", name: "Warm", residency: "cloud", grade: { exposure: 2 } }]);
    expect(savedGradesKnown().map((g) => g.name)).toEqual(["Warm"]);
    rememberSavedGrades([]);
    expect(savedGradesKnown()).toEqual([]);
  });
});
