/**
 * The assistant's Effects tools, kept beside the panel that gives users the
 * same controls. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handlers on `EffectsToolName`, so an effect added to
 * the effects-kit registry is advertised here on the next compile and a
 * removed or renamed tool breaks the build until every side catches up.
 */

import { EFFECT_IDS, LOOK_EFFECTS } from "@donkeycut/effects-kit";
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
      `Add a time-ranged visual effect element over the video: a zoom into part of the frame, the treatments (${EFFECT_TREATMENTS.join(", ")}) or a graded look (${LOOK_EFFECTS.join(", ")}). It filters everything under it for its window (start..end) and stacks with other effects. Tasteful default: one effect at a time, amount under ~0.5.`,
    inputSchema: obj({
      effect: { type: "string", enum: [...EFFECT_IDS], description: "Effect id" },
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      amount: num("Strength 0.05..1 (default 0.5). For zoom it is the depth: 0.25 shallow, 0.5 moderate, 1 deep"),
      focus_x: num("Zoom only: the x of the point to zoom into, 0..1 (default 0.5)"),
      focus_y: num("Zoom only: the y of the point to zoom into, 0..1 (default 0.5)"),
    }, ["effect"]),
  },
] as const satisfies readonly AiToolDef[];

export type EffectsToolName = (typeof EFFECTS_TOOLS)[number]["name"];
