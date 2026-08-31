/**
 * The assistant's Library tools — browsing the shared shelf, importing its
 * assets and templates into the project, saving new templates, and
 * organizing folders — kept beside the Library view that exposes the same
 * shelf inside the Media tab. The catalog spreads this list into the model's
 * toolset and `aiTools.ts` keys its handlers on `LibraryToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const LIBRARY_TOOLS = [
  {
    name: "library_list",
    description:
      "List the shared Library — reusable media saved across projects: folders (nested; a folder's parentId names the folder it sits in), assets (video/audio/image, and the account's own font files), and templates (saved arrangements of clips, overlays, titles, and captions). An asset's `origin` says it came from the user's iOS app: \"camera\" is a clip they recorded on their phone (their Camera Roll), \"inspiration\" a reference they saved to the Inspiration folder. Library items live outside the project: library_add imports an asset, template_add re-materializes a template.",
    inputSchema: obj({}),
  },
  {
    name: "notes_list",
    description:
      "List the user's synced notes — short scripts and ideas written in the Donkey Cut iOS app or the desktop Notes tab — with the folders they are filed in and the labels they carry. Read them when the user points at \"my note(s)\" for a script, caption, or voiceover text; when they name a folder (\"the scripts folder\") match it against `folders` and read the notes carrying that folder; when they name a label (\"my hook ideas\") match it against `labels` and read the notes wearing it. Quote a note's body verbatim when they ask for its words.",
    inputSchema: obj({}),
  },
  {
    name: "library_add",
    description:
      "Copy a Library asset into the project (it appears in `media` and previews as a card in this chat). This is the import step \"library\"-scope attachments need before editor tools can touch them. Fonts are not imported — a font on the shelf is already offered to every project as font id \"font:<id>\". Pass add_to_timeline:true (or start/index) only when the user asked for it in the cut: video/image land on track 0, audio on the soundtrack.",
    inputSchema: obj({
      id: str("Library asset id (from library_list or an attachment's metadata)"),
      add_to_timeline: bool("Also place it on the timeline (default false — it stays a project asset until the user asks)"),
      start: num("Timeline start s (implies add_to_timeline)"),
      index: num("Insert position on video track 0 (video/image; implies add_to_timeline)"),
    }, ["id"]),
  },
  {
    name: "template_add",
    description:
      "Re-materialize a template into the project: its clips, overlays, titles, and captions land editable, exactly as saved (clip layers append to track 0; free-positioned parts line up at the playhead). A Library template's media import as assets on the way in; a template saved in this project's own Media reuses the media already here. Call it only when the user asked for the template in the cut.",
    inputSchema: obj(
      { id: str("Template id — from library_list, or the id carried by a template the user referenced") },
      ["id"],
    ),
  },
  {
    name: "save_template",
    description:
      "Save timeline items as a reusable template in this project's Media, kept by reference — the source media plus the edit arranging it, re-editable when added back. The user can push it to the shared Library from the Media panel. Pass the ids of the items to include: video clips (any track), soundtrack clips, titles, and subtitle cues.",
    inputSchema: obj({
      name: str("Template name"),
      item_ids: {
        type: "array",
        items: { type: "string" },
        description: "Timeline item ids to include",
      },
    }, ["name", "item_ids"]),
  },
  {
    name: "library_organize",
    description:
      "Organize the shared Library. Folders nest: create_folder makes one at the root or inside parent_id, rename_folder renames, move_folder files a folder under another (omit parent_id for the root; never into itself or a folder inside it), delete_folder removes one (what it held — items and folders — moves up one level). move_asset files an asset or template into a folder (omit folder_id for the root), delete_asset / delete_template remove an item. Deletes are permanent — projects keep their own copies, but delete only what the user explicitly asked to remove. Deleting an asset with origin \"camera\" or \"inspiration\" takes it off the user's phone as well.",
    inputSchema: obj({
      action: {
        type: "string",
        enum: ["create_folder", "rename_folder", "move_folder", "delete_folder", "move_asset", "delete_asset", "delete_template"],
        description: "The organize operation",
      },
      name: str("Folder name (create_folder, rename_folder)"),
      folder_id: str("Folder id (rename_folder, move_folder, delete_folder, move_asset destination — omit for root)"),
      parent_id: str("The folder to file a folder inside (create_folder, move_folder) — omit for the root"),
      id: str("Library asset or template id (move_asset, delete_asset, delete_template)"),
    }, ["action"]),
  },
] as const satisfies readonly AiToolDef[];

export type LibraryToolName = (typeof LIBRARY_TOOLS)[number]["name"];
