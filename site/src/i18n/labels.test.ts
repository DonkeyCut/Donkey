import { expect, test } from "bun:test";

import {
  AUDIO_EFFECT_LABELS,
  EASE_LABELS,
  EFFECT_LABELS,
  LOOK_LABELS,
  OVERLAY_ANIM_STYLE_LABELS,
  OVERLAY_HIT_STYLE_LABELS,
  OVERLAY_LOOP_STYLE_LABELS,
  STROKE_STYLE_LABELS,
  WHEEL_LABELS,
  WORD_EFFECT_LABELS,
} from "@donkeycut/effects-kit";
import { IMAGE_ASPECT_LABEL, IMAGE_RESOLUTION_LABEL } from "@/cut/lib/imageGen";
import { RESIDENCY_LABEL } from "@/cut/lib/residency";
import { STOCK_ASPECT_LABEL } from "@/cut/lib/stock";
import { ANIM_STYLE_LABELS, SHAPE_LABELS, TIMELINE_LABELS, TRANSITION_STYLE_LABELS } from "@/cut/lib/types";
import { VIDEO_ASPECT_LABEL, VIDEO_RESOLUTION_LABEL } from "@/cut/lib/videoModels";
import { labelKey, type LabelGroup } from "@/i18n/labels";
import labels from "@/i18n/messages/en/labels.json";
import { THEME_LABELS } from "@/lib/theme";

// Each label group mirrors one registry. A new id in a registry, or a label
// reworded there, fails here until the English catalog says the same; the
// translation script then carries it to every other locale.
const REGISTRIES: Record<LabelGroup, Record<string, string>> = {
  anim: ANIM_STYLE_LABELS,
  audioEffect: AUDIO_EFFECT_LABELS,
  ease: EASE_LABELS,
  effect: EFFECT_LABELS,
  imageAspect: IMAGE_ASPECT_LABEL,
  imageResolution: IMAGE_RESOLUTION_LABEL,
  look: LOOK_LABELS,
  overlayAnim: OVERLAY_ANIM_STYLE_LABELS,
  overlayHit: OVERLAY_HIT_STYLE_LABELS,
  overlayLoop: OVERLAY_LOOP_STYLE_LABELS,
  residency: RESIDENCY_LABEL,
  shape: SHAPE_LABELS,
  stockAspect: STOCK_ASPECT_LABEL,
  strokeStyle: STROKE_STYLE_LABELS,
  theme: THEME_LABELS,
  timeline: TIMELINE_LABELS,
  transition: TRANSITION_STYLE_LABELS,
  videoAspect: VIDEO_ASPECT_LABEL,
  videoResolution: VIDEO_RESOLUTION_LABEL,
  wheel: WHEEL_LABELS,
  wordEffect: WORD_EFFECT_LABELS,
};

for (const [group, registry] of Object.entries(REGISTRIES)) {
  test(`the ${group} labels name every registry id in English`, () => {
    const expected = Object.fromEntries(Object.entries(registry).map(([id, label]) => [labelKey(id), label]));
    expect(labels[group as LabelGroup] as Record<string, string>).toEqual(expected);
  });
}
