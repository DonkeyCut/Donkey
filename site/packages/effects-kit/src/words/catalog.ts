/**
 * The word-effect catalog: every treatment a line's words can take, as data.
 *
 * The JSON beside this file holds them in the three-pose shape `types.ts`
 * describes. Every picker, tool enum and prompt line is written from these
 * entries, so an effect added to the file reaches the element panel, the
 * caption panel and the assistant at once.
 */

import effects from "./effects.json";
import type { WordEffect, WordEffectId, WordFamily, WordPose } from "./types";

export const WORD_EFFECTS: Record<string, WordEffect> = effects as unknown as Record<
  string,
  WordEffect
>;

/** The effects, in the order every picker offers them. */
export const WORD_EFFECT_IDS: WordEffectId[] = Object.keys(WORD_EFFECTS);

/** The effect an id names, or the plainest one when the id is unknown — a
 * document written against an effect since renamed still plays. */
export function wordEffect(id: WordEffectId | undefined): WordEffect {
  return WORD_EFFECTS[id ?? ""] ?? WORD_EFFECTS.color;
}

export const WORD_EFFECT_LABELS: Record<string, string> = Object.fromEntries(
  WORD_EFFECT_IDS.map((id) => [id, WORD_EFFECTS[id].label])
);

export const WORD_EFFECT_NOTES: Record<string, string> = Object.fromEntries(
  WORD_EFFECT_IDS.map((id) => [id, WORD_EFFECTS[id].note])
);

/** The catalog as a menu: id, label and line, in picker order — what the
 * element panel, the caption panel and the tool enums all list from. */
export const WORD_EFFECT_MENU: { id: WordEffectId; label: string; note: string; family: WordFamily }[] =
  WORD_EFFECT_IDS.map((id) => ({
    id,
    label: WORD_EFFECTS[id].label,
    note: WORD_EFFECTS[id].note,
    family: WORD_EFFECTS[id].family,
  }));

/** The shelves the picker lays out, with the line each one is titled by. */
export const WORD_FAMILIES: { id: WordFamily; label: string; note: string }[] = [
  {
    id: "emphasis",
    label: "Emphasis",
    note: "the treatment travels along the line, one word at a time",
  },
  { id: "build", label: "Build", note: "the line assembles itself as it is spoken" },
];

export const wordEffectIdsIn = (family: WordFamily): WordEffectId[] =>
  WORD_EFFECT_IDS.filter((id) => WORD_EFFECTS[id].family === family);

const poses = (e: WordEffect): WordPose[] => [e.before, e.active, e.after];

/** Which settings an effect actually has, so a panel offers the knobs that do
 * something and no others. `size` drives every pose scale above 1, `dim` every
 * pose opacity below 1, `color` the accent the effect runs to. A value the
 * element already carries opens its knob whatever the effect does, so a
 * setting in play is always one the reader can see and change. */
export function wordKnobs(
  e: WordEffect,
  set?: { scale?: number; dim?: number }
): { size: boolean; color: boolean; dim: boolean } {
  return {
    size: poses(e).some((p) => (p.scale ?? 1) > 1) || set?.scale !== undefined,
    color: poses(e).some((p) => (p.accent ?? 0) > 0),
    dim: poses(e).some((p) => (p.opacity ?? 1) < 1) || set?.dim !== undefined,
  };
}

/** An effect whose poses change over seconds rather than landing on the beat.
 * A ramp means the picture moves inside a word's window, so the frame
 * samplers cut it finer than one still per word. */
export const wordEffectRamps = (e: WordEffect): boolean => e.attack > 0 || e.release > 0;

/** The catalog as prompt text: one line per effect, grouped by shelf. */
export const wordEffectCatalog = (): string =>
  WORD_FAMILIES.map(
    (f) =>
      `${f.label} — ${f.note}: ${wordEffectIdsIn(f.id)
        .map((id) => `${id} (${WORD_EFFECTS[id].note})`)
        .join("; ")}`
  ).join("\n");
