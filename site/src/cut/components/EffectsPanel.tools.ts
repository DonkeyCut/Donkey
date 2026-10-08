/**
 * The assistant's Effects tools, kept beside the panel that gives users the
 * same controls. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handlers on `EffectsToolName`, so an effect added to
 * the effects-kit registry is advertised here on the next compile and a
 * removed or renamed tool breaks the build until every side catches up.
 */

import { ALL_EFFECT_IDS, AUDIO_EFFECT_IDS, EFFECT_IDS, FLASH_RHYTHMS, FLASH_RATE_MAX, FLASH_RATE_MIN, FLASH_TONES, GLITCH_KINDS, LEAK_COURSES, LOOK_EFFECTS } from "@donkeycut/effects-kit";
import { num, obj, type AiToolDef } from "@/cut/lib/aiToolDef";

/** The effects with a treatment recipe of their own; the rest of the list is
 * a zoom plus the graded looks. */
export const EFFECT_TREATMENTS = EFFECT_IDS.filter(
  (id) => id !== "zoom" && !(LOOK_EFFECTS as string[]).includes(id)
);

export const EFFECTS_TOOLS = [
  {
    name: "add_effect",
    description:
      `Add a time-ranged effect element over the cut: a zoom into part of the frame, a picture treatment (${EFFECT_TREATMENTS.join(", ")}), a graded look (${LOOK_EFFECTS.join(", ")}), or an audio treatment (${AUDIO_EFFECT_IDS.join(", ")}) over the sound. A picture effect filters everything visible under its window (start..end); an audio effect treats everything audible under it — clip sound, upper tracks and soundtrack together. They stack. glitch is clean footage broken by runs of corrupted frames — dark pixel-stretch smears, the picture doubled sideways over an orange burn, teal close-ups, blown-out flashes — the glitch ending of a teaser, where amount is how often it hits. A glitch pinned to one kind (glitch "smear", "split", "tint", "blowout" or "rgb") hits with it on every frame; "rgb" pulls the color channels apart, red down and blue up — a 2–3 frame rgb glitch is the RGB-split hit of a collapsing title or HUD. lightleak drifts a warm bloom and light streaks over the picture for as long as it is up; with leak "burn" it is a film burn played once across the element's own length: it climbs from the bottom edge behind a hot orange front, flares near white, settles orange and hands the picture back in its last tenth — the burn-out of a teaser, a 0.4–0.6s element over the end of the last shot, amount 1 for a fully opaque burn. With leak "scorch" it flashes film burn through the picture: every frame maps the picture onto a saturated hot tone by brightness — yellow, orange, or red over pink — across the whole frame or a soft-edged patch of it, a new tone and patch each frame; short 2–12 frame scorches over the last shots, amount 1, are the burn-through flicker of a teaser's ending. flash pops the picture white at the element's start and decays in about 0.4s; tone "black" dips it dark instead, and a strobe rate holds the tone on and off that many times a second for the whole element — a black strobe at 5–6 with amount 0.9–1 is the dark beat-flicker over a teaser's last shot. rhythm "flicker" deals each pulse its own strength and leaves some dark: an uneven exposure flicker, a white flicker at rate 12–15 and amount 0.15–0.25. To flicker one shot inside its mask, give the clip the flash through set_clip_effects. Tasteful default: one effect at a time, amount under ~0.5.`,
    inputSchema: obj({
      effect: { type: "string", enum: [...ALL_EFFECT_IDS], description: "Effect id" },
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      amount: num("Strength 0.05..1 (default 0.5). For zoom it is the depth: 0.25 shallow, 0.5 moderate, 1 deep; for an audio effect it is how far the treatment goes"),
      focus_x: num("Zoom only: the x of the point to zoom into, 0..1 (default 0.5)"),
      focus_y: num("Zoom only: the y of the point to zoom into, 0..1 (default 0.5)"),
      leak: {
        type: "string",
        enum: [...LEAK_COURSES],
        description: 'lightleak only: "drift" glows and wanders for the whole element (default), "burn" is the film burn played once across it, "scorch" flashes hot burn tones through the picture frame by frame',
      },
      glitch: {
        type: "string",
        enum: [...GLITCH_KINDS],
        description: 'glitch only: pin every frame to one kind; "rgb" is the channel split. Omit for the random mix',
      },
      tone: {
        type: "string",
        enum: [...FLASH_TONES],
        description: 'flash only: "white" pops the picture bright (default), "black" dips it dark',
      },
      rate: num(`flash only: strobe pulses a second, ${FLASH_RATE_MIN}..${FLASH_RATE_MAX}; each pulse holds the tone for its first half. Omit for one pop at the start`),
      rhythm: {
        type: "string",
        enum: [...FLASH_RHYTHMS],
        description: 'flash with a rate only: "strobe" fires every pulse at full strength (default), "flicker" deals each pulse its own strength and skips some',
      },
      lane: num("Element row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, ["effect"]),
  },
] as const satisfies readonly AiToolDef[];

export type EffectsToolName = (typeof EFFECTS_TOOLS)[number]["name"];
