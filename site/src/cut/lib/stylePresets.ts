"use client";

/**
 * Named text-style presets, saved in the shared Library. A preset rides the
 * existing template rails: it is a library template with no media and exactly
 * one text overlay — the style carrier — so both residencies store, list,
 * and delete it with machinery that already exists. The localStorage style in
 * textStyle.ts stays what it was: the implicit "last used" style.
 */

import { pickTextStyle, TEXT_STYLE_FIELDS } from "@donkeycut/effects-kit";
import { deleteTemplate, fetchLibrary, saveTemplate } from "./library";
import type { Residency } from "./residency";
import type { TextStyle } from "./textStyle";
import {
  isTextOverlay,
  type LibraryTemplate,
  type TextOverlay,
} from "./types";

export interface StylePreset {
  id: string;
  name: string;
  residency: Residency;
  style: TextStyle;
}

/** The carrier's element id, which is what marks a template as a preset. Real
 * overlays carry a `uid()`, so the two never collide and a user's own
 * single-title template stays an ordinary template. */
const CARRIER_ID = "style";

/** Whether a library template is a saved style rather than a template the user
 * can drop on the timeline. Template surfaces filter on this so presets stay
 * in the text inspector where they were saved. */
export function isStylePresetTemplate(t: LibraryTemplate): boolean {
  if (t.media.length || t.layers.length || t.audio.length || t.cues.length) return false;
  if (t.texts.length !== 1) return false;
  const carrier = t.texts[0];
  return isTextOverlay(carrier) && carrier.id === CARRIER_ID;
}

/** Read a template as a style preset, or null when it is an ordinary one. */
export function presetOf(t: LibraryTemplate & { residency: Residency }): StylePreset | null {
  if (!isStylePresetTemplate(t)) return null;
  const carrier = t.texts[0] as TextOverlay;
  return { id: t.id, name: t.name, residency: t.residency, style: pickTextStyle(carrier) };
}

/** Every style preset across both shelves, newest first. */
export async function listStylePresets(): Promise<StylePreset[]> {
  const lib = await fetchLibrary();
  return lib.templates
    .map(presetOf)
    .filter((p): p is StylePreset => p !== null);
}

/** Whether a title already wears a preset's look, field for field. A field
 * the preset leaves unset matches a title that leaves it unset too. */
export function styleMatches(style: TextStyle, overlay: TextOverlay): boolean {
  const own = pickTextStyle(overlay);
  return TEXT_STYLE_FIELDS.every((f) => sameValue(style[f], own[f]));
}

/** Two stored values are equal whatever order their keys come back in (a
 * cloud shelf's jsonb reorders them); a key set to undefined is absent, as it
 * is once stored. Arrays keep their order. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((k) => sameValue(left[k], right[k]));
}

/** Save the given title's look as a named preset on the active shelf. */
export async function saveStylePreset(
  projectId: string,
  name: string,
  overlay: TextOverlay
): Promise<StylePreset | null> {
  const carrier: TextOverlay = {
    id: CARRIER_ID,
    kind: "text",
    text: "Aa",
    start: 0,
    end: 3,
    x: 0.5,
    y: 0.5,
    ...pickTextStyle(overlay),
  };
  const saved = await saveTemplate(projectId, {
    name,
    duration: 3,
    media: [],
    layers: [],
    audio: [],
    texts: [carrier],
    cues: [],
  });
  return presetOf(saved);
}

/** Overwrite a preset with the given title's look, keeping its name. Every
 * shelf already saves and deletes templates, so the new look lands on the
 * active shelf and the old preset comes off once it has. */
export async function updateStylePreset(
  projectId: string,
  preset: StylePreset,
  overlay: TextOverlay
): Promise<StylePreset | null> {
  const next = await saveStylePreset(projectId, preset.name, overlay);
  await deleteStylePreset(preset);
  return next;
}

export function deleteStylePreset(preset: StylePreset): Promise<void> {
  return deleteTemplate(preset.residency, preset.id);
}
