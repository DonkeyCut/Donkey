/**
 * The assistant's preview tools — the playhead, playback, and the composited
 * frame the preview shows — kept beside the player component that exposes
 * the same transport. The catalog spreads this list into the model's toolset
 * and `aiTools.ts` keys its handlers on `PreviewToolName`.
 */

import { bool, num, obj, type AiToolDef } from "@/cut/lib/aiToolDef";

export const PREVIEW_TOOLS = [
  {
    name: "capture_frame",
    description:
      "Capture the composited video frame the preview shows at the playhead as an image. Titles and captions are drawn over the canvas in the UI, so they don't appear here — this checks the footage, not the text.",
    inputSchema: obj({}),
  },
  {
    name: "seek",
    description: "Move the playhead to a time (seconds, clamped to the cut).",
    inputSchema: obj({ t: num("Timeline time in seconds") }, ["t"]),
  },
  {
    name: "set_playing",
    description: "Start or stop playback.",
    inputSchema: obj({ playing: bool("true to play, false to pause") }, ["playing"]),
  },
] as const satisfies readonly AiToolDef[];

export type PreviewToolName = (typeof PREVIEW_TOOLS)[number]["name"];
