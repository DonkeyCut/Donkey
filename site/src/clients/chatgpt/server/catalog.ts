import type { AiToolDef } from "@/cut/lib/aiToolDef";
import { ADOPT_COMMAND } from "@/cut/lib/commandBatch";
import { PROJECT_TOOLS } from "@/cut/server/ai/catalog";
import { chatgptDescription } from "@/clients/chatgpt/server/guidance";
export { SKILL_INDEX, readSkill } from "@/clients/chatgpt/server/guidance";

// The editing commands ChatGPT can run, drawn from the editor's own tool
// catalog so a command the assistant gains is a command ChatGPT gains. A few
// are left out because ChatGPT reaches the same thing through a first-class
// tool of its own, or because the command needs a page or a running chat.

const HIDDEN = new Set([
  // First-class ChatGPT tools cover these.
  "get_state",
  "undo",
  "redo",
  "render_preview",
  "import_url",
  // Page-local: the editor's clipboard and playback.
  "copy_selection",
  "paste_selection",
  // Long generations settle after the batch ends, so nothing would place them.
  "generate_video",
  "generate_character_video",
  "generate_scene",
  "approve_scene",
  "cancel_scene",
  "regenerate_shot",
  "recut_scene",
  "restyle_scene",
  "wait_for_renders",
]);

const DESCRIPTIONS: Record<string, string> = {
  set_removal: "Cut out a subject or background on any video track. mode auto starts the free person matte; custom tracks the subject described in subject and spends credits; off keeps the stored matte and settings. remove background keeps the subject, and remove subject keeps its surroundings. refine requests the paid quality upgrade when the user asks for it. Matting continues in the editor: inspect_project reports each clip's removal readiness and progress. Check readiness before claiming completion, then capture_frame to inspect the result. The user can select an exact instance with the Cutout inspector's brush and Apply controls. Read background-removal for the workflow.",
  stock_search: "Search the bundled catalogs for footage, images, character references, and sound effects. Stock is free. Use stock_add to import a result, then inspect it before choosing where it belongs in the cut.",
};

export const COMMANDS: AiToolDef[] = PROJECT_TOOLS.filter((tool) => !HIDDEN.has(tool.name)).map((tool) => ({
  ...tool,
  description: DESCRIPTIONS[tool.name] ?? chatgptDescription(tool.description),
}));
export const COMMAND_NAMES = COMMANDS.map((tool) => tool.name);

/** What a batch may name: the catalog, the state read inspect_project runs
 * by default, and the adoption an import queues after its download. */
const KNOWN_COMMANDS = new Set([...COMMAND_NAMES, "get_state", ADOPT_COMMAND]);
export const unknownCommandNames = (names: string[]): string[] => names.filter((name) => !KNOWN_COMMANDS.has(name));

/** Commands whose output matters and whose effect is on the caller's eyes:
 * a read runs without saving the document. */
export const READ_COMMANDS = new Set([
  "get_asset_info",
  "watch_video",
  "capture_frame",
  "compare_to_source",
  "listen_audio",
  "detect_silence",
  "detect_beats",
  "measure_level",
  "read_color_stats",
  "stock_search",
  "list_voices",
  "library_list",
  "notes_list",
  "read_project",
]);

/** The first sentence of a description, as the index shows it. */
function summary(description: string): string {
  const first = description.replace(/\s+/g, " ").match(/^(.*?[.!?])(\s|$)/)?.[1] ?? description;
  return first.length > 180 ? `${first.slice(0, 177)}…` : first;
}

export function commandIndex(): { name: string; summary: string; reads?: true }[] {
  return COMMANDS.map((tool) => ({
    name: tool.name,
    summary: summary(tool.description),
    ...(READ_COMMANDS.has(tool.name) ? { reads: true as const } : {}),
  }));
}

export function describeCommands(names: string[]): { found: AiToolDef[]; unknown: string[] } {
  const wanted = new Set(names);
  const found = COMMANDS.filter((tool) => wanted.has(tool.name));
  const known = new Set(found.map((tool) => tool.name));
  return { found, unknown: names.filter((name) => !known.has(name)) };
}
