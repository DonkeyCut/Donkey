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
    name: "convert_media",
    description:
      "Convert project media to MP4 — H.264 picture, AAC sound — replacing each asset's file in place, so clips already cut from it keep playing. This is the fix for footage that previews black or refuses to play: a phone's HEVC .mov, a screen recorder's ProRes, a camera file with raw PCM sound. It is also the whole answer to \"turn these into mp4\": the user drops the files on this chat, you convert them, and each converted file is on its own card right here for them to download or drag in — nothing to go looking for. A file already in Media stays in Media. Streams that already fit the container are copied packet for packet, so a .mov of H.264 converts in seconds and loses nothing, and a file that is already an MP4 of those streams comes back untouched. `max_height` shrinks the picture at the same time (1080 for a 4K source that only needs to be a timeline clip). It runs wherever the project's bytes already are — this Mac, the render worker, or the tab — so it needs no setup; when nothing available can decode the source the error says what would fix it, and retrying changes nothing.",
    inputSchema: obj({
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project asset ids from `media`, converted in order",
      },
      max_height: num("Cap the output height in pixels (e.g. 1080); omit to keep the source size"),
    }, ["asset_ids"]),
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
  {
    name: "set_background",
    description:
      "Set the color of the video frame itself — what sits behind every clip and element. It fills the frame wherever no footage covers it: a cut made only of titles and shapes plays over it end to end, a fitted clip letterboxes into it, and a gap on track 0 shows it. Use this for \"make the background white/orange\" rather than laying a full-frame rectangle over the timeline. Default is black.",
    inputSchema: obj({ color: str("Hex color, e.g. #FFFFFF") }, ["color"]),
  },
] as const satisfies readonly AiToolDef[];

export type SidePanelToolName = (typeof SIDE_PANEL_TOOLS)[number]["name"];
