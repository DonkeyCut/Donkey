/**
 * The assistant's top-bar tools — the aspect pill, the project name, and the
 * export dialog — kept beside the top bar that exposes the same controls.
 * The catalog spreads this list into the model's toolset and `aiTools.ts`
 * keys its handlers on `TopBarToolName`.
 */

import { obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { EXPORT_RESOLUTIONS } from "@/cut/lib/exportPresets";
import { GUIDE_IDS, GUIDE_PRESETS } from "@/cut/lib/guides";

export const TOP_BAR_TOOLS = [
  {
    name: "set_aspect",
    description:
      "Set the project's output frame ratio as \"W:H\". The frame is the user's own setting, so call this only when they asked for a shape or a format (\"make it vertical\", \"for TikTok\", \"square\") — never inferred from a reference image's shape, a platform named in passing, or what would suit a generation you are about to run. Presets: 16:9 (YouTube), 9:16 (TikTok/Reels/Shorts), 1:1, 4:3, 3:4, 2:1 — but any ratio up to an 8:1 shape works, with whole or decimal sides (\"9:5\", \"2.39:1\" — stored reduced, so 2.39:1 becomes 239:100). The frame renders with its short side at 1080px: 9:16 → 1080×1920, 16:9 → 1920×1080, 9:5 → 1944×1080.",
    inputSchema: obj({ aspect: { type: "string", description: "Output ratio as \"W:H\", e.g. \"9:16\", \"1:1\", \"9:5\", \"2.39:1\"" } }, ["aspect"]),
  },
  {
    name: "set_guides",
    description:
      `Choose the guides drawn over the preview — lines and shaded keep-out regions that show where titles, stickers and captions can sit. They draw in the editor only and never export. Presets: ${GUIDE_PRESETS.map((p) => `${p.id} (${p.name}${p.sublabel ? `, ${p.sublabel.toLowerCase()}` : ""})`).join(", ")}. The short-form preset shades the phone UI of TikTok, Instagram Reels and YouTube Shorts merged — top bar, right-hand action rail, bottom caption block, and the side strips Reels and Shorts crop when they fill a taller phone screen — and fits portrait frames. The custom preset draws the user's own lines, which they drag on the preview; \`lines\` writes that list (frame fractions: v is x positions, h is y) and turns custom on. \`show\` replaces the whole set; [] turns every guide off. Placement never needs a guide on: editor_state project.safeZones already carries every preset's safe area for the frame. project.guides reports what shows and the custom lines.`,
    inputSchema: obj(
      {
        show: {
          type: "array",
          items: { type: "string", enum: GUIDE_IDS },
          description: "Guide ids to show; replaces the current set",
        },
        lines: {
          type: "object",
          description: "Custom lines to draw, replacing the current ones: v = vertical line x positions, h = horizontal line y positions, each 0..1 of the frame",
          properties: {
            v: { type: "array", items: { type: "number" } },
            h: { type: "array", items: { type: "number" } },
          },
          additionalProperties: false,
        },
      },
      ["show"]
    ),
  },
  {
    name: "set_project_name",
    description: "Rename the current project.",
    inputSchema: obj({ name: str("New project name") }, ["name"]),
  },
  {
    name: "open_export",
    description:
      `Open the export dialog: Best uses original resolution, frame rate, supported H.264/HEVC codec and audio settings. Whole files, trims and compatible sequences copy compressed video; joined audio is encoded at source settings. Effects or incompatible joins render with source settings. Other presets are Share, Social 4K, Small and Master. Controls include file name, whole video or selection range, MP4/MOV, H.264/HEVC/ProRes, resolution (${EXPORT_RESOLUTIONS.map((r) => r.label).join(", ")}, Source), frame rate, quality or custom bitrate, AAC/PCM, and an SRT captions file. Exporting itself stays a user action.`,
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type TopBarToolName = (typeof TOP_BAR_TOOLS)[number]["name"];
