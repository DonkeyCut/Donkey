import { holdMoveKeys, HOLD_IDS, MOTION } from "@donkeycut/effects-kit";
import type { OverlayKey } from "@donkeycut/effects-kit";

/**
 * Named keyframe moves for text.
 *
 * Preset In/Out ramps decide how a line ARRIVES. These decide what it does
 * while it holds — the push-in that never stops, the drift across the frame,
 * the swing that overshoots and settles. That is the difference between text
 * that appears and text that is alive.
 *
 * A move is not a special mechanism: it is an entry in the same motion
 * catalog every entrance and loop lives in, sampled against the element's
 * resting pose into the ordinary `kf` track a user could have keyed by hand.
 */

export type TextMoveId = string;

export const TEXT_MOVE_IDS: TextMoveId[] = ["none", ...HOLD_IDS];

export const TEXT_MOVE_NOTES: Record<string, string> = {
  none: "Holds its resting pose.",
  ...Object.fromEntries(HOLD_IDS.map((id) => [id, MOTION.holds[id].note ?? MOTION.holds[id].label])),
};

/** How far a move may be scaled from the shape it is written at. */
export const MOVE_STRENGTH_MIN = 0.25;
export const MOVE_STRENGTH_MAX = 2;
export const MOVE_STRENGTH_STEP = 0.05;

/** The strengths the panel's slider can land on — what a saved track is
 * matched against when the panel works out which move wrote it. */
export const MOVE_STRENGTHS: number[] = Array.from(
  { length: Math.round((MOVE_STRENGTH_MAX - MOVE_STRENGTH_MIN) / MOVE_STRENGTH_STEP) + 1 },
  (_, i) => Math.round((MOVE_STRENGTH_MIN + i * MOVE_STRENGTH_STEP) * 100) / 100
);

/** The pose track for a named move on an element resting at `rest` for
 * `dur` seconds, scaled by `strength`. An unknown id, "none", or a duration
 * too short to read gives back no track at all. */
export function textMoveKeys(
  id: string | undefined,
  rest: { x: number; y: number; rotation: number },
  dur: number,
  strength = 1
): OverlayKey[] | undefined {
  if (!id || id === "none") return undefined;
  return holdMoveKeys(id, rest, dur, strength);
}

/** Which move wrote a pose track, and at what strength. Nothing is stored on
 * the element: the answer is found by regenerating each move and seeing which
 * one matches, so keys the user has since dragged simply stop matching. */
export function matchTextMove(
  kf: OverlayKey[] | undefined,
  rest: { x: number; y: number; rotation: number },
  dur: number
): { id: string; strength: number } | undefined {
  if (!kf || kf.length === 0) return undefined;
  // Gentle moves — a float, a breath — travel so little that several
  // neighbouring strengths all sit inside any usable tolerance, so the answer
  // is the closest candidate rather than the first one that fits.
  const cost = (a: OverlayKey, b: OverlayKey) =>
    Math.abs(a.t - b.t) / 0.01 +
    Math.abs(a.x - b.x) / 0.002 +
    Math.abs(a.y - b.y) / 0.002 +
    Math.abs(a.scale - b.scale) / 0.005 +
    Math.abs(a.rotation - b.rotation) / 0.25 +
    Math.abs(a.opacity - b.opacity) / 0.005;
  // Strength scales every offset from rest and leaves the times alone, so
  // each move is generated once and the candidates are read off that one
  // track rather than built again per strength.
  const at = (u: OverlayKey, k: number): OverlayKey => ({
    t: u.t,
    x: rest.x + (u.x - rest.x) * k,
    y: rest.y + (u.y - rest.y) * k,
    scale: 1 + (u.scale - 1) * k,
    rotation: rest.rotation + (u.rotation - rest.rotation) * k,
    opacity: 1 + (u.opacity - 1) * k,
  });
  let best: { id: string; strength: number } | undefined;
  let bestCost = 1; // one tolerance unit, summed across every key and channel
  for (const id of HOLD_IDS) {
    const unit = textMoveKeys(id, rest, dur, 1);
    if (unit?.length !== kf.length) continue;
    for (const strength of MOVE_STRENGTHS) {
      let total = 0;
      for (let i = 0; i < unit.length && total < bestCost; i++)
        total += cost(at(unit[i], strength), kf[i]);
      if (total < bestCost) {
        bestCost = total;
        best = { id, strength };
      }
    }
  }
  return best;
}

/** The moves as prompt text: one line per id. */
export const textMoveCatalog = (): string =>
  HOLD_IDS.map((id) => `- ${id}: ${TEXT_MOVE_NOTES[id]}`).join("\n");
