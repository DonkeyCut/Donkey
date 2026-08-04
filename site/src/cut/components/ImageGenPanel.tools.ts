/**
 * The assistant's image-generation tool, kept beside the Image tab's
 * generator panel. The catalog spreads this list into the model's toolset
 * and `aiTools.ts` keys its handlers on `ImageGenToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const IMAGE_GEN_TOOLS = [
  {
    name: "generate_image",
    description:
      "Generate an AI image from a text prompt (Donkey's hosted image model). Use for B-roll, cover frames, or backgrounds the user doesn't have footage for; when the user asks you to write or improve the prompt itself, put it in chat and wait for them to ask for the image. reference_asset_ids attaches project media the render should draw from (the user's attached references, a clip to restyle) — the prompt is recomposed around them; an audio reference contributes what it carries (its speech transcribed, its sound described) to that recomposed prompt. Returns when the image has landed. The image previews as a card in this chat, where the user can expand it, drag it onto the timeline, or file it into Media or the Library from its \"…\" menu; pass add_to_timeline:true (or an index) only when they asked for it in the cut. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("What to depict — be specific about subject, style, and lighting"),
      aspect: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Image shape (default: the supported shape closest to the project aspect)" },
      resolution: { type: "string", enum: ["1K", "2K", "4K"], description: "Output detail (default 1K)" },
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project asset ids to reference — images and videos ride as pictures; audio folds what it carries into the prompt. Append @seconds to read a video/audio reference at a pinned moment (\"<id>@16.3\")",
      },
      add_to_timeline: bool("Insert the still on the video track (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline; 0 = first/cover)"),
    }, ["prompt"]),
  },
] as const satisfies readonly AiToolDef[];

export type ImageGenToolName = (typeof IMAGE_GEN_TOOLS)[number]["name"];
