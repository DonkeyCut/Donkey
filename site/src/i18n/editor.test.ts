import { expect, test } from "bun:test";

import { OUTPUT_SPACES } from "@donkeycut/effects-kit";
import { EXPORT_AUDIO, EXPORT_CODECS, EXPORT_QUALITIES, EXPORT_QUICK_PRESETS } from "@/cut/lib/exportClient";
import { LOUDNESS_CHOICES } from "@/cut/lib/loudnessSettings";
import { ASPECT_PRESETS } from "@/cut/lib/types";
import editor from "@/i18n/messages/en/editor.json";

// The export and aspect lists keep their English for the model; the editor
// shows the catalog's words for them, keyed by id. Each must say what its
// list says, so a new entry or a reworded one fails here until named.

test("the top bar names every aspect preset in English", () => {
  const expected = Object.fromEntries(ASPECT_PRESETS.map((p) => [p.value.replace(":", "x"), p.name]));
  expect(editor.topBar.aspects as Record<string, string>).toEqual(expected);
});

test("the export dialog names every export list in English", () => {
  const dialog = editor.exportDialog;
  expect(dialog.quickPresets as Record<string, unknown>).toEqual(
    Object.fromEntries(EXPORT_QUICK_PRESETS.map((p) => [p.id, { label: p.label, detail: p.detail }]))
  );
  expect(dialog.qualities as Record<string, unknown>).toEqual(
    Object.fromEntries(EXPORT_QUALITIES.map((q) => [q.id, { label: q.label, detail: q.detail }]))
  );
  expect(dialog.codecs as Record<string, string>).toEqual(Object.fromEntries(EXPORT_CODECS.map((c) => [c.id, c.detail])));
  expect(dialog.audioCodecs as Record<string, string>).toEqual(Object.fromEntries(EXPORT_AUDIO.map((a) => [a.id, a.detail])));
  expect(dialog.loudness as Record<string, string>).toEqual(Object.fromEntries(LOUDNESS_CHOICES.map((c) => [c.id, c.label])));
  expect(dialog.colorSpaces as Record<string, string>).toEqual(Object.fromEntries(OUTPUT_SPACES.map((o) => [o.id, o.label])));
});
