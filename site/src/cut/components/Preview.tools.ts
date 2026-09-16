/**
 * The assistant's preview tools — the playhead, playback, and the composited
 * frame the preview shows — kept beside the player component that exposes
 * the same transport. The catalog spreads this list into the model's toolset
 * and `aiTools.ts` keys its handlers on `PreviewToolName`.
 */

import { bool, num, obj, type AiToolDef } from "@/cut/lib/aiToolDef";

export const PREVIEW_TOOLS = [
  {
    name: "render_preview",
    description: "Render a low-resolution video of the current cut, including overlays and captions. Returns a job with its captured revision, status and playback URL. A queued cloud or Mac job becomes playable when its status URL reports done. This renders the whole cut; use capture_frame for a single frame.",
    inputSchema: obj({}),
  },
  {
    name: "move_selection",
    description: "Move selected visual items together in the preview, preserving their spacing. dx/dy are fractions of frame width/height. Supports video, titles, shapes, stickers, and caption tracks; audio and effects keep their timing. Keyframed items receive position keys at the playhead. One undo step.",
    inputSchema: obj({ dx: num("Horizontal movement as a frame fraction"), dy: num("Vertical movement as a frame fraction") }, ["dx", "dy"]),
  },
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
