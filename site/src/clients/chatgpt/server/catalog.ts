import type { ToolAnnotations } from "@modelcontextprotocol/server";
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
  "list_projects",
  // Page-local: the editor's clipboard and playback.
  "copy_selection",
  "paste_selection",
  // The card speaks ChatGPT's language, so the editor's own language setting
  // stays with the editor.
  "set_interface_language",
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

// What ChatGPT needs on top of the shared description.
const ADDENDA: Record<string, string> = {
  check_facts: "The output's searchSuggestions are the Google searches behind the verdicts: show them to the user as links, with their text and URLs as given, wherever you report the results.",
};

export const COMMANDS: AiToolDef[] = PROJECT_TOOLS.filter((tool) => !HIDDEN.has(tool.name)).map((tool) => ({
  ...tool,
  description: DESCRIPTIONS[tool.name] ?? [chatgptDescription(tool.description), ADDENDA[tool.name]].filter(Boolean).join(" "),
}));
export const COMMAND_NAMES = COMMANDS.map((tool) => tool.name);

/** Batches include the catalog and commands queued by first-class tools. */
const KNOWN_COMMANDS = new Set([...COMMAND_NAMES, "get_state", "undo", "redo", ADOPT_COMMAND]);
export const unknownCommandNames = (names: string[]): string[] => names.filter((name) => !KNOWN_COMMANDS.has(name));

/** What a command does, in the terms of OpenAI's tool annotations. A read
 * changes nothing; a search reaches the public web; session moves only the
 * editor's view (playhead, selection, open timeline, guides); add writes new
 * things alone; set overwrites a value, the same each time; change deletes,
 * overwrites or moves by an amount; share opens a public link. Undo does not
 * make a write additive. */
type Effect = "read" | "search" | "session" | "add" | "set" | "change" | "share";

const HINTS: Record<Effect, Required<Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  search: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  session: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  set: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  change: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  share: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

// Every exposed command's effect; a test holds this map to COMMANDS.
const EFFECTS: Record<string, Effect> = {
  get_asset_info: "read", find_media: "read", watch_video: "read", detect_silence: "read",
  find_filler: "read", measure_level: "read", detect_beats: "read", listen_audio: "read",
  compare_to_source: "read", sample_color: "read", track_element: "read", track_camera: "read",
  suggest_font: "read", find_highlights: "read", read_project: "read", capture_frame: "read",
  read_color_stats: "read", list_voices: "read", credit_prices: "read", stock_search: "read",
  read_note: "read", read_folder: "read", library_list: "read", notes_list: "read",
  check_facts: "search",
  seek: "session", select: "session", select_items: "session", switch_timeline: "session",
  set_guides: "session", wait_for_uploads: "session",
  note_source: "add", add_clip: "add", add_overlay_video: "add", add_title: "add",
  add_text_sequence: "add", freeze_frame: "add", group_items: "add", copy_from_timeline: "add",
  add_shape: "add", add_sticker: "add", create_sticker: "add", add_effect: "add",
  subtitles_add_track: "add", subtitles_translate_track: "add", voiceover_generate: "add",
  generate_music: "add", read_subtitles_aloud: "add", generate_image: "add", stock_add: "add",
  library_add: "add", template_add: "add", save_template: "add", copy_project_media: "add",
  replicate_project: "add",
  find_picture: "set", detect_cuts: "set", trim_clip: "set", place_clip: "set",
  set_clip_muted: "set", rename_item: "set", set_clip_hidden: "set", set_track_hidden: "set",
  set_track_muted: "set", set_magnet: "set", update_overlay_video: "set", update_overlay: "set",
  set_mask: "set", track_motion: "set", set_clip_keyframes: "set", update_audio: "set",
  set_clip_volume: "set", sync_audio: "set", set_split_edit: "set", set_clip_sound: "set",
  save_sound_preset: "set", set_framing: "set", set_clip_style: "set", set_clip_effects: "set",
  set_speed: "set", set_speed_curve: "set", set_color_grade: "set", set_color_preset: "set",
  set_color_curves: "set", set_color_wheels: "set", set_color_hsl: "set", set_color_lut: "set",
  copy_color_grade: "set", set_source_color: "set", save_color_grade: "set",
  apply_saved_grade: "set", match_color_grade: "set", set_camera_card: "set", set_removal: "set",
  set_removal_stroke: "set", set_removal_background: "set", set_overlay_animation: "set",
  set_overlay_keyframes: "set", set_group_camera: "set", set_transition: "set",
  set_transition_hidden: "set", set_animation: "set", set_caption_look: "set",
  set_caption_emphasis: "set", subtitles_set_view: "set", update_cue: "set", set_publish: "set",
  set_project_notes: "set", set_background: "set", set_aspect: "set", set_project_name: "set",
  set_project_color: "set", replace_item: "set", align_to_audio: "set", pack_lanes: "set",
  file_asset: "set", convert_media: "set", sync_lyrics: "set", subtitles_generate: "set",
  move_selection: "change", ungroup_items: "change", move_timeline_selection: "change",
  insert_item_row: "change", split_at: "change", move_clip: "change", reorder_track: "change",
  refine_speech_cuts: "change", delete_item: "change", remove_gap: "change", detach_audio: "change",
  remove_transition: "change", subtitles_remove_track: "change", delete_cue: "change",
  merge_cue: "change", captions_generate: "change", subtitles_from_visuals: "change",
  note_save: "change", library_organize: "change", media_organize: "change", delete_asset: "change",
  library_share: "share",
};

/** A command's annotations, from its effect. */
export const commandHints = (name: string) => HINTS[EFFECTS[name]];

/** Commands that change nothing: a read runs without saving the document. */
export const READ_COMMANDS = new Set(
  Object.keys(EFFECTS).filter((name) => HINTS[EFFECTS[name]].readOnlyHint),
);

/** Names with no effect, or effects with no command: a test keeps both empty. */
export function unmappedCommands(): string[] {
  const names = new Set(COMMAND_NAMES);
  return [...COMMAND_NAMES.filter((name) => !Object.hasOwn(EFFECTS, name)), ...Object.keys(EFFECTS).filter((name) => !names.has(name))];
}
