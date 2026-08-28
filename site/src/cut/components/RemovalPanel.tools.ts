/**
 * The assistant's cutout tools — the background-removal suite the Inspector's
 * Cutout tab exposes on a video clip: the removal mode, the silhouette
 * stroke, and the fill behind the subject. Kept beside the panel; the catalog
 * spreads this list into the model's toolset and `aiTools.ts` keys its
 * handlers on `RemovalToolName`. Enums and ranges come from the same kit
 * constants the panel renders from.
 */

import {
  STROKE_DEFAULT_WIDTH,
  STROKE_FEATHER_MAX,
  STROKE_OFFSET_MAX,
  STROKE_STYLE_LABELS,
  STROKE_STYLES,
  STROKE_WIDTH_MAX,
} from "@donkeycut/effects-kit";
import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const REMOVAL_TOOLS = [
  {
    name: "set_removal",
    description: `Cut part of a video clip's picture away — the Inspector's Cutout tab, on any track. \`remove\` picks the direction: "background" (default) keeps the selection and removes everything around it; "subject" removes the selection itself and keeps the rest. \`mode\` picks how the selection is found: "auto" mattes the person in the shot with the free on-device matte — this tool call starts it (in the panel the bake waits for the user's Apply press), and a green-screen or plain-backdrop shot needs nothing more, the matte keys it; "custom" mattes whatever \`subject\` describes in a few words ("the dog") and tracks every match through the clip — picking one exact instance by hand is the panel's brush flow, so send the user there for that; "off" switches the cutout off — the picture shows plain, but the baked matte and every setting stay on the clip, so switching back on is instant and re-bills nothing. The selection is the same in both directions, so flipping \`remove\` on an existing cutout re-bakes nothing. The AI mattes prepare in the background — wait_for_renders covers that work — and a long clip tracks in parts automatically, so length needs no special handling. Where pixels were removed, lower tracks or the project background show through; set_removal_background fills that area within the clip itself. Read the background-removal skill for the full recipes.`,
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        mode: {
          type: "string",
          enum: ["off", "auto", "custom"],
          description: "How the selection is found",
        },
        remove: {
          type: "string",
          enum: ["background", "subject"],
          description:
            'What goes: "background" (default) keeps the selection, "subject" removes it and keeps the rest of the picture',
        },
        refine: bool(
          'Auto mode: also run the hosted quality pass for hair and edge detail once the free matte lands — spends credits like generation, so pass it only when the user asks for the upgrade (the panel\'s "Apply")'
        ),
        subject: str(
          'Custom mode: what to keep, in a few words ("the dog", "the red car") — every match is matted and tracked'
        ),
      },
      ["clipId", "mode"]
    ),
  },
  {
    name: "set_removal_stroke",
    description: `Draw ink around a cutout clip's silhouette (the clip needs an active set_removal cutout). Styles: ${STROKE_STYLES.map((s) => `${s} (${STROKE_STYLE_LABELS[s].toLowerCase()})`).join(", ")} — glow haloes the edge, hand looks marker-drawn, cut is a coarse straight-edged sticker cut, solid is a clean even line, offset throws a filled silhouette copy behind the subject (offset_x/offset_y place it), dotted walks dots along the edge. Pass style "none" to remove the stroke.`,
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        style: {
          type: "string",
          enum: [...STROKE_STYLES, "none"],
          description: 'Stroke style, or "none" to remove it',
        },
        color: str('Ink color "#rrggbb" (default white)'),
        width: num(
          `Ink thickness, design px at the 1080 short side, 1..${STROKE_WIDTH_MAX} (default ${STROKE_DEFAULT_WIDTH})`
        ),
        feather: num(
          `Edge softness: the ink blurred by this many design px, 0..${STROKE_FEATHER_MAX} (default 0, crisp)`
        ),
        offset_x: num(
          `Offset style: silhouette displacement right, design px, -${STROKE_OFFSET_MAX}..${STROKE_OFFSET_MAX}`
        ),
        offset_y: num(
          `Offset style: silhouette displacement down, design px, -${STROKE_OFFSET_MAX}..${STROKE_OFFSET_MAX}`
        ),
      },
      ["clipId", "style"]
    ),
  },
  {
    name: "set_removal_background",
    description:
      'Fill in behind a cutout clip\'s subject (the clip needs an active set_removal cutout): a flat color or a project image asset drawn where the removed background was, inside the clip\'s own picture. Kind "none" clears the fill and lets lower tracks show through again.',
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        kind: {
          type: "string",
          enum: ["none", "color", "image"],
          description: "Backdrop fill behind the subject",
        },
        color: str('Fill color "#rrggbb" (kind "color")'),
        asset_id: str('Project image asset id (kind "image")'),
      },
      ["clipId", "kind"]
    ),
  },
] as const satisfies readonly AiToolDef[];

export type RemovalToolName = (typeof REMOVAL_TOOLS)[number]["name"];
