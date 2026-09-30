"use client";

/**
 * Named colour grades, saved in the shared Library. A saved grade rides the
 * template rails the way a sound preset does: a library template with no
 * media, no layers and no text, carrying only a `grade` — so every shelf
 * stores, lists and deletes it with machinery that already exists, and a
 * grade saved on this Mac shows beside one saved in the cloud.
 */

import { normalizeGrade, type ColorGrade } from "@donkeycut/effects-kit";
import { deleteTemplate, fetchLibrary, saveTemplate } from "./library";
import type { Residency } from "./residency";
import type { LibraryTemplate } from "./types";

export interface SavedGrade {
  id: string;
  name: string;
  residency: Residency;
  grade: ColorGrade;
}

/** Whether a library template is a saved grade: a template surface filters
 * on this so grades stay in the Color panel where they were saved. */
export function isGradePresetTemplate(t: LibraryTemplate): boolean {
  if (!t.grade) return false;
  return !t.media.length && !t.layers.length && !t.audio.length && !t.texts.length && !t.cues.length;
}

/** Read a template as a saved grade, or null when it is an ordinary one. */
export function savedGradeOf(t: LibraryTemplate & { residency: Residency }): SavedGrade | null {
  if (!isGradePresetTemplate(t)) return null;
  const grade = normalizeGrade(t.grade);
  if (!grade) return null;
  return { id: t.id, name: t.name, residency: t.residency, grade };
}

/** The saved grades as last listed — by the Color panel's shelf read or a
 * tool — so the chat's editor_state can name them without a fetch. */
let known: SavedGrade[] = [];

export const savedGradesKnown = (): SavedGrade[] => known;

export function rememberSavedGrades(list: SavedGrade[]): void {
  known = list;
}

/** Every saved grade across every reachable shelf, newest first. */
export async function listSavedGrades(): Promise<SavedGrade[]> {
  const lib = await fetchLibrary();
  known = lib.templates.map(savedGradeOf).filter((p): p is SavedGrade => p !== null);
  return known;
}

/** Save a grade as a named preset on the active shelf. */
export async function saveGradePreset(
  projectId: string,
  name: string,
  grade: ColorGrade | undefined
): Promise<SavedGrade | null> {
  const normalized = normalizeGrade(grade);
  if (!normalized) throw new Error("A neutral grade is nothing to save.");
  const saved = await saveTemplate(projectId, {
    name,
    duration: 0,
    media: [],
    layers: [],
    audio: [],
    texts: [],
    cues: [],
    grade: normalized,
  });
  return savedGradeOf(saved);
}

export function deleteGradePreset(preset: SavedGrade): Promise<void> {
  return deleteTemplate(preset.residency, preset.id);
}
