import { expect, test } from "bun:test";

import {
  EDGE_IDS,
  GRADE_PRESET_CATEGORIES,
  GRADE_PRESETS,
  HIT_IDS,
  HOLD_IDS,
  LOOP_IDS,
  MOTION,
  WORD_EFFECT_IDS,
} from "@donkeycut/effects-kit";
import { SPEECH_VOICES } from "@/cut/lib/voices";
import { labelKey } from "@/i18n/labels";
import inspector from "@/i18n/messages/en/inspector.json";
import labels from "@/i18n/messages/en/labels.json";
import panels from "@/i18n/messages/en/panels.json";

// The effects-kit catalogs are JSON a new entry is added to without naming it
// anywhere else. Each name the UI shows must have a message: the grade presets
// and the holds live in the inspector catalog beside the panels that show them,
// the edges, loops, hits and word effects in the labels registry groups. A new
// preset fails here until named.

/** Every id of a catalog mapped to its English label. */
const named = (entries: [string, string][]) => Object.fromEntries(entries);

test("the color panel names every grade preset in English", () => {
  const expected = named(Object.values(GRADE_PRESETS).map((p) => [p.id, p.label]));
  expect(inspector.color.gradePresets as Record<string, string>).toEqual(expected);
});

test("the color panel names every grade preset category in English", () => {
  const expected = named(GRADE_PRESET_CATEGORIES.map((c) => [c.id, c.label]));
  expect(inspector.color.categories as Record<string, string>).toEqual(expected);
});

test("the animation tiles name every hold in English", () => {
  const expected = named(HOLD_IDS.map((id) => [id, MOTION.holds[id].label]));
  expect(inspector.holds as Record<string, string>).toEqual(expected);
});

test("the labels groups name every edge, loop, hit and word effect", () => {
  const groups: [Record<string, string>, string[]][] = [
    [labels.overlayAnim, EDGE_IDS],
    [labels.overlayLoop, LOOP_IDS],
    [labels.overlayHit, HIT_IDS],
    [labels.wordEffect, WORD_EFFECT_IDS],
  ];
  for (const [group, ids] of groups) {
    for (const id of ids) {
      expect(typeof group[labelKey(id)]).toBe("string");
    }
  }
});

test("the voice picker names every voice's style in English", () => {
  const expected = named(SPEECH_VOICES.map((v) => [v.id, v.style]));
  expect(panels.voicePicker.styles as Record<string, string>).toEqual(expected);
});
