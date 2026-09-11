/**
 * The assistant's stock-media tools, kept beside the stock browsers
 * (`StockVideosPanel`, `StockImagesPanel`) that expose the same bundled
 * catalogs. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handlers on `StockToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const STOCK_TOOLS = [
  {
    name: "stock_search",
    description:
      "Search Cut's bundled stock catalogs: footage clips and stock images across Business/Nature/Travel/City/Technology/Anime/Animal/Food categories, talking characters (personas for generate_character_video), and one-shot sound effects (whooshes, clicks, risers, hits, glitches, UI pops, camera shutters, crowds, ambience and more). Stock is local and free — check it before spending generation credits when existing media could serve. Add a match to the project with stock_add.",
    inputSchema: obj({
      query: str("Words to match against prompts, categories, and tags (omit to browse)"),
      kind: { type: "string", enum: ["video", "image", "character", "sound"], description: "Limit to one catalog (default: all)" },
    }),
  },
  {
    name: "stock_add",
    description:
      "Import a stock video, image, or sound effect (by stock_search id) into the project. It previews as a card in this chat; pass add_to_timeline:true (or a `start`) to also drop it in the cut when the user asked — footage and stills on the video track, a sound on the soundtrack at the playhead (or `start`). Free — the media ships with Cut.",
    inputSchema: obj({
      id: str("Stock item id from stock_search"),
      add_to_timeline: bool("Place it in the cut — video track 0 for footage and stills, the soundtrack for a sound (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start s (passing it implies add_to_timeline; default when placed: appended at the end)"),
    }, ["id"]),
  },
] as const satisfies readonly AiToolDef[];

export type StockToolName = (typeof STOCK_TOOLS)[number]["name"];
