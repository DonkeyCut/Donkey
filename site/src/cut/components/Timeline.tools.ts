/**
 * The assistant's timeline tools — selection, cutting, placement, tracks,
 * overlay video layers, the toolbar's Text button, freeze frames, and the
 * timeline view — kept beside the timeline component that exposes the same
 * editing surface. The catalog spreads this list into the model's toolset
 * and `aiTools.ts` keys its handlers on `TimelineToolName`.
 */

import { bool, ids, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { ITEM_KIND_IDS, canSplitItem } from "@/cut/lib/itemKinds";
import { TIMELINE_ITEM_KINDS } from "@/cut/lib/timelineGroups";
import {
  TEXT_EMPHASIS_IDS,
  TEXT_LAYOUT_IDS,
  TEXT_LAYOUT_NOTES,
  TEXT_VARIATION_IDS,
} from "@/cut/lib/textCompose";
import { TEXT_MOVE_IDS, TEXT_MOVE_NOTES } from "@/cut/lib/textMotion";
import { OVERLAY_ANIM_STYLE_IDS } from "@donkeycut/effects-kit";

export const TIMELINE_TOOLS = [
  {
    name: "select",
    description:
      "Select any timeline item: video, audio, an overlay element, caption cue, or transition (or clear the selection). Selection appears in the timeline and preview. Use additive:true to toggle an item in the selection; move_selection moves the selected visual items together.",
    inputSchema: obj({
      kind: { type: "string", enum: [...TIMELINE_ITEM_KINDS, "none"], description: "What to select — 'clip' is any video clip, whatever track; 'overlay' is any title-lane element" },
      id: str("The item id (omit for kind=none)"),
      additive: bool("Toggle this item in the existing selection"),
    }, ["kind"]),
  },
  {
    name: "group_items",
    description: "Group the selected timeline items, including video, audio, text, shapes, captions and transitions. Use select with additive:true to build the selection first. New items start ungrouped. Selecting any group member selects the whole group; drag a member to move the group.",
    inputSchema: obj({}),
  },
  {
    name: "ungroup_items",
    description: "Ungroup every group represented in the current selection. Items keep their timing and become independently selectable and movable.",
    inputSchema: obj({}),
  },
  {
    name: "move_timeline_selection",
    description: "Move selected timeline items and their group members together by delta seconds, preserving relative timing and caption word timings. Negative moves stop at the timeline start; occupied rows move the set to the next free position. Use this for a grouped selection, including captions and transitions.",
    inputSchema: obj({ delta: num("Timeline shift in seconds") }, ["delta"]),
  },
  {
    name: "split_at",
    description:
      `Split selected items and group members at a time, like pressing S. Supported kinds: ${ITEM_KIND_IDS.filter(canSplitItem).join(", ")}. Transitions remain whole. With no selection, split the video on track 0. Omit t for the playhead. Times stay fixed; the result includes the new selected ids.`,
    inputSchema: obj({ t: num("Timeline seconds to cut at (optional)") }),
  },
  {
    name: "move_clip",
    description:
      "Reorder a track-0 video clip to a new index: its old spot becomes a gap and clips from the landing index shift right to make room. The moved clip and displaced clips carry their group members with relative timing preserved. Occupied rows can move a group farther right. To set a timeline start, use place_clip.",
    inputSchema: obj({ clipId: str("Video clip id"), toIndex: num("Target index, 0-based") }, ["clipId", "toIndex"]),
  },
  {
    name: "place_clip",
    description:
      "Move a track-0 video clip to a timeline start time (seconds). The track is free-positioned: gaps are allowed and play black. If another clip occupies that spot, the clip slides right to the next free one.",
    inputSchema: obj({ clipId: str("Video clip id"), start: num("Target timeline start s") }, ["clipId", "start"]),
  },
  {
    name: "add_clip",
    description:
      "Put a project asset on the timeline, the same way the user dragging it in would: a video or image lands on video track 0 (at `start`, inserted at `index`, or appended at the end; a taken spot slides it right), audio lands on the soundtrack (at `start`, default the playhead). Asset ids come from `media` in editor_state — imports, attachments, and chat media alike. Call it only when the user asked for the media in the cut (\"add my beach photo\", \"stitch these into a movie\"); otherwise media stays on its card or panel for them to drag. Pass `blocks` instead of an asset to lay out a cut whose footage does not exist yet: one block per shot on track 0, each the length that shot runs, labelled with what belongs there. That is how a video you watched becomes a timeline — the cuts land at their real times, titles and sound go on top, and the person fills each block later. Blocks own no file and store nothing; footage dropped on one takes its place and its length, and replace_item does the same from here. Pass `spans` to cut one source into a run of clips — the moments of a talk worth keeping, with everything between them left out, or a video cut at its own shot boundaries when its picture is what plays.",
    inputSchema: obj({
      asset_id: str("Project asset id from `media` in editor_state"),
      blocks: {
        type: "array",
        description: "Shots with no footage yet, in order — one block each on track 0",
        items: obj(
          {
            seconds: num("How long this shot runs on the timeline"),
            label: str("What the person puts here. It names the slot on its timeline chip; the frame itself is the flat colour"),
            color: str("The shot's backdrop as #rrggbb, so the slot carries the look it sits in"),
          },
          ["seconds"]
        ),
      },
      spans: {
        type: "array",
        description:
          "Stretches of this source, in SOURCE seconds — one clip each, in order. Gapped spans keep the moments and drop the rest; spans that meet cut the source at those boundaries.",
        items: obj({ from: num("Source start s"), to: num("Source end s") }, ["from", "to"]),
      },
      lane: { type: "integer", minimum: 0, description: "Audio assets only: soundtrack lane, default 0. Put music on lane 1 to overlap narration on lane 0." },
      start: num("Timeline start s"),
      index: num("Insert position on video track 0 (video/image only; 0 = first)"),
    }),
  },
  {
    name: "trim_clip",
    description:
      "Set a video clip's source trim points in seconds. Growth pushes overlapping neighbors on its own video track; shrinking leaves a gap. Other rows keep their timing.",
    inputSchema: obj({ clipId: str("Video clip id"), in: num("New in point (optional)"), out: num("New out point (optional)") }, ["clipId"]),
  },
  {
    name: "refine_speech_cuts",
    description:
      "True up speech-cut edges against the words themselves: re-reads the audio around each clip's in/out, measures that recording's own room tone and voice level, finds where the words actually start and finish — tails and soft attacks included — and re-trims so every edge sits a measured beat clear of one. An edge inside a word moves outward until the word is whole; stray dead air trims off. THIS IS WHERE PACE IS SET: `pace` fast|natural|relaxed chooses how much air is left (~0.14s/0.26s/0.45s after the last word, ~0.09s/0.16s/0.28s before the next), and even fast never cuts closer than 0.08s to a word. Cutting closer than the pace is not faster, it is clipped. Clip spacing survives: a tightened clip closes up, butted joints stay butted, deliberate gaps keep their width, and where a pause is too short for both sides' air the two edges meet inside it. An edge with no word within ~2s stays put and comes back flagged. Run it on every clip you recut for speech, after cutting and before listening; leave out clips whose edge you placed mid-speech on purpose.",
    inputSchema: obj(
      {
        clip_ids: {
          type: "array",
          items: { type: "string" },
          description: "Video clip ids whose in/out edges are speech cuts",
        },
        pace: {
          type: "string",
          enum: ["fast", "natural", "relaxed"],
          description:
            "How much air each edge keeps around the words — fast for a punchy recut, relaxed to let it breathe. Default natural.",
        },
      },
      ["clip_ids"]
    ),
  },
  {
    name: "set_clip_muted",
    description: "Mute or unmute a video clip's own audio.",
    inputSchema: obj({ clipId: str("Video clip id"), ids: ids("clipId"), muted: bool("true to mute") }, ["muted"]),
  },
  {
    name: "rename_item",
    description:
      "Name any timeline item — a video or image clip on any track, a soundtrack clip, or a title/shape/sticker/effect element — by id. The name shows on its timeline bar, in the inspector and in editor_state, so a cut full of look-alike items stays legible. An empty name clears it, back to the file's name or what the element is.",
    inputSchema: obj({ id: str("Clip, soundtrack clip, or element id"), name: str("The name, up to 60 characters; empty clears") }, ["id", "name"]),
  },
  {
    name: "set_clip_hidden",
    description:
      "Hide or show a video clip on any track. A hidden clip stays on the timeline (grayed) but is excluded from playback and export — its span plays black and silent on track 0; an overlay layer just disappears.",
    inputSchema: obj({ clipId: str("Video clip id"), ids: ids("clipId"), hidden: bool("true to hide") }, ["hidden"]),
  },
  {
    name: "set_track_hidden",
    description:
      "Hide or show a whole timeline row at once — the row's eye toggle. Applies to every item on that row: a hidden video track plays black and silent, a hidden soundtrack lane is silent, hidden text (title) lanes and subtitle tracks drop out of the picture, and hidden transitions leave their cuts hard. Items stay on the timeline, grayed. The transitions row is the only one of its kind, so omit `track` for it.",
    inputSchema: obj({
      kind: {
        type: "string",
        enum: ["video", "soundtrack", "text", "subtitles", "transitions"],
        description: "Which row kind",
      },
      track: num("Track/lane index, 0-based; omit for transitions"),
      hidden: bool("true to hide"),
    }, ["kind", "hidden"]),
  },
  {
    name: "set_track_muted",
    description:
      "Mute or unmute every clip on one video track at once — the track header's speaker toggle. The picture keeps playing.",
    inputSchema: obj({ track: num("Video track index, 0-based"), muted: bool("true to mute") }, ["track", "muted"]),
  },
  {
    name: "reorder_track",
    description:
      "Move a whole timeline row to another place in its own band — the gutter drag. Rows only ever reorder among their own kind: video tracks restack (row 0 is the bottom track, the spine that carries ripple and transitions; higher rows composite in front), element rows and soundtrack lanes renumber from there. Everything on the row travels with it and keeps its times.",
    inputSchema: obj({
      kind: { type: "string", enum: ["video", "soundtrack", "text"], description: "Which band the row belongs to" },
      from: num("The row's current index, 0-based"),
      to: num("The index it should end up at, 0-based"),
    }, ["kind", "from", "to"]),
  },
  {
    name: "delete_item",
    description:
      "Delete a timeline item and its explicit group by id. Other items keep their timing. The deleted footprint becomes a gap; remove_gap closes it.",
    inputSchema: obj({
      kind: { type: "string", enum: TIMELINE_ITEM_KINDS, description: "Item kind — 'clip' is any video clip, whatever track; 'overlay' is any title-lane element" },
      id: str("Item id"),
      ids: ids("id"),
    }, ["kind"]),
  },
  {
    name: "remove_gap",
    description:
      "Close the empty span on one video track containing `at` seconds: that track's later clips slide left to shut the gap; every other track, titles, captions, and the soundtrack stay put. Errors unless `at` falls inside a gap on that track.",
    inputSchema: obj({
      at: num("A time (seconds) inside the gap to close"),
      track: num("Video track the gap is on (default 0)"),
    }, ["at"]),
  },
  {
    name: "add_overlay_video",
    description:
      "Put a project video or image asset on an overlay video track, composited over track 0: tracks stack bottom-up, and the topmost full-frame clip covers everything below. Pick a layout to share the frame — halves for a split screen, pip for picture-in-picture. Asset ids come from `media` in the editor state.",
    inputSchema: obj({
      asset_id: str("Project asset id (video or image)"),
      start: num("Timeline start s (default: the playhead)"),
      track: num("Video track, 1 or higher; 1 = first layer above track 0, higher = further in front (default 1)"),
      layout: {
        type: "string",
        enum: ["full", "top", "bottom", "left", "right", "pip"],
        description: "Frame region (default full = covers the frame)",
      },
    }, ["asset_id"]),
  },
  {
    name: "update_overlay_video",
    description:
      "Update an overlay video clip: move it (start, track), trim (in/out), mute, hide, change its frame region (layout preset, or a custom region rect in frame fractions), fit, zoom, mirror (flipH/flipV), rotation, opacity, or speed.",
    inputSchema: obj({
      id: str("Overlay video clip id"),
      start: num("Timeline start s"),
      in: num("Source in s"),
      out: num("Source out s"),
      track: num("Video track, 1 or higher; higher = further in front"),
      muted: bool("Mute the clip's own audio"),
      hidden: bool("Hide the layer without deleting it"),
      layout: {
        type: "string",
        enum: ["full", "top", "bottom", "left", "right", "pip"],
        description: "Frame region preset",
      },
      region: obj({
        x: num("Left edge 0..1"),
        y: num("Top edge 0..1"),
        w: num("Width 0..1"),
        h: num("Height 0..1"),
      }, ["x", "y", "w", "h"]),
      fit: { type: "string", enum: ["fit", "fill"], description: "How the video meets its region" },
      zoom: num("Zoom the picture past its fitted size, 1 (none) .. 4; the overflow crops"),
      flipH: bool("Mirror the picture horizontally (left for right)"),
      flipV: bool("Mirror the picture vertically (top for bottom)"),
      rotation: num("Resting turn in degrees clockwise, -180..180 (0 clears)"),
      opacity: num("Resting opacity 0..1 (1 clears)"),
      speed: num("Playback rate (1 = normal, no upper limit)"),
    }, ["id"]),
  },
  {
    name: "add_title",
    description:
      "Add a text title overlay. Position is the text center as a fraction of the frame (x,y in 0..1; y=0.42 is the default band). Size is px at 1080-wide. Font ids come from the graphics skill (system set + the bundled Google families). A line wider than the room its anchor leaves is broken onto more lines when it draws, so a title always sits inside the frame — write the words and pick the size the design wants.",
    inputSchema: obj({
      text: str("The title text (\\n for line breaks)"),
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.42)"),
      size: num("Font size px at 1080w (default 88)"),
      color: str("CSS color (default #FFFFFF)"),
      font: str("Font id (see the graphics skill; default sf)"),
      weight: { type: "number", enum: [400, 700], description: "Font weight" },
      italic: bool("Italic"),
      align: { type: "string", enum: ["left", "center", "right"], description: "Multi-line alignment (default center)" },
      letter_spacing: num("Tracking in em (0 = normal, 0.1 = airy)"),
      line_height: num("Line height multiplier (default 1.25)"),
      stroke_color: str("Text outline color"),
      stroke_width: num("Text outline width in em (0..0.15; 0 removes it)"),
      shadow: bool("Drop shadow (default true)"),
      plate: bool("Translucent plate behind text (default false)"),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
      lane: num("Element row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, ["text"]),
  },
  {
    name: "add_text_sequence",
    description:
      "Place a run of text on the timeline in one call — plain lines timed to speech, a lyric video, a kinetic-typography passage, a quote sequence. Design is opt-in: with no `look` the run comes out plain — one readable face, one place in the frame, a short fade, no cards, no moves, and the project's frame color untouched. That is what a bare \"add the text\" or \"put the words on screen\" asks for. Name a `look` when the user asked for a designed run (a lyric video, kinetic type, a style, a vibe, \"make it interesting\"): `look` carries the design of one line (frame color, cards, type, entrance) AND the ensemble the run walks across its whole length: where successive lines land, which faces they rotate through, which entrances, and what each line does while it holds. So one such call already produces a varied, composed run without a hundred repair calls after it. Lines come from `lines` ({text, start, end} in timeline seconds), or from the caption track with from_captions when a sync already timed them. In a designed run, mark the loud lines with `emphasis: \"hero\"` and the quiet ones `\"whisper\"`, and label passages with `section` (\"verse\", \"chorus\") — a new section restarts the type and color rotas, so a chorus does not look like the verse before it. Anything you set per line (font, x/y, rotation, in_style, move, color, size) wins over the ensemble. The words land on `lane` and each card on the row under them. A look that paints a frame color sets the project background to it unless background is false; the plain and over-footage looks leave the background alone unless background is true. Look ids, layouts and moves are in the text-videos and text-creativity skills.",
    inputSchema: obj({
      look: str("Look id from the text-videos skill. Omit it for the plain run — that is the default and the right answer whenever the user did not ask for a design."),
      variation: {
        type: "string",
        enum: [...TEXT_VARIATION_IDS],
        description:
          "How far the run departs from one repeated design. Defaults to what the look carries: the plain look runs at none, the designed looks at bold. bold walks the look's whole ensemble — faces, tilts, palette, moves; subtle keeps one typeface and varies placement and entrance; none lays every line identical.",
      },
      layout: {
        type: "string",
        enum: [...TEXT_LAYOUT_IDS],
        description: `Where successive lines land, overriding the look's own. ${TEXT_LAYOUT_IDS.map((id) => `${id}: ${TEXT_LAYOUT_NOTES[id]}`).join(" ")}`,
      },
      lines: {
        type: "array",
        description: "The run, in order. Omit times on a line and it follows the one before it.",
        items: obj(
          {
            text: str("The line (\\n for a break inside it)"),
            start: num("Timeline start s"),
            end: num("Timeline end s"),
            emphasis: {
              type: "string",
              enum: [...TEXT_EMPHASIS_IDS],
              description:
                "How loud this line is: hero is markedly bigger and takes the look's hero move, whisper is small and quiet. Default normal.",
            },
            section: str('Passage label ("verse", "chorus", "bridge") — a new label restarts the type and color rotas'),
            color: str("Override the run's color for this line"),
            size: num("Override the composed size for this line"),
            font: str("Override the face carrying this line"),
            x: num("Frame-width fraction 0..1, overriding the layout"),
            y: num("Frame-height fraction 0..1, overriding the layout"),
            rotation: num("Tilt in degrees, -45..45"),
            in_style: {
              type: "string",
              enum: [...OVERLAY_ANIM_STYLE_IDS],
              description: "Entrance for this line, overriding the rota",
            },
            move: {
              type: "string",
              enum: [...TEXT_MOVE_IDS],
              description: `What this line does WHILE it holds (the entrance is separate). ${TEXT_MOVE_IDS.filter((m) => m !== "none").map((m) => `${m}: ${TEXT_MOVE_NOTES[m]}`).join(" ")}`,
            },
          },
          ["text"]
        ),
      },
      from_captions: num("Build the run from this caption track's cues (0-based) instead of `lines`"),
      lane: num("Row for the words; their color cards go one row under them (default 0, the front row)"),
      cards: bool("Paint the look's color cards behind each line (default: whatever the look does)"),
      background: bool("Set the project background to the look's frame color (default true)"),
    }),
  },
  {
    name: "replace_item",
    description:
      "Replace what an item plays, keeping the item: a video clip (including a blocked-out shot) keeps its place and its length and plays the asset you name instead, trimmed from that source's head; a soundtrack clip keeps its slot; a sticker shows the new image. This is how a block becomes the person's own footage (\"put the kitchen clip in shot 3\"), and how any clip swaps its source without moving what comes after. A block left playing nothing goes with it.",
    inputSchema: obj(
      {
        id: str("The item to refill — a video clip, a soundtrack clip, or a sticker"),
        asset_id: str("Project asset that plays there instead"),
      },
      ["id", "asset_id"]
    ),
  },
  {
    name: "freeze_frame",
    description:
      "Extract the video frame at a time (default: the playhead — what the user is looking at) as a still clip and insert it into the timeline. Default insert position is index 0, making it the first thing viewers see (a cover/hook frame).",
    inputSchema: obj({
      t: num("Timeline time of the frame to grab (default: playhead)"),
      duration: num("Still clip length in seconds, 0.5–10 (default 1)"),
      index: num("Insert position on the video track (default 0 = first)"),
      with_elements: bool(
        "Bake the whole picture as the preview shows it — titles, captions and effects burned into the still (default false: the video frame alone)"
      ),
    }),
  },
  {
    name: "select_items",
    description:
      'Find every item a description covers, in one call: "the clips with no one talking", "the titles that are all caps", "the short ones at the end". Each item on the track is judged against the description at once and the matches come back as ids — this is how a sweep is done, instead of reading the state and deciding one item at a time. Then land the change on all of them with a single call: set_clip_muted, set_clip_hidden, set_clip_volume, set_color_preset, set_speed, set_framing, set_transition, delete_item, update_cue, delete_cue, update_audio and update_overlay all take `ids` in place of their one-item argument, and the whole write is one undo step. Describe what the items have in common, not what to do with them. It judges what the timeline already says about each item — its name, timing, text, and settings — so anything that needs the footage watched or the audio heard is measured first (watch_video, detect_silence, measure_level) and the finding is done here.',
    inputSchema: obj(
      {
        kind: {
          type: "string",
          enum: [...TIMELINE_ITEM_KINDS],
          description: "Which row of the timeline to look through",
        },
        describe: str("What the wanted items have in common, in plain words"),
        limit: num("At most this many ids, best fit first (default: every match)"),
      },
      ["kind", "describe"]
    ),
  },
  {
    name: "set_view",
    description:
      "Adjust the timeline view: zoom (pxPerSec 12..800), fit the whole cut, or panel height (170..600).",
    inputSchema: obj({
      pxPerSec: num("Zoom in px per second"),
      fit: bool("Fit the whole cut to the window"),
      timelineH: num("Timeline panel height px"),
    }),
  },
] as const satisfies readonly AiToolDef[];

export type TimelineToolName = (typeof TIMELINE_TOOLS)[number]["name"];
