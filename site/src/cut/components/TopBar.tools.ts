/**
 * The assistant's top-bar tools — the aspect pill, the project name, and the
 * export dialog — kept beside the top bar that exposes the same controls.
 * The catalog spreads this list into the model's toolset and `aiTools.ts`
 * keys its handlers on `TopBarToolName`.
 */

import { OUTPUT_SPACES } from "@donkeycut/effects-kit";
import { obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { EXPORT_RESOLUTIONS } from "@/cut/lib/exportPresets";
import { LOUDNESS_CHOICES } from "@/cut/lib/loudnessSettings";
import { GUIDE_IDS, GUIDE_PRESETS } from "@/cut/lib/guides";

export const TOP_BAR_TOOLS = [
  {
    name: "set_aspect",
    description:
      "Set the open timeline's output frame ratio as \"W:H\"; each timeline keeps its own. The frame is the user's own setting, so call this only when they asked for a shape or a format (\"make it vertical\", \"for TikTok\", \"square\") — never inferred from a reference image's shape, a platform named in passing, or what would suit a generation you are about to run. Presets: 16:9 (YouTube), 9:16 (TikTok/Reels/Shorts), 1:1, 4:3, 3:4, 2:1 — but any ratio up to an 8:1 shape works, with whole or decimal sides (\"9:5\", \"2.39:1\" — stored reduced, so 2.39:1 becomes 239:100). The frame renders with its short side at 1080px: 9:16 → 1080×1920, 16:9 → 1920×1080, 9:5 → 1944×1080.",
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
    name: "set_project_color",
    description:
      `Set the project's delivery color space: ${OUTPUT_SPACES.map((o) => `${o.id} = ${o.label} (${o.detail})`).join("; ")}. The export writes it — an HDR project encodes 10-bit HEVC Main 10 or ProRes tagged Rec.2020 with the HLG or PQ transfer, and H.264 is not offered — and the preview shows the HDR picture on an HDR display, or the same grade rendered as SDR with a "Previewing SDR" label elsewhere. SDR footage placed in an HDR project sits at reference white (BT.2408); HLG and PQ footage keeps its range. Call it when the user asks for HDR, HLG, PQ, Rec.2100, or to go back to SDR; editor_state project.colorSpace reports the current one.`,
    inputSchema: obj({ space: { type: "string", enum: OUTPUT_SPACES.map((o) => o.id), description: "The delivery color space" } }, ["space"]),
  },
  {
    name: "open_export",
    description:
      `Open the export dialog: Best uses original resolution, frame rate, supported H.264/HEVC codec and audio settings. Whole files, trims and compatible sequences copy compressed video; joined audio is encoded at source settings. Effects or incompatible joins render with source settings. Other presets are Share, Social 4K, Small and Master. Controls include file name, whole video or selection range, MP4/MOV, H.264/HEVC/ProRes, resolution (${EXPORT_RESOLUTIONS.map((r) => r.label).join(", ")}, Source), frame rate, quality or custom bitrate, AAC/PCM, the project's color space (SDR, or HDR as HLG or PQ — a 10-bit HEVC or ProRes file; H.264 greys out), an SRT captions file, Loudness (${LOUDNESS_CHOICES.map((c) => `${c.label}: ${c.detail}`).join("; ")}. Each target's LUFS, the true-peak ceiling and the choice an export starts on are account settings the dialog shows. One gain sets the mix's integrated loudness, and a limiter holds true peaks under the ceiling), and Stems (a zip of one 24-bit WAV per lane, the video clips' dialogue then each soundtrack lane, full length and unmastered, saved beside the video). measure_level with mix: true reads the mix's loudness first. Exporting itself stays a user action.`,
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type TopBarToolName = (typeof TOP_BAR_TOOLS)[number]["name"];
