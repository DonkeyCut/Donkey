import { AI_SKILLS } from "@/cut/server/ai/catalog";
import { DOC_EXPORT_PRESETS } from "@/cut/lib/exportPresets";

/** Translate the shared catalog's state-read reference for this client. */
export function chatgptDescription(text: string): string {
  return text.replace(/\bget_state\b/g, "inspect_project");
}

// These guides describe editing operations shared by every client. Additions
// are selected here after checking their commands and interaction model.
const SHARED_SKILLS = [
  "color-grading",
  "replicating-a-video",
  "transitions-and-fades",
  "text-videos",
  "text-creativity",
  "editing-taste",
] as const;

const SKILLS: Record<string, string> = {
  ...Object.fromEntries(SHARED_SKILLS.map((name) => [name, chatgptDescription(AI_SKILLS[name])])),

  "editor-overview": `# Donkey Cut in ChatGPT
ChatGPT plans the edit and interprets the footage with the user. Donkey Cut imports media, measures it, applies editing commands, and renders the result.
Work on the connected account's cloud projects. Use list_projects or create_project, then open_project. The user must keep the editor card open for inspection, imports, edits, undo and redo. If a tool reports no card open, ask the user to open the project card and resume when it is ready. Local projects become accessible after the user saves them to cloud in Donkey Cut.
Read inspect_project for current assets, selection, tracks, captions, notes and settings. An editor_state mentioned in these guides is that returned state. Times are seconds and ids come from tool results.
Call list_commands to discover commands and describe_commands for their inputs. Commands marked reads run through inspect_project with projectId and commands; commands that write run through edit_project. note_source writes observations and belongs in edit_project. Each edit batch is one undo step; the user's manual edits share that history. A batch stops at the first failure, so read its results before continuing.
The card offers the timeline, preview and inspector. ChatGPT provides the conversation and calls the media and caption commands. When a required asset is missing, ask the user for a file or link, or discuss suitable stock. Ask about creative choices when the answer materially changes the requested result.`,

  "timeline-editing": `# Timeline editing
Inspect the project before editing. Every track uses start times and allows gaps. add_clip places a project asset; add_overlay_video places footage on an upper track. add_clip with blocks lays out placeholders for footage the user will supply, and replace_item fills them while retaining the edit's timing.
trim_clip uses source seconds. split_at and place_clip use timeline seconds. For uniform forward playback, timeline time = clip.start + (source time - clip.in) / clip.speed. For reverse playback use clip.out - source time. For speed curves use the reported len and returned timing data.
delete_item removes the item and its group, leaving a gap. remove_gap closes a gap on one row. place_clip places by time; move_clip reorders by index. Growth pushes overlapping neighbors on the same row; shrinking leaves a gap. Read returned ids and timing after each mutation.
set_speed changes uniform speed or reverse playback; set_speed_curve adds a rate curve. detach_audio separates a clip's sound for independent editing. freeze_frame creates a still. set_framing adjusts fit, fill, zoom and pan; set_clip_keyframes animates a clip's transform.
Use select_items to find items from their recorded state and apply batch-capable tools with ids. Measure or watch first when the selection depends on media content. set_clip_hidden and track visibility tools preserve items while excluding them from playback and export.
Transitions sit at cuts and retain their positions as edits move footage. Inspect parkedTransitions after mutations and remove unused transitions. Read transitions-and-fades, color-grading or graphics for styling. Verify the changed span with capture_frame and listen_audio, and use undo or redo for the shared editor history.`,

  "watching-and-cutting": `# Watching footage and cutting by content
Inspect the project for asset ids, transcripts, trims, notes and existing coverage. ChatGPT interprets the returned frames and audio; Donkey Cut supplies measurements and timing. Watch footage before deciding cuts that depend on its content.
watch_video returns timestamped contact sheets, sceneChanges and coverage. Stamps are source seconds. Continue from coveredTo when truncated. For a request about the whole source, cover it until unwatchedSeconds reaches zero. For long footage, sweep coarsely to learn its structure, then inspect relevant spans closely. A source map or a transcript alone does not establish visual coverage. Use detail read or original to read text and match typography; scan is for structure. Check unreadSeconds and unreadFrom when legible coverage matters.
After every watch, record what you observed through edit_project with note_source: source span, actions, cuts, and exact on-screen words. A further watch can be refused until those observations are recorded. Notes persist on the asset; returned contact sheets belong to this conversation. Read observed, recorded and unnoted to resume from existing evidence.
listen_audio returns playable source audio. Use the transcript for words and listen for delivery, music and timing. Respect coveredTo; continue from unheardFrom until unheardSeconds reaches zero when judging a whole source. Record observations with note_source. A clip_id scopes listening to its source trim; from and to are source seconds.
Use signal measurements for editing decisions: detect_silence locates quiet spans; detect_beats returns a beat grid and timelineBeats for a clip; measure_level measures loudness and returns volumeToMatch against a target. read_color_stats measures exposure, tonal range and color before grading. compare_to_source checks the edit against a reference; capture_frame shows the composited picture. These read commands belong in inspect_project's commands array.
find_filler identifies transcript fillers; find_highlights ranks transcript spans. Their results need the relevant visual or audio check before cutting. Use edit_project for these commands unless list_commands marks them reads. Caption creation is a separate edit requested by the user.
Plan cuts around complete thoughts and measured pauses. Split and delete in batches, read the resulting ids, then place clips to close intended gaps. Leave room around speech boundaries and run refine_speech_cuts with the requested pace. Listen around adjusted edges, widen a clipped word's trim, and check the changed cut visually. Source seconds drive watches, listens and trims; timeline seconds drive placement and splits. Use the clip timing data to map between them.
Report only the coverage you inspected and the changes tool results confirm. render_preview produces a playable saved revision for the user to review.`,

  "background-removal": `# Background removal
set_removal mode auto starts the free person matte. remove background keeps the subject; remove subject keeps the surroundings. mode custom tracks the described subject and spends credits. refine requests the paid quality pass when the user asks for an upgrade. mode off retains the stored settings.
The matte prepares in the editor. Read each clip's removal readiness and progress with inspect_project; a command returning successfully can still leave matting in progress. Check capture_frame after it is ready. Poll a returned command job with get_job_status; that job's completion and the matte's readiness are separate results.
For one exact instance among similar subjects, ask the user to use Custom, Brush and Erase in the Cutout inspector and press Apply. set_removal_stroke adds an outline, and set_removal_background fills behind the kept subject. A lower video track can carry independently editable scenery.`,

  "graphics": `# Titles, graphics and motion
Use add_title or add_text_sequence for words, add_shape for geometry, add_sticker for an imported image, and add_effect for a treatment over a time range. Read describe_commands for the current supported styles and parameters. set_background sets the project's background color. Use ids and fonts reported by inspect_project.
update_overlay changes text, position, size, color and other element fields, and accepts ids for changes shared by several elements. Layout coordinates are frame fractions. Keep text inside the project's reported safe zones and check legibility with capture_frame.
set_overlay_keyframes and set_clip_keyframes animate poses at exact times. set_overlay_animation supplies entrances, exits, loops and word motion. set_mask clips a layer to a shape and can animate the reveal. Read text-videos for timed text and text-creativity for design choices.
Build composite effects as layers: add_overlay_video for copies of footage, masks for visible regions, shapes for bands, and text for labels. Match source trims so copied footage stays synchronized. Work out geometry and timing, build one representative piece, capture_frame to check it, then repeat and check the whole composition. create_sticker generates a new sticker and spends credits when the user requests it.`,

  "audio-and-subtitles": `# Audio and subtitles
Listen to the relevant source with listen_audio. Use detect_silence for pauses, detect_beats for music timing, and measure_level for level matching. Its volumeToMatch result can drive set_clip_volume or update_audio; use a fraction for a music bed beneath speech. Read watching-and-cutting for coverage and source-time rules.
update_audio edits soundtrack timing, source trim, volume, fades and ducking. A clip's duck lowers other audio while it plays. set_clip_sound applies EQ, compression and limiting to one clip; add_effect treats a time range of the mix. describe_commands supplies the supported presets and settings.
When captions are requested, subtitles_generate transcribes the cut; sync_lyrics aligns supplied words with the audio. subtitles_from_visuals writes descriptions of silent footage when the user wants them. captions_generate rewrites existing captions. These model-backed operations use the account's applicable allowance or credits.
Use update_cue, delete_cue and merge_cue for corrections. subtitles_add_track, subtitles_remove_track and subtitles_translate_track manage languages. set_caption_look controls appearance and words per cue; subtitles_set_view controls visibility. Current choices come from describe_commands, and text-videos covers timed text layouts. align_to_audio measures timing against the mix.
For requested audio generation, list_voices supplies voice ids, voiceover_generate speaks a script, read_subtitles_aloud voices timed cues, and generate_music makes music. Generation spends credits. Read the result for asset ids and placement, then inspect and listen to verify it. These commands are available through edit_project while the editor card is open.`,

  "ai-generation": `# Finding and creating media
Start with the user's project assets, attached files and links. import_media imports ChatGPT attachments or URLs into the cloud project. Poll a returned job with get_job_status, then use the asset ids in the completed result. Ask for missing footage or a reference when it is needed to fulfill the request.
stock_search finds existing footage, images and sounds; stock_add imports a chosen result. Inspect the media before placing it. ChatGPT can plan a sequence from the supplied footage and use add_clip with blocks to mark missing shots for the user.
Available generation commands include generate_image, voiceover_generate, generate_music and create_sticker. Use them when the user requests generated media; they spend account credits. Read describe_commands for current options. Inspect returned asset ids and placement, and place an unplaced asset with add_clip or add_overlay_video when the user asked for it in the cut.
Use the commands returned by list_commands. When a requested operation is unavailable, explain the limit and ask the user to supply the required media or complete that step in Donkey Cut.`,

  "media-and-library": `# Media and Library
inspect_project reports the open project's media. import_media brings files and links into it. add_clip and add_overlay_video place assets, replace_item changes an item's source, and file_asset files created media into Media or copies it to the Library. media_organize manages this project's folders. convert_media converts project assets; read its result and inspect the updated assets before claiming completion.
library_list reads reusable assets, folders and templates across projects. library_add copies an asset into the project; template_add restores a saved arrangement; save_template stores selected timeline items. library_organize manages that shelf. notes_list reads the user's synced scripts and ideas. Read replicating-a-project to reuse an existing edit.
delete_asset removes project media and its timeline uses. Library deletions can affect the user's synced shelf. These deletions require the user's explicit request; undo covers timeline edits and does not restore deleted source files.`,

  "replicating-a-project": `# Reusing a project
read_project inspects a source project or share link. Use its returned ids and document to understand the edit; use watch_video and listen_audio for media you need to judge. Ask for a reference the user can share when access fails.
replicate_project copies the requested edit or items and can map source roles to assets already in this project. Match by content and measured timing. Unmapped media copies from the reference. copy_project_media brings across media for a new arrangement.
Read the resulting adjustments and placement: trims can clamp to shorter replacement sources, and clips append to the current cut. Inspect the result, revise the requested text and timing, and check frames and audio. Apply background removal to replacement footage when requested. save_template and template_add support reusable arrangements.`,

  "publish-and-export": `# Publish and export
set_publish edits the project's caption, tags, sound title and handle. These fields describe the intended post.
export_video renders the saved cloud project with one of these presets: ${DOC_EXPORT_PRESETS.join(", ")}. Read its tool description for the preset choices. A returned export job is completed through get_export_status, and the card offers the finished download. render_preview and get_preview_status provide a playable preview for review. Only report a preview or export as ready when its result confirms completion.`,
};

export const SKILL_INDEX = Object.keys(SKILLS);

export function readSkill(name: string): string | undefined {
  return Object.hasOwn(SKILLS, name) ? SKILLS[name] : undefined;
}
