import { holdMoveKeys, HOLD_IDS, MOTION } from "@donkeycut/effects-kit";
import type { OverlayAnim, OverlayKey } from "@donkeycut/effects-kit";

/**
 * Named moves for text.
 *
 * Preset In/Out ramps decide how a line ARRIVES. These decide what it does
 * while it holds — the push-in that never stops, the drift across the frame,
 * the swing that overshoots and settles. That is the difference between text
 * that appears and text that is alive.
 *
 * A move lives in the element's `anim.move` slot beside In/Out/Loop and is
 * evaluated internally with them. The keyframe pose track stays the user's
 * own tier: picking a move never writes keys. Docs saved when moves shipped
 * as sampled key tracks still carry those keys; `liftMoveTracks` recognizes
 * them on load and lifts each into the slot.
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

/** The legacy pose track for a named move on an element resting at `rest`
 * for `dur` seconds, scaled by `strength` — the shape moves were saved in
 * when they wrote keys. Regenerated only to recognize old tracks on load. */
export function textMoveKeys(
  id: string | undefined,
  rest: { x: number; y: number; rotation: number },
  dur: number,
  strength = 1
): OverlayKey[] | undefined {
  if (!id || id === "none") return undefined;
  return holdMoveKeys(id, rest, dur, strength);
}

/** Which move wrote a legacy pose track, and at what strength. The answer is
 * found by regenerating each move and seeing which one matches, so keys the
 * user has since dragged simply stop matching and stay theirs. */
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

/**
 * Lift legacy move key tracks into the `anim.move` slot on load. An element
 * whose `kf` regenerates exactly from one named move at one strength was
 * written by the old move picker, so it drops the keys and carries the move
 * in its slot; any other track is the user's own and is left alone.
 */
export function liftMoveTracks<
  T extends {
    kf?: OverlayKey[];
    anim?: OverlayAnim;
    x: number;
    y: number;
    rotation?: number;
    start: number;
    end: number;
  },
>(overlays: T[]): T[] {
  if (!overlays.some((o) => o.kf && o.kf.length > 0 && !o.anim?.move)) return overlays;
  return overlays.map((o) => {
    if (!o.kf || o.kf.length === 0 || o.anim?.move) return o;
    const m = matchTextMove(o.kf, { x: o.x, y: o.y, rotation: o.rotation ?? 0 }, o.end - o.start);
    if (!m) return o;
    return {
      ...o,
      kf: undefined,
      anim: { ...(o.anim ?? {}), move: { style: m.id, strength: m.strength } },
    };
  });
}
