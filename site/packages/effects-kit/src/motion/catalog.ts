/**
 * The motion catalog: every animation in the app, as data.
 *
 * The three JSON files beside this one hold them in the After Effects
 * text-animator shape — keyframed properties plus a range selector — which is
 * what Lottie serializes and what GSAP and Motion reimplement as split-text
 * stagger. They are split the way they are used: edges are the entrances and
 * exits, loops run for as long as the element does, holds are the moves a
 * pose track is written from. Adding one means adding an entry to its file;
 * no code lists them.
 */

import edges from "./edges.json";
import loops from "./loops.json";
import holds from "./holds.json";
import type { MotionCatalog, MotionPreset, MotionSlot } from "./types";

export const MOTION: MotionCatalog = {
  version: 1,
  edges,
  loops,
  holds,
} as unknown as MotionCatalog;

export const edgePreset = (id: string): MotionPreset | undefined => MOTION.edges[id];
export const loopPreset = (id: string): MotionPreset | undefined => MOTION.loops[id];
export const holdPreset = (id: string): MotionPreset | undefined => MOTION.holds[id];

export const EDGE_IDS = Object.keys(MOTION.edges);
export const LOOP_IDS = Object.keys(MOTION.loops);
export const HOLD_IDS = Object.keys(MOTION.holds);

/** The entrances and exits that move a title character by character. */
export const PER_UNIT_EDGE_IDS = EDGE_IDS.filter((id) => !!MOTION.edges[id].selector);
/** The loops that carry a title's characters on their own delays. */
export const PER_UNIT_LOOP_IDS = LOOP_IDS.filter((id) => !!MOTION.loops[id].selector);

/** Every preset that may fill a slot, for menus and tool enums. */
export function presetsFor(slot: MotionSlot): { id: string; preset: MotionPreset }[] {
  const group = slot === "loop" ? MOTION.loops : slot === "hold" ? MOTION.holds : MOTION.edges;
  return Object.entries(group)
    .filter(([, p]) => p.slots.includes(slot))
    .map(([id, preset]) => ({ id, preset }));
}
