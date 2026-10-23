/**
 * The assistant's overlay-animation tools — the keyframed pose track that
 * carries motion precisely, and the preset In/Out/Loop ramps the
 * `AnimationTiles` grid picks from, which compose over it. The catalog spreads
 * this list into the model's toolset and `aiTools.ts` keys its handlers on
 * `OverlayAnimationToolName`, so the style ids the model can pass are exactly
 * the ones the tiles render and a removed or renamed tool breaks the build
 * until every side catches up.
 */

import { CAMERA_WORLD_MAX, CAMERA_WORLD_MIN, EASE_IDS, EDGE_STAGGER_MAX, ELEMENT_BLUR_MAX, TILT_MAX } from "@donkeycut/effects-kit";
import {
  CYCLE_HOLD_MAX,
  CYCLE_SCALE_MAX,
  CYCLE_SCALE_MIN,
  FONT_CYCLE_FACES_MAX,
  FONT_CYCLE_RATE,
  FONT_CYCLE_RATE_MAX,
  FONT_CYCLE_RATE_MIN,
  TEXT_WEIGHTS,
  CARET_BLINK_SECONDS,
  CARET_BLINKS_MAX,
  hitNotes,
  OVERLAY_HIT_DEFAULT_SECONDS,
  OVERLAY_HIT_MAX_SECONDS,
  OVERLAY_HIT_MIN_SECONDS,
  OVERLAY_HIT_STYLE_IDS,
  OVERLAY_ANIM_DEFAULT_SECONDS,
  OVERLAY_ANIM_MAX_SECONDS,
  OVERLAY_GLYPH_ANIM_MAX_SECONDS,
  EDGE_BLUR_MAX,
  EDGE_DISTANCE_MAX,
  EDGE_ORDERS,
  edgeMaxSeconds,
  OVERLAY_ANIM_MIN_SECONDS,
  GLYPH_ANIM_STYLE_IDS,
  GLYPH_LOOP_STYLE_IDS,
  LOOP_PERIODS,
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
import { OVERLAY_KEY_POS_MAX, OVERLAY_KEY_POS_MIN } from "@/cut/lib/types";
import {
  MOVE_STRENGTH_MAX,
  MOVE_STRENGTH_MIN,
  TEXT_MOVE_IDS,
  TEXT_MOVE_NOTES,
} from "@/cut/lib/textMotion";

// Styles that may run past the shared cap say how far, e.g. "; count up to 10".
const LONG_RAMPS =
  OVERLAY_ANIM_STYLE_IDS.filter(
    (id) => edgeMaxSeconds(id) !== OVERLAY_ANIM_MAX_SECONDS && edgeMaxSeconds(id) !== OVERLAY_GLYPH_ANIM_MAX_SECONDS
  )
    .map((id) => `; ${id} up to ${edgeMaxSeconds(id)}`)
    .join("") + `; the per-letter styles up to ${OVERLAY_GLYPH_ANIM_MAX_SECONDS}`;
const RAMP_SECONDS = `${OVERLAY_ANIM_MIN_SECONDS}..${OVERLAY_ANIM_MAX_SECONDS} (default ${OVERLAY_ANIM_DEFAULT_SECONDS}${LONG_RAMPS})`;

/** The loop rate multiplier's range: at the top a spin turns twice a second,
 * fast enough for a loading spinner. */
export const LOOP_SPEED_MIN = 0.25;
export const LOOP_SPEED_MAX = 8;

// Each loop's cycle at speed 1, e.g. "spin 4s", so a rate can be set from a measured one.
const LOOP_CYCLES = OVERLAY_LOOP_STYLE_IDS.map((id) => `${id} ${LOOP_PERIODS[id]}s`).join(", ");

export const OVERLAY_ANIMATION_TOOLS = [
  {
    name: "set_overlay_animation",
    description:
      `Animate an overlay element (title, shape, or sticker): preset In/Out ramps, a Loop that runs its whole duration, and a Move that says what the element does WHILE it holds. Omitted slots keep their setting; pass "none" to clear one. In/Out styles: ${OVERLAY_ANIM_STYLE_IDS.join(", ")} — slide names are the motion direction; ${TEXT_ONLY_ANIM_STYLE_IDS.join(", ")} animate titles only; ${GLYPH_ANIM_STYLE_IDS.join(", ")} move a title's letters one at a time, and move any other kind as one piece; in_stagger/out_stagger set how much of their ramp the hand-off from the first letter to the last takes, so a 1.6s drop at stagger 0.8 lands a letter every ~0.27s, each moving for ~0.3s. in_order/out_order "shuffle" deals the letters their turns in a scattered order instead of left to right — letters landing at random; in_sequence names the exact order when it is read off a reference. in_ease sets the curve the move travels on, in_fade false keeps letters solid while they fall, and in_blur starts each letter out of focus (design px) to sharpen as it lands. in_distance/out_distance set how far the motion travels from rest, design px. A reference's letters coming in are read in one call, never by eye: track_element match letters with the line's words over the stretch they come in returns \`entrance\`, every one of these settings as it goes in (in_style, in_seconds, in_stagger, in_sequence, in_sequence_at — each letter's own turn — in_distance, in_ease, in_fade — false, a share of the move, or true — and in_blur) and the source second the ramp starts — one letter's move is in_seconds × (1 − in_stagger). A per-letter ramp on an element with update_overlay motion_blur streaks each letter along its own move, the smear a fast fall wears — a different look from a soft start. ${edgeNotes()} ${DIVE_ANIM_STYLE_IDS.join(", ")} as the exit is the zoom-through-a-letter transition: the shot after the element shows once the ink has filled the frame, so it needs no freeze frames, image stills or per-letter keyframes. Loop styles: ${OVERLAY_LOOP_STYLE_IDS.join(", ")} — ${GLYPH_LOOP_STYLE_IDS.join(", ")} carry a title's letters on their own delays, and carry any other kind as one piece. A move is a slot like the others and never touches the element's keyframe track; set_overlay_keyframes is the precise way to move an element and the default reach, so name a move when it is exactly what you mean — the two compose together. Word effects — words_style, titles only — play the line word by word, timed against the cut's transcript when there is one and spread across the element's own span when there is not: an emphasis travels along a line that is fully up, and a build assembles the line as it is spoken. It is the slot for "make each word pop as I say it" and for "have the words appear one by one". A typewriter entrance on a title can carry a caret: a thin bar at the end of the typed text, solid while it types, then blinking every ${CARET_BLINK_SECONDS}s — the typed comment or search box of a call-to-action card. A hit plays one motion once at a moment inside the element (hit_at seconds from its start), between its entrance and exit: ${hitNotes()}. Use press for a button being pressed, a tap on a UI element, a like or post button; pair it with a click from stock_search kind "sound" placed at the same moment when the tap should be heard. A font cycle flickers a title through typefaces — a new face font_cycle_rate times a second, from font_cycle_at for font_cycle_seconds — and then the title settles back into its own face: the typeface-shuffle beat of a teaser title. Give each face a scale (and tracking) so it fills about the room the title's own face does; a wide tracked title cycling through condensed or hand-drawn faces wants tracking 0 and a scale above 1 on them. A face keeps the title's own line breaks: where its scale makes a line wider than the room the title wraps in, that face is set smaller to fit rather than broken onto another line. Time the faces to the music with font_cycle_beats — a new face on each beat of that clip's detect_beats grid, font_cycle_beat_step 2 for every other beat or 0.5 for half beats — or to a reference's own face changes with font_cycle_switches, the timeline seconds you read them at; either sets every hold and repeats the faces in order to fill the run. A face's own hold times one face by hand; faces repeat in the list to revisit a typeface.`,
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
      in_stagger: num(`Per-letter entrance: share of the ramp spent handing the motion from the first letter to the last, 0..${EDGE_STAGGER_MAX} (0 = every letter together, higher = one after another, each moving for less of the ramp); a negative restores the style's own`),
      out_stagger: num(`Per-letter exit: the same hand-off share for the exit ramp, 0..${EDGE_STAGGER_MAX}; a negative restores the style's own`),
      in_order: {
        type: "string",
        enum: [...EDGE_ORDERS],
        description: 'Per-letter entrance: the order the letters take their turns — "reading" (left to right) or "shuffle" (a fixed scattered order)',
      },
      out_order: { type: "string", enum: [...EDGE_ORDERS], description: "Per-letter exit: the same order for the exit ramp" },
      in_sequence: {
        type: "array",
        items: { type: "integer" },
        description:
          "Per-letter entrance in an order read off a reference: the letters' numbers in the order they arrive, counting the title's letters from 0 and skipping spaces (YOUR LOCATION: Y=0 … R=3, L=4 … N=11). Overrides in_order; [] clears it",
      },
      out_sequence: { type: "array", items: { type: "integer" }, description: "Per-letter exit: the letters' numbers in the order they leave; [] clears it" },
      in_sequence_at: {
        type: "array",
        items: { type: "number" },
        description:
          "With in_sequence: when each of its letters starts, in its order, as a share of the hand-off — 0 the first, 1 the last — for a reference whose letters do not go evenly spaced (track_element match letters reads it). [] spaces them evenly",
      },
      out_sequence_at: { type: "array", items: { type: "number" }, description: "With out_sequence: each letter's turn as a share of the hand-off; [] spaces them evenly" },
      in_ease: {
        type: "string",
        enum: [...EASE_IDS, "style"],
        description: `Entrance: the curve the move travels on — the ease track_element reads for the reference's move (linear for a steady fall, an .out ease for one that brakes into place); "style" restores the style's own`,
      },
      out_ease: { type: "string", enum: [...EASE_IDS, "style"], description: 'Exit: the same curve for the exit ramp; "style" restores the style\'s own' },
      in_fade: {
        anyOf: [{ type: "boolean" }, { type: "number" }],
        description:
          "Entrance: false keeps the element (each letter) solid the whole way in instead of fading up as it moves — a letter falling in from beyond the frame is solid; a share of the move, 0..1, fades it up over that much and holds it solid after; true restores the style's fade",
      },
      out_fade: {
        anyOf: [{ type: "boolean" }, { type: "number" }],
        description: "Exit: false keeps it solid the whole way out; a share of the move fades it over that much; true restores the style's fade",
      },
      in_blur: num(`Entrance: how soft each letter (the element) starts, design px of defocus, 0..${EDGE_BLUR_MAX}, sharpening on the move's curve as it lands; 0 keeps a soft style sharp, -1 restores the style's own`),
      out_blur: num(`Exit: how soft it ends, design px; 0 keeps it sharp, -1 restores the style's own`),
      in_distance: num(`Entrance: how far the motion travels from rest at its far end, design px at 1080, 1..${EDGE_DISTANCE_MAX}; 0 restores the style's own reach`),
      out_distance: num(`Exit: the same reach for the exit ramp, design px; 0 restores the style's own`),
      loop_style: {
        type: "string",
        enum: [...OVERLAY_LOOP_STYLE_IDS, "none"],
        description: 'Loop style, or "none" to clear',
      },
      loop_speed: num(`Loop rate multiplier ${LOOP_SPEED_MIN}..${LOOP_SPEED_MAX} (default 1); one cycle takes its base time over the speed — ${LOOP_CYCLES} — so a loading spinner that turns once every 0.8s is spin at speed 5`),
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
      font_cycle: {
        type: "array",
        description: `Titles only: the faces the title cycles through, in order (up to ${FONT_CYCLE_FACES_MAX}); [] removes the cycle`,
        items: obj(
          {
            font: str("Font id (see the graphics skill)"),
            weight: { type: "number", enum: [...TEXT_WEIGHTS], description: "Weight of this face; default the title's own" },
            scale: num(`Size multiplier on the title's own size, ${CYCLE_SCALE_MIN}..${CYCLE_SCALE_MAX} (default 1)`),
            tracking: num("Letter spacing in em for this face; default the title's own"),
            italic: bool("Italic for this face; default the title's own"),
            hold: num(`Seconds this face shows, up to ${CYCLE_HOLD_MAX}; default one step at font_cycle_rate`),
          },
          ["font"]
        ),
      },
      font_cycle_at: num("Seconds from the element's start where the cycle begins (default 0)"),
      font_cycle_seconds: num("How long the cycle runs, seconds (default: to the element's end)"),
      font_cycle_rate: num(
        `Face changes a second, ${FONT_CYCLE_RATE_MIN}..${FONT_CYCLE_RATE_MAX} (default ${FONT_CYCLE_RATE}: a new face every other frame at 30 fps)`
      ),
      font_cycle_switches: {
        type: "array",
        items: { type: "number" },
        description:
          "Timeline seconds where the face changes, in order: the first shows the first face, each next one the next face, and the last returns the title to its own face (the title's end keeps the last face up). Sets every face's hold",
      },
      font_cycle_beats: str(
        "Clip id (soundtrack or video) whose beat grid times the faces: a new face on each beat inside the run, the last held to the run's end. Call detect_beats on that clip first"
      ),
      font_cycle_beat_step: num("Beats per face with font_cycle_beats: 1 (default), 2 every other beat, 0.5 two faces a beat"),
    }, ["id"]),
  },
  {
    name: "set_overlay_keyframes",
    description:
      `Give an overlay element a keyframed pose track — the default way to animate one, because a key names the exact pose at the exact second where a preset ramp approximates it. Each key is a whole pose at a time measured in seconds from the element's own start; the pose moves between keys along the key's ease (${EASE_IDS.join(", ")}; default linear) and holds outside them. Omitted fields on a key take the element's current value. scale_x/scale_y stretch one side over scale (a screen switching off: scale_y to 0.02, then scale_x to 0.02); tilt_x/tilt_y turn the element in 3D perspective about its horizontal/vertical axis (tilt_x positive tips the top edge away, tilt_y the right edge; ±${TILT_MAX}°): a bar falling back, a card swinging open. blur softens the element (px at the 1080 short side, 0..${ELEMENT_BLUR_MAX}): keyed with opacity it is depth of field — the card being read sharp, its neighbours blurred and dimmed while a group camera (set_group_camera) pushes in. Keys merge into the track the element already has — one at an existing time replaces that key, the rest stay — so pass replace true to lay a new track over an old one in one call. Pass an empty list to clear the track and return the element to its resting pose. Preset In/Out/Loop animation still composes on top, so a keyframed title can also fade in.`,
    inputSchema: obj(
      {
        id: str("Overlay element id"),
        replace: bool("true drops the element's existing keys first; default false merges these into them"),
        keys: {
          type: "array",
          description: "Keys in any order; two at the same time collapse to one",
          items: obj(
            {
              t: num("Seconds from the element's start"),
              x: num(`Center x, fraction of frame width, ${OVERLAY_KEY_POS_MIN}..${OVERLAY_KEY_POS_MAX}: past 0..1 the element sits beyond the edge, for one that enters or leaves across it, like a pointer sliding in from below (${CAMERA_WORLD_MIN}..${CAMERA_WORLD_MAX} for a grouped element)`),
              y: num(`Center y, fraction of frame height, ${OVERLAY_KEY_POS_MIN}..${OVERLAY_KEY_POS_MAX} (${CAMERA_WORLD_MIN}..${CAMERA_WORLD_MAX} for a grouped element)`),
              scale: num("Size multiplier, 1 = the element's own size (0.1..4)"),
              scale_x: num("Width over scale, 0..4 (default 1)"),
              scale_y: num("Height over scale, 0..4 (default 1)"),
              rotation: num("Degrees clockwise, -180..180, to a tenth (0.4 matches a slight lean)"),
              tilt_x: num(`3D tilt about the horizontal axis, degrees, -${TILT_MAX}..${TILT_MAX}; positive tips the top edge away (default 0)`),
              tilt_y: num(`3D tilt about the vertical axis, degrees, -${TILT_MAX}..${TILT_MAX}; positive tips the right edge away (default 0)`),
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
