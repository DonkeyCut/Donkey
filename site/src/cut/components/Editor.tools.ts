/**
 * The assistant's editor-shell tools — the unlimited undo/redo history the
 * shell binds to ⌘Z / ⇧⌘Z — kept beside the editor component. The catalog
 * spreads this list into the model's toolset and `aiTools.ts` keys its
 * handlers on `EditorToolName`.
 */

import { num, obj, type AiToolDef } from "@/cut/lib/aiToolDef";

export const EDITOR_TOOLS = [
  {
    name: "copy_selection",
    description: "Copy selected timeline items and their groups, including effects, transitions, captions, video, audio and overlay elements. Preserve all properties and relative timing.",
    inputSchema: obj({}),
  },
  {
    name: "paste_selection",
    description: "Paste copies of the timeline clipboard at the playhead or at seconds. Adds fresh items, preserving properties, grouping and relative timing. An occupied row moves the set to the next free position.",
    inputSchema: obj({ at: num("Timeline start seconds; defaults to the playhead") }),
  },
  {
    name: "undo",
    description: "Undo the last edit (unlimited). In a turn, each undo takes back your last change-making tool call alone, every write it made; past this turn's first call it takes back the previous turn whole. The result names what it reverted and what changed.",
    inputSchema: obj({}),
  },
  {
    name: "redo",
    description: "Redo the last undone edit. The result names what it put back.",
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type EditorToolName = (typeof EDITOR_TOOLS)[number]["name"];
