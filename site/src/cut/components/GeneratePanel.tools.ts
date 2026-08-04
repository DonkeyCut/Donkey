/**
 * The assistant's video-generation tools — a single AI clip and the
 * UGC-style talking-character clip — kept beside the Video tab's generator
 * panel. The catalog spreads this list into the model's toolset and
 * `aiTools.ts` keys its handlers on `VideoGenToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const VIDEO_GEN_TOOLS = [
  {
    name: "generate_video",
    description:
      "Generate an AI video clip from a text prompt (Donkey's hosted video model: one pass, audio included, 720p, up to ~10s — the model picks the length) — the default for any video ask: \"generate/make a video of/about X\" means ONE clip from this tool, even though it sounds whole. \"Make me a better version / another take\" of an existing clip is also this tool — render the fresh take and leave their clip in place; a grade or effect on the original delivers a tweak, and they asked for a version. Reach for generate_scene only when they name a narrated multi-shot production (a story, episode, or narrated short). When the user asks you to write or improve the prompt itself, put it in chat and wait for them to ask for the video. reference_asset_id anchors the render on one project asset: for an image or video, by default the tool first designs the opening frame from it with the image model (that still previews in this chat), then animates that exact frame — so tell the user it designs the frame, then renders; for audio, what it carries (speech transcribed, sound described) folds into the prompt instead. When the user wants the referenced image itself brought to life (\"animate this image/picture\"), pass animate_reference:true — the image becomes the literal first frame, unchanged, and the prompt describes only the motion. A safety-blocked or rejected anchor degrades the render on its own (identity reference, then text-only — the same ladder scene shots walk), so never resubmit a failed render with weaker inputs yourself. The render takes a minute or two and the tool RETURNS as soon as it's started — the clip previews as a live card in this chat when it finishes. Pass add_to_timeline:true (or an index) only when they asked for it in the cut; otherwise the user drags it in from the card. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("The shot to generate — describe motion, subject, and mood"),
      aspect: { type: "string", enum: ["16:9", "9:16"], description: "Clip shape (default: the supported shape closest to the project aspect)" },
      reference_asset_id: str("One project asset id to reference — an image or video anchors the clip's opening frame; audio folds what it carries into the prompt. Append @seconds to read a video/audio reference at a pinned moment (\"<id>@16.3\")"),
      animate_reference: bool("The referenced image IS the opening frame: animate it directly, unchanged, skipping the frame-design step (use when the user says to animate that image)"),
      add_to_timeline: bool("Insert the clip on the video track when it lands (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline)"),
    }, ["prompt"]),
  },
  {
    name: "generate_character_video",
    description:
      "Generate a UGC-style selfie clip of a stock talking character speaking a line you write (Donkey's hosted video model). Pick a character id from stock_search kind:\"character\" — each has a persona and look; the same person then delivers the line to camera. Like generate_video this RETURNS IMMEDIATELY and the clip previews in this chat a minute or two later; add_to_timeline:true places it when it lands. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      character_id: str("Talking-character id from stock_search"),
      line: str("What the character says, spoken to camera"),
      add_to_timeline: bool("Insert the clip on the video track when it lands (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline)"),
    }, ["character_id", "line"]),
  },
] as const satisfies readonly AiToolDef[];

export type VideoGenToolName = (typeof VIDEO_GEN_TOOLS)[number]["name"];
