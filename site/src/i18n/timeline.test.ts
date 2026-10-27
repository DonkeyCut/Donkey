import { expect, test } from "bun:test";

import { SPEED_CURVE_PRESETS } from "@donkeycut/effects-kit";
import { GUIDE_PRESETS } from "@/cut/lib/guides";
import timeline from "@/i18n/messages/en/timeline.json";

// The speed curve presets are a kit list a new entry is added to without
// naming it anywhere else, and the guide presets keep their English for the
// model. Each name the timeline shows must have a message that says the same;
// a new preset fails here until named.

test("the timeline catalog names every speed curve preset in English", () => {
  const expected = Object.fromEntries(SPEED_CURVE_PRESETS.map((p) => [p.id, { label: p.label, hint: p.hint }]));
  expect(timeline.speedCurve.presets as Record<string, { label: string; hint: string }>).toEqual(expected);
});

test("the timeline catalog names every guide preset in English", () => {
  const expected = Object.fromEntries(GUIDE_PRESETS.map((p) => [p.id, p.name]));
  expect(timeline.guides.presets as Record<string, string>).toEqual(expected);
});
