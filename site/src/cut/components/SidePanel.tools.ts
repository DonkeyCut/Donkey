/**
 * The assistant's side-panel tools — opening and collapsing the tabs, the
 * Media panel's filing and trash, and the Details tab's publish metadata and
 * project fade — kept beside the side panel that hosts those views
 * (`MediaPanel` and `PublishPanel` live inside it). The catalog spreads this
 * list into the model's toolset and `aiTools.ts` keys its handlers on
 * `SidePanelToolName`.
 */

import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { SIDE_PANEL_TABS } from "@/cut/lib/types";

export const SIDE_PANEL_TOOLS = [
  {
    name: "set_side_panel",
    description:
      "Open a side-panel tab, or collapse the panel to the icon rail with 'none' so the preview canvas takes the freed width — use 'none' when the user asks to clean up or maximize the workspace. 'publish' is the Details tab; 'media' holds the project's files and the shared Library.",
    inputSchema: obj({
      panel: {
        type: "string",
        enum: [...SIDE_PANEL_TABS, "none"],
        description: "Tab to open, or 'none' to collapse the panel",
      },
    }, ["panel"]),
  },
  {
    name: "file_asset",
    description:
      "File a project asset where the user keeps things: to \"media\" moves created media (generated, chat, voiceover…) into the Media panel by clearing its origin tag; to \"library\" copies any project asset into the shared Library for reuse. The same moves as each card's \"…\" menu — make them when the user asks.",
    inputSchema: obj({
      asset_id: str("Project asset id from `media`"),
      to: { type: "string", enum: ["media", "library"], description: "Destination" },
    }, ["asset_id", "to"]),
  },
  {
    name: "delete_asset",
    description:
      "Remove a project asset and every timeline clip that uses it — the Media panel's trash. Removed media does not come back with undo, so call it only when the user explicitly asked to remove that media, and report how many clips went with it.",
    inputSchema: obj({ asset_id: str("Project asset id from `media`") }, ["asset_id"]),
  },
  {
    name: "set_publish",
    description:
      "Set the TikTok publish metadata: caption (4,000 char limit incl. tags), tags (space-separated words, # added automatically), soundTitle, handle.",
    inputSchema: obj({
      caption: str("Caption text"),
      tags: str("Space or comma separated tags"),
      soundTitle: str("Sound title"),
      handle: str("Creator handle without @"),
    }),
  },
  {
    name: "set_project_fade",
    description:
      "Set the whole video's fade in from black and/or fade out to black, in seconds (0 clears, max 2). Applied to the final picture and mix at the start/end of the cut, independent of which clip sits there.",
    inputSchema: obj({ fadeIn: num("Fade-in seconds (omit to keep)"), fadeOut: num("Fade-out seconds (omit to keep)") }),
  },
] as const satisfies readonly AiToolDef[];

export type SidePanelToolName = (typeof SIDE_PANEL_TOOLS)[number]["name"];
