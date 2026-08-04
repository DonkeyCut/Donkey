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
      "Search Cut's bundled stock catalogs: footage clips and stock images across Business/Nature/Travel/City/Technology/Anime/Animal/Food categories, plus talking characters (personas for generate_character_video). Stock is local and free — check it before spending generation credits when existing media could serve. Add a match to the project with stock_add.",
    inputSchema: obj({
      query: str("Words to match against prompts, categories, and tags (omit to browse)"),
      kind: { type: "string", enum: ["video", "image", "character"], description: "Limit to one catalog (default: all)" },
    }),
  },
  {
    name: "stock_add",
    description:
      "Import a stock video or image (by stock_search id) into the project. It previews as a card in this chat; pass add_to_timeline:true (or a `start`) to also drop it on the video track when the user asked for it in the cut. Free — the media ships with Cut.",
    inputSchema: obj({
      id: str("Stock item id from stock_search"),
      add_to_timeline: bool("Place it on video track 0 (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start s (passing it implies add_to_timeline; default when placed: appended at the end)"),
    }, ["id"]),
  },
] as const satisfies readonly AiToolDef[];

export type StockToolName = (typeof STOCK_TOOLS)[number]["name"];
