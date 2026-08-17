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
      "Render one frame of the cut as an image — the whole picture an export would write at that moment: footage, transitions, effects, elements and captions. Defaults to the playhead.",
    inputSchema: obj({ t: num("Timeline time in seconds (default: the playhead)") }),
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
