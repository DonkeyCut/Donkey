/**
 * The assistant's overlay-animation tools — the preset In/Out/Loop ramps the
 * `AnimationTiles` grid picks from, and the keyframed pose track that lives
 * under those presets in the inspector. The catalog spreads this list into
 * the model's toolset and `aiTools.ts` keys its handlers on
 * `OverlayAnimationToolName`, so the style ids the model can pass are exactly
 * the ones the tiles render and a removed or renamed tool breaks the build
 * until every side catches up.
 */

import {
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_ANIM_MIN_SECONDS,
  GLYPH_ANIM_STYLE_IDS,
  GLYPH_LOOP_STYLE_IDS,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_LOOP_STYLE_IDS,
} from "@donkeycut/effects-kit";
import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import {
  MOVE_STRENGTH_MAX,
  MOVE_STRENGTH_MIN,
  TEXT_MOVE_IDS,
  TEXT_MOVE_NOTES,
} from "@/cut/lib/textMotion";

const RAMP_SECONDS = `${OVERLAY_ANIM_MIN_SECONDS}..${OVERLAY_ANIM_MAX_SECONDS} (default ${OVERLAY_ANIM_DEFAULT_SECONDS})`;

export const OVERLAY_ANIMATION_TOOLS = [
  {
    name: "set_overlay_animation",
    description:
      `Animate an overlay element (title, shape, or sticker): preset In/Out ramps, a Loop that runs its whole duration, and a Move that says what the element does WHILE it holds. Omitted slots keep their setting; pass "none" to clear one. In/Out styles: ${OVERLAY_ANIM_STYLE_IDS.join(", ")} — slide names are the motion direction; typewriter animates titles only; ${GLYPH_ANIM_STYLE_IDS.join(", ")} move a title's letters one at a time, and move any other kind as one piece. Loop styles: ${OVERLAY_LOOP_STYLE_IDS.join(", ")} — ${GLYPH_LOOP_STYLE_IDS.join(", ")} carry a title's letters on their own delays, and carry any other kind as one piece. A move writes the element's own keyframe pose track, so it lands as ordinary keys the user can then drag; set_overlay_keyframes replaces it when no named move fits.`,
    inputSchema: obj({
      id: str("Overlay element id"),
      move: {
        type: "string",
        enum: [...TEXT_MOVE_IDS],
        description: `What the element does while it holds, written onto its pose track. ${TEXT_MOVE_IDS.filter((m) => m !== "none").map((m) => `${m}: ${TEXT_MOVE_NOTES[m]}`).join(" ")}`,
      },
      move_strength: num(
        `How hard the move pushes, ${MOVE_STRENGTH_MIN}..${MOVE_STRENGTH_MAX} (1 = as written). Scales every offset from rest and leaves the timing alone, so the move stays on the beat.`
      ),
      in_style: {
        type: "string",
        enum: [...OVERLAY_ANIM_STYLE_IDS, "none"],
        description: 'Entrance style, or "none" to clear',
      },
      in_seconds: num(`Entrance ramp seconds ${RAMP_SECONDS}`),
      out_style: {
        type: "string",
        enum: [...OVERLAY_ANIM_STYLE_IDS, "none"],
        description: 'Exit style, or "none" to clear',
      },
      out_seconds: num(`Exit ramp seconds ${RAMP_SECONDS}`),
      loop_style: {
        type: "string",
        enum: [...OVERLAY_LOOP_STYLE_IDS, "none"],
        description: 'Loop style, or "none" to clear',
      },
      loop_speed: num("Loop rate multiplier 0.25..4 (default 1)"),
    }, ["id"]),
  },
  {
    name: "set_overlay_keyframes",
    description:
      "Give an overlay element a keyframed pose track, for motion no named move covers (a specific path across the frame, a timing tied to the footage). Each key is a whole pose at a time measured in seconds from the element's own start; the pose moves linearly between keys and holds outside them. Omitted fields on a key take the element's current value. Pass an empty list to clear the track and return the element to its resting pose. Preset In/Out/Loop animation still composes on top, so a keyframed title can also fade in.",
    inputSchema: obj(
      {
        id: str("Overlay element id"),
        keys: {
          type: "array",
          description: "Keys in any order; two at the same time collapse to one",
          items: obj(
            {
              t: num("Seconds from the element's start"),
              x: num("Center x, fraction of frame width 0..1"),
              y: num("Center y, fraction of frame height 0..1"),
              scale: num("Size multiplier, 1 = the element's own size (0.1..4)"),
              rotation: num("Degrees clockwise, -180..180"),
              opacity: num("0..1"),
            },
            ["t"]
          ),
        },
      },
      ["id", "keys"]
    ),
  },
] as const satisfies readonly AiToolDef[];

export type OverlayAnimationToolName = (typeof OVERLAY_ANIMATION_TOOLS)[number]["name"];
