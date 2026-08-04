/**
 * The assistant's Transitions tools — the styled join between two clips and
 * a clip's own entrance/exit — kept beside the panel that gives users the
 * same tiles. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handlers on `TransitionsToolName`, so the style ids
 * the model can pass are exactly the ones the panel renders and a removed or
 * renamed tool breaks the build until every side catches up.
 */

import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { ANIM_STYLE_IDS, TRANSITION_STYLE_IDS } from "@/cut/lib/types";

export const TRANSITIONS_TOOLS = [
  {
    name: "set_transition",
    description:
      "Set the transition from this clip into the next clip on its track (any video track), in seconds (0 clears it, max 2). A transition is a blend across the cut — it never moves, trims or overlaps clips, and it plays only while the pair touches. On upper tracks every style blends as an alpha dissolve (the tracks beneath show through). Only valid when a next same-track clip exists. Each edge holds one effect: setting a transition clears the animations adjacent to its joint (and set_animation on that edge replaces the transition). Read the transitions-and-fades skill before styling cuts.",
    inputSchema: obj({
      clipId: str("Video clip id (the clip the transition starts from)"),
      seconds: num("Transition length in seconds, 0–2 (0 = hard cut)"),
      style: {
        type: "string",
        enum: [...TRANSITION_STYLE_IDS],
        description: "Transition look (default crossfade)",
      },
    }, ["clipId", "seconds"]),
  },
  {
    name: "set_animation",
    description:
      "Animate one clip's own entrance (which:'in') or exit (which:'out'): fade, zoom, pop, or a slide named by its motion direction. style 'none' clears. Track-0 clips take every style; upper-track clips only fade and zoom. Each edge holds one effect, last pick wins: animating an edge a transition owns replaces that transition, and setting a transition clears the animations adjacent to its joint. At an abutting cut the animation plays over the neighbor's held frame; at the timeline's ends and across gaps it plays against black.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      which: { type: "string", enum: ["in", "out"], description: "Entrance or exit" },
      style: {
        type: "string",
        enum: [...ANIM_STYLE_IDS, "none"],
        description: "Animation style, or 'none' to clear",
      },
      seconds: num("Ramp length in seconds, 0.1–2 (default 0.5)"),
    }, ["clipId", "which", "style"]),
  },
] as const satisfies readonly AiToolDef[];

export type TransitionsToolName = (typeof TRANSITIONS_TOOLS)[number]["name"];
