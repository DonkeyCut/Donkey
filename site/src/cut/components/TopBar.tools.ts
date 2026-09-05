/**
 * The assistant's top-bar tools — the aspect pill, the project name, and the
 * export dialog — kept beside the top bar that exposes the same controls.
 * The catalog spreads this list into the model's toolset and `aiTools.ts`
 * keys its handlers on `TopBarToolName`.
 */

import { obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const TOP_BAR_TOOLS = [
  {
    name: "set_aspect",
    description:
      "Set the project's output frame ratio as \"W:H\". The frame is the user's own setting, so call this only when they asked for a shape or a format (\"make it vertical\", \"for TikTok\", \"square\") — never inferred from a reference image's shape, a platform named in passing, or what would suit a generation you are about to run. Presets: 16:9 (YouTube), 9:16 (TikTok/Reels/Shorts), 1:1, 4:3, 3:4, 2:1 — but any ratio up to an 8:1 shape works, with whole or decimal sides (\"9:5\", \"2.39:1\" — stored reduced, so 2.39:1 becomes 239:100). The frame renders with its short side at 1080px: 9:16 → 1080×1920, 16:9 → 1920×1080, 9:5 → 1944×1080.",
    inputSchema: obj({ aspect: { type: "string", description: "Output ratio as \"W:H\", e.g. \"9:16\", \"1:1\", \"9:5\", \"2.39:1\"" } }, ["aspect"]),
  },
  {
    name: "set_project_name",
    description: "Rename the current project.",
    inputSchema: obj({ name: str("New project name") }, ["name"]),
  },
  {
    name: "open_export",
    description:
      "Open the export dialog so the user can render the cut: quick presets (Share, Best, Small, Master) or the advanced panel — format MP4/MOV, codec H.264/HEVC/ProRes, resolution Source down to 720p, frame rate 24/30/60, quality tier or bitrate, AAC or PCM audio. Exporting itself stays a user action.",
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type TopBarToolName = (typeof TOP_BAR_TOOLS)[number]["name"];
