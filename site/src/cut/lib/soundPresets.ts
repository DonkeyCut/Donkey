"use client";

/**
 * Named sound-quality presets, saved in the shared Library. A preset rides
 * the existing template rails: it is a library template with no media, no
 * layers and no text, carrying only a `sound` treatment — so every residency
 * stores, lists and deletes it with machinery that already exists, and a
 * preset saved on this Mac shows up beside one saved in the cloud.
 */

import { normalizeSound, type ClipSound } from "@donkeycut/effects-kit";
import { deleteTemplate, fetchLibrary, saveTemplate } from "./library";
import type { Residency } from "./residency";
import type { LibraryTemplate } from "./types";

export interface SoundPreset {
  id: string;
  name: string;
  residency: Residency;
  sound: ClipSound;
}

/** Whether a library template is a saved sound preset rather than a template
 * the user can drop on the timeline. Template surfaces filter on this so
 * presets stay in the audio inspector where they were saved. */
export function isSoundPresetTemplate(t: LibraryTemplate): boolean {
  if (!t.sound) return false;
  return !t.media.length && !t.layers.length && !t.audio.length && !t.texts.length && !t.cues.length;
}

/** Read a template as a sound preset, or null when it is an ordinary one. */
export function soundPresetOf(t: LibraryTemplate & { residency: Residency }): SoundPreset | null {
  if (!isSoundPresetTemplate(t)) return null;
  const sound = normalizeSound(t.sound);
  if (!sound) return null;
  return { id: t.id, name: t.name, residency: t.residency, sound };
}

/** Every sound preset across every reachable shelf, newest first. */
export async function listSoundPresets(): Promise<SoundPreset[]> {
  const lib = await fetchLibrary();
  return lib.templates.map(soundPresetOf).filter((p): p is SoundPreset => p !== null);
}

/** Save a treatment as a named preset on the active shelf. */
export async function saveSoundPreset(
  projectId: string,
  name: string,
  sound: ClipSound
): Promise<SoundPreset | null> {
  const normalized = normalizeSound(sound);
  if (!normalized) throw new Error("A flat treatment is nothing to save.");
  const saved = await saveTemplate(projectId, {
    name,
    duration: 0,
    media: [],
    layers: [],
    audio: [],
    texts: [],
    cues: [],
    sound: normalized,
  });
  return soundPresetOf(saved);
}

export function deleteSoundPreset(preset: SoundPreset): Promise<void> {
  return deleteTemplate(preset.residency, preset.id);
}
