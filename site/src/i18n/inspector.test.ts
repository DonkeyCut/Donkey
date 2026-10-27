import { expect, test } from "bun:test";

import {
  GRADE_BASIC_FIELDS,
  GRADE_DETAIL_FIELDS,
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESETS,
  GLITCH_KINDS,
  HSL_BANDS,
  LEAK_COURSES,
  MASK_SHAPES,
  MOTION,
  OUTPUT_SPACES,
  SOUND_PRESETS,
  SOURCE_PROFILES,
  TEXT_TEXTURES,
  TEXT_WEIGHTS,
  WORD_FAMILIES,
  ZOOM_LEVELS,
} from "@donkeycut/effects-kit";
import { COLOR_PRESETS } from "@/cut/components/ColorField";
import { BUILTIN_LUTS } from "@/cut/lib/builtinLuts";
import { TEXT_LOOKS } from "@/cut/lib/textLooks";
import { LAYOUTS } from "@/cut/lib/types";
import inspector from "@/i18n/messages/en/inspector.json";

// The inspector names these lists by id in its own catalog. A new id in a
// list, or a name reworded there, fails here until the English catalog says
// the same; the translation script then carries it to every other locale.
const byId = <T,>(list: readonly T[], id: (x: T) => string, label: (x: T) => string) =>
  Object.fromEntries(list.map((x) => [id(x), label(x)]));

const LISTS: [string, Record<string, string>, Record<string, string>][] = [
  ["holds", byId(Object.entries(MOTION.holds), ([id]) => id, ([, p]) => p.label ?? ""), inspector.holds],
  ["text looks", byId(Object.values(TEXT_LOOKS), (l) => l.id, (l) => l.label), inspector.textLooks],
  ["grade presets", byId(Object.values(GRADE_PRESETS), (p) => p.id, (p) => p.label), inspector.color.gradePresets],
  ["grade categories", byId(GRADE_PRESET_CATEGORIES, (c) => c.id, (c) => c.label), inspector.color.categories],
  ["built-in LUTs", byId(BUILTIN_LUTS, (l) => l.id, (l) => l.label), inspector.color.builtinLuts],
  ["source profiles", byId(SOURCE_PROFILES, (p) => p.id, (p) => p.label), inspector.color.sourceProfiles],
  ["output spaces", byId(OUTPUT_SPACES, (o) => o.id, (o) => o.label), inspector.color.outputSpaces],
  ["hue bands", byId(HSL_BANDS, (b) => b.id, (b) => b.label), inspector.color.hslBands],
  ["sound presets", byId(SOUND_PRESETS, (p) => p.id, (p) => p.name), inspector.sound.presets],
  ["mask shapes", byId(MASK_SHAPES, (s) => s.id, (s) => s.label), inspector.mask.shapes],
  ["zoom levels", byId(ZOOM_LEVELS, (l) => l.id, (l) => l.label), inspector.effect.zoomLevels],
  ["word families", byId(WORD_FAMILIES, (f) => f.id, (f) => f.label), inspector.animationTiles.wordFamilies],
  ["color presets", byId(COLOR_PRESETS, (c) => c.id, (c) => c.name), inspector.colorField.presets],
  ["layouts", byId(Object.entries(LAYOUTS), ([id]) => id, ([, l]) => l.label), inspector.layout.layouts],
];

for (const [name, registry, catalog] of LISTS) {
  test(`the ${name} are named in the inspector catalog`, () => {
    expect(catalog).toEqual(registry);
  });
}

// Lists whose English lives only in the catalog: every id has a name.
const KEYED: [string, readonly (string | number)[], Record<string, string>][] = [
  ["grade fields", [...GRADE_BASIC_FIELDS, ...GRADE_DETAIL_FIELDS].map((f) => f.key), inspector.color.fields],
  ["glitch kinds", ["mix", ...GLITCH_KINDS], inspector.effect.glitchKinds],
  ["leak courses", LEAK_COURSES, inspector.effect.leakCourses],
  ["text textures", ["none", ...TEXT_TEXTURES], inspector.text.textures],
  ["text weights", TEXT_WEIGHTS, inspector.text.weights],
];

for (const [name, ids, catalog] of KEYED) {
  test(`every one of the ${name} has a name`, () => {
    expect(ids.map(String).filter((id) => !(id in catalog))).toEqual([]);
  });
}
