/**
 * The assistant's editor-shell tools — the unlimited undo/redo history the
 * shell binds to ⌘Z / ⇧⌘Z — kept beside the editor component. The catalog
 * spreads this list into the model's toolset and `aiTools.ts` keys its
 * handlers on `EditorToolName`.
 */

import { obj, type AiToolDef } from "@/cut/lib/aiToolDef";

export const EDITOR_TOOLS = [
  {
    name: "undo",
    description: "Undo the last edit (unlimited).",
    inputSchema: obj({}),
  },
  {
    name: "redo",
    description: "Redo the last undone edit.",
    inputSchema: obj({}),
  },
] as const satisfies readonly AiToolDef[];

export type EditorToolName = (typeof EDITOR_TOOLS)[number]["name"];
