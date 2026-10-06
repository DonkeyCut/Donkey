/**
 * The assistant's overlay-animation tools — the keyframed pose track that
 * carries motion precisely, and the preset In/Out/Loop ramps the
 * `AnimationTiles` grid picks from, which compose over it. The catalog spreads
 * this list into the model's toolset and `aiTools.ts` keys its handlers on
 * `OverlayAnimationToolName`, so the style ids the model can pass are exactly
 * the ones the tiles render and a removed or renamed tool breaks the build
 * until every side catches up.
 */

import { EASE_IDS, ELEMENT_BLUR_MAX } from "@donkeycut/effects-kit";
import {
  CARET_BLINK_SECONDS,
  CARET_BLINKS_MAX,
  hitNotes,
  OVERLAY_HIT_DEFAULT_SECONDS,
  OVERLAY_HIT_MAX_SECONDS,
  OVERLAY_HIT_MIN_SECONDS,
  OVERLAY_HIT_STYLE_IDS,
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_ANIM_MIN_SECONDS,
  GLYPH_ANIM_STYLE_IDS,
  GLYPH_LOOP_STYLE_IDS,
  DIVE_ANIM_STYLE_IDS,
  edgeNotes,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_LOOP_STYLE_IDS,
  TEXT_ONLY_ANIM_STYLE_IDS,
  wordEffectCatalog,
  WORD_EFFECT_IDS,
  WORD_POP_SCALE,
  WORD_SWELL_MAX,
  WORD_SWELL_MIN,
} from "@donkeycut/effects-kit";
import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
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
      `Animate an overlay element (title, shape, or sticker): preset In/Out ramps, a Loop that runs its whole duration, and a Move that says what the element does WHILE it holds. Omitted slots keep their setting; pass "none" to clear one. In/Out styles: ${OVERLAY_ANIM_STYLE_IDS.join(", ")} — slide names are the motion direction; ${TEXT_ONLY_ANIM_STYLE_IDS.join(", ")} animate titles only; ${GLYPH_ANIM_STYLE_IDS.join(", ")} move a title's letters one at a time, and move any other kind as one piece. ${edgeNotes()} ${DIVE_ANIM_STYLE_IDS.join(", ")} as the exit is the zoom-through-a-letter transition: the shot after the element shows once the ink has filled the frame, so it needs no freeze frames, image stills or per-letter keyframes. Loop styles: ${OVERLAY_LOOP_STYLE_IDS.join(", ")} — ${GLYPH_LOOP_STYLE_IDS.join(", ")} carry a title's letters on their own delays, and carry any other kind as one piece. A move is a slot like the others and never touches the element's keyframe track; set_overlay_keyframes is the precise way to move an element and the default reach, so name a move when it is exactly what you mean — the two compose together. Word effects — words_style, titles only — play the line word by word, timed against the cut's transcript when there is one and spread across the element's own span when there is not: an emphasis travels along a line that is fully up, and a build assembles the line as it is spoken. It is the slot for "make each word pop as I say it" and for "have the words appear one by one". A typewriter entrance on a title can carry a caret: a thin bar at the end of the typed text, solid while it types, then blinking every ${CARET_BLINK_SECONDS}s — the typed comment or search box of a call-to-action card. A hit plays one motion once at a moment inside the element (hit_at seconds from its start), between its entrance and exit: ${hitNotes()}. Use press for a button being pressed, a tap on a UI element, a like or post button; pair it with a click from stock_search kind "sound" placed at the same moment when the tap should be heard.`,
    inputSchema: obj({
      id: str("Overlay element id"),
      move: {
        type: "string",
        enum: [...TEXT_MOVE_IDS],
        description: `What the element does while it holds. ${TEXT_MOVE_IDS.filter((m) => m !== "none").map((m) => `${m}: ${TEXT_MOVE_NOTES[m]}`).join(" ")}`,
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
      words_style: {
        type: "string",
        enum: [...WORD_EFFECT_IDS, "none"],
        description: `What each word does as it is said, or "none" to clear.\n${wordEffectCatalog()}`,
      },
      words_color: str("Word effect accent color (hex)"),
      words_scale: num(
        `How far a word swells at its moment, ${WORD_SWELL_MIN}..${WORD_SWELL_MAX} (pop defaults to ${WORD_POP_SCALE}, the effects that do not resize stay at 1). The swollen word takes its new width in the line, so its neighbours move aside and settle back as the emphasis travels on.`
      ),
      words_dim: num(
        "How opaque a word is off its moment, 0..1 — 0 means it is not there yet (build), a fraction leaves the line faintly visible (fill, spotlight). Effects that do not fade their words ignore it."
      ),
      caret: bool("Typewriter entrance only: show a typing caret at the end of the typed text (false removes it)"),
      caret_blink: bool("Whether the caret blinks once typing stops (default true); false holds it solid"),
      caret_blinks: num(
        `How many times the caret blinks before it stops, 1..${CARET_BLINKS_MAX}; 0 blinks for as long as the element is up (default)`
      ),
      caret_hide: bool("Remove the caret after its last blink (or right after typing when it does not blink)"),
      caret_color: str("Caret color (hex); default is the text color"),
      hit_style: {
        type: "string",
        enum: [...OVERLAY_HIT_STYLE_IDS, "none"],
        description: 'One-shot hit played once inside the element, or "none" to clear',
      },
      hit_at: num("Seconds from the element's start where the hit begins"),
      hit_seconds: num(
        `Hit length seconds ${OVERLAY_HIT_MIN_SECONDS}..${OVERLAY_HIT_MAX_SECONDS} (default ${OVERLAY_HIT_DEFAULT_SECONDS})`
      ),
      hit_darken: bool("Darken the element while the hit holds it down (default true for a new hit)"),
    }, ["id"]),
  },
  {
    name: "set_overlay_keyframes",
    description:
      `Give an overlay element a keyframed pose track — the default way to animate one, because a key names the exact pose at the exact second where a preset ramp approximates it. Each key is a whole pose at a time measured in seconds from the element's own start; the pose moves between keys along the key's ease (${EASE_IDS.join(", ")}; default linear) and holds outside them. Omitted fields on a key take the element's current value. blur softens the element (px at the 1080 short side, 0..${ELEMENT_BLUR_MAX}): keyed with opacity it is depth of field — the card being read sharp, its neighbours blurred and dimmed while a group camera (set_group_camera) pushes in. Pass an empty list to clear the track and return the element to its resting pose. Preset In/Out/Loop animation still composes on top, so a keyframed title can also fade in.`,
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
              blur: num(`Blur, px at the 1080 short side, 0..${ELEMENT_BLUR_MAX}`),
              ease: { type: "string", enum: [...EASE_IDS], description: "Curve into the next key" },
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
