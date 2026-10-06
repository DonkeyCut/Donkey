/**
 * What motion tracking can follow, and what a track can drive. The chat
 * tool's enums, its description and the inspector's picker all read these
 * lists, so a new target reaches every surface at once.
 */

export type TrackTarget = "hands_gap" | "left_hand" | "right_hand" | "head" | "person";

export const TRACK_TARGETS: {
  id: TrackTarget;
  label: string;
  /** What the tracked outline covers, for the tool description. */
  covers: string;
  /** How far the outline grows past the landmarks, as a share of its own
   * size: fingertips mark a window's corners exactly, while a hand, a head
   * and a body reach past the joints the models place. */
  pad: number;
}[] = [
  {
    id: "hands_gap",
    label: "Between hands",
    covers: "the window both hands frame, its corners on the thumb and index fingertips; it closes to nothing as the fingers meet",
    pad: 0,
  },
  {
    id: "left_hand",
    label: "Left hand",
    covers: "the hand on the left of the picture",
    pad: 0.25,
  },
  {
    id: "right_hand",
    label: "Right hand",
    covers: "the hand on the right of the picture",
    pad: 0.25,
  },
  {
    id: "head",
    label: "Head",
    covers: "the face, forehead to chin, turning with the head",
    pad: 0.12,
  },
  {
    id: "person",
    label: "Person",
    covers: "the body the pose model finds, head to the lowest visible joint",
    pad: 0.15,
  },
];

export const TRACK_TARGET_IDS: TrackTarget[] = TRACK_TARGETS.map((t) => t.id);

/** What a finished track drives: a keyed pen mask on the item, the item's
 * own position, scale and turn, or nothing — a read of where the target is. */
export type TrackUse = "mask" | "follow" | "read";

export const TRACK_USES: TrackUse[] = ["mask", "follow", "read"];

export const trackTargetOf = (id: TrackTarget) => TRACK_TARGETS.find((t) => t.id === id)!;
