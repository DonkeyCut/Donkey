import type { AiToolDef } from "@/cut/lib/aiToolDef";
import { ADOPT_COMMAND } from "@/cut/lib/commandBatch";
import { AI_SKILL_INDEX, PROJECT_TOOLS, readSkill } from "@/cut/server/ai/catalog";

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

export const COMMANDS: AiToolDef[] = PROJECT_TOOLS.filter((tool) => !HIDDEN.has(tool.name));
export const COMMAND_NAMES = COMMANDS.map((tool) => tool.name);

/** What a batch may name: the catalog, the state read inspect_project runs
 * by default, and the adoption an import queues after its download. */
const KNOWN_COMMANDS = new Set([...COMMAND_NAMES, "get_state", ADOPT_COMMAND]);
export const unknownCommandNames = (names: string[]): string[] => names.filter((name) => !KNOWN_COMMANDS.has(name));

/** Commands whose output matters and whose effect is on the caller's eyes:
 * a read runs without saving the document. */
export const READ_COMMANDS = new Set([
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

export const SKILL_INDEX = AI_SKILL_INDEX;
export { readSkill };
