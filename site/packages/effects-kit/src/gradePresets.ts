/**
 * The color preset catalog: JSON configs the grading engine interprets. Each
 * preset is a named ColorGrade recipe; a clip stores only the preset's id
 * (plus amount and the skin flag), and the renderer expands it through
 * gradeMath. The JSON files beside this one under presets/ are the shipped
 * catalog; parseGradePresets is the one doorway for that data, so a grade a
 * user imports or shares later travels as the same document and enters
 * through the same validation.
 */

import { type ColorGrade, normalizeGrade } from "./colorGrade";
import cinematic from "./presets/cinematic.json";
import film from "./presets/film.json";
import warm from "./presets/warm.json";
import mood from "./presets/mood.json";
import bw from "./presets/bw.json";

export type GradePresetCategory = "cinematic" | "film" | "warm" | "mood" | "bw";

export const GRADE_PRESET_CATEGORIES: { id: GradePresetCategory; label: string }[] = [
  { id: "cinematic", label: "Cinematic" },
  { id: "film", label: "Film" },
  { id: "warm", label: "Warm" },
  { id: "mood", label: "Mood" },
  { id: "bw", label: "B&W" },
];

export interface GradePreset {
  id: string;
  label: string;
  category: GradePresetCategory;
  grade: ColorGrade;
}

const CATEGORY_IDS = new Set(GRADE_PRESET_CATEGORIES.map((c) => c.id));

/**
 * Interpret preset JSON. Every entry is checked structurally and its recipe
 * run through normalizeGrade; a bad entry is rejected with a reason and never
 * partially applied. Recipes may not nest a preset reference.
 */
export function parseGradePresets(json: unknown): { presets: GradePreset[]; errors: string[] } {
  const presets: GradePreset[] = [];
  const errors: string[] = [];
  if (!Array.isArray(json)) {
    return { presets, errors: ["preset config must be a JSON array"] };
  }
  const seen = new Set<string>();
  json.forEach((entry, i) => {
    const at = `entry ${i}`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: not an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    const id = e.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      errors.push(`${at}: id must be a kebab-case string`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${at}: duplicate id "${id}"`);
      return;
    }
    if (typeof e.label !== "string" || !e.label.trim()) {
      errors.push(`"${id}": label must be a non-empty string`);
      return;
    }
    if (typeof e.category !== "string" || !CATEGORY_IDS.has(e.category as GradePresetCategory)) {
      errors.push(`"${id}": category must be one of ${[...CATEGORY_IDS].join(", ")}`);
      return;
    }
    if (!e.grade || typeof e.grade !== "object") {
      errors.push(`"${id}": grade must be an object`);
      return;
    }
    if ((e.grade as ColorGrade).preset) {
      errors.push(`"${id}": a preset recipe cannot reference another preset`);
      return;
    }
    const grade = normalizeGrade(e.grade as ColorGrade);
    if (!grade) {
      errors.push(`"${id}": grade is neutral or carries no known fields`);
      return;
    }
    seen.add(id);
    presets.push({
      id,
      label: e.label.trim(),
      category: e.category as GradePresetCategory,
      grade,
    });
  });
  return { presets, errors };
}

const shipped = parseGradePresets([...cinematic, ...film, ...warm, ...mood, ...bw]);

/** The shipped catalog, by id. A unit test holds the JSON files to zero
 * parse errors; at runtime bad entries are simply absent. */
export const GRADE_PRESETS: Record<string, GradePreset> = Object.fromEntries(
  shipped.presets.map((p) => [p.id, p])
);

export const GRADE_PRESET_IDS: string[] = shipped.presets.map((p) => p.id);

/** Parse errors from the shipped JSON, surfaced for the catalog test. */
export const GRADE_PRESET_PARSE_ERRORS: string[] = shipped.errors;

export function gradePresetsInCategory(category: GradePresetCategory): GradePreset[] {
  return shipped.presets.filter((p) => p.category === category);
}

/** One line per category, for the AI tool description: the catalog teaches
 * itself from the JSON. */
export function gradePresetCatalogText(): string {
  return GRADE_PRESET_CATEGORIES.map(
    (c) =>
      `${c.label}: ${gradePresetsInCategory(c.id)
        .map((p) => `${p.id} (${p.label})`)
        .join(", ")}`
  ).join("; ");
}
