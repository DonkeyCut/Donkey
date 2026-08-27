/**
 * The assistant's cutout tools — the background-removal suite the Inspector's
 * Cutout tab exposes on a video clip: the removal mode, the silhouette
 * stroke, and the fill behind the subject. Kept beside the panel; the catalog
 * spreads this list into the model's toolset and `aiTools.ts` keys its
 * handlers on `RemovalToolName`. Enums and ranges come from the same kit
 * constants the panel renders from.
 */

import {
  CHROMA_DEFAULT_INTENSITY,
  CHROMA_DEFAULT_SOFTNESS,
  CHROMA_DEFAULT_SPILL,
  STROKE_DEFAULT_WIDTH,
  STROKE_OFFSET_MAX,
  STROKE_STYLE_LABELS,
  STROKE_STYLES,
  STROKE_WIDTH_MAX,
} from "@donkeycut/effects-kit";
import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const REMOVAL_TOOLS = [
  {
    name: "set_removal",
    description:
      'Cut a video clip\'s background away — the Inspector\'s Cutout tab, on any track. Modes: "auto" mattes the person in the shot with AI; "custom" mattes whatever `subject` describes in a few words ("the dog") and tracks every match through the clip — picking one exact instance by hand is the panel\'s brush flow, so send the user there for that; "chroma" keys out a backdrop color (green screen) with intensity/softness/spill; "off" removes the whole cutout, stroke and background fill included. The AI mattes bake in the background — wait_for_renders covers the bake. Where the background was, lower tracks or the project background show through; set_removal_background fills that area within the clip itself. Read the background-removal skill for the full recipes.',
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        mode: {
          type: "string",
          enum: ["off", "auto", "custom", "chroma"],
          description: "Cutout mode",
        },
        subject: str(
          'Custom mode: what to keep, in a few words ("the dog", "the red car") — every match is matted and tracked'
        ),
        color: str(
          'Chroma key color "#rrggbb" (omitted: sampled from the footage borders, where a backdrop lives)'
        ),
        intensity: num(
          `Chroma tolerance 0..1 — how far from the key a color still keys out (default ${CHROMA_DEFAULT_INTENSITY})`
        ),
        softness: num(`Chroma edge rolloff 0..1 (default ${CHROMA_DEFAULT_SOFTNESS})`),
        spill: num(
          `Chroma spill suppression 0..1 — pulls key-colored fringe off the kept pixels (default ${CHROMA_DEFAULT_SPILL})`
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
