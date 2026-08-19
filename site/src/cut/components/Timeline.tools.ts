/**
 * The assistant's timeline tools — selection, cutting, placement, tracks,
 * overlay video layers, the toolbar's Text button, freeze frames, and the
 * timeline view — kept beside the timeline component that exposes the same
 * editing surface. The catalog spreads this list into the model's toolset
 * and `aiTools.ts` keys its handlers on `TimelineToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
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
      "Select a video clip (on any track), soundtrack clip, or overlay element — title, shape, or sticker (or clear the selection). Selection drives the inspector panel.",
    inputSchema: obj({
      kind: { type: "string", enum: ["clip", "audio", "overlay", "none"], description: "What to select — 'clip' is any video clip, whatever track; 'overlay' is any title-lane element" },
      id: str("The item id (omit for kind=none)"),
    }, ["kind"]),
  },
  {
    name: "split_at",
    description:
      "Split the video (or a selected soundtrack/overlay clip) at a time, like pressing S. Omit t to split at the playhead. Splits don't move times, so issue every planned split together in one round. The result carries the updated track-0 and soundtrack rows (ids, starts, lengths) — read the new ids from there.",
    inputSchema: obj({ t: num("Timeline seconds to cut at (optional)") }),
  },
  {
    name: "move_clip",
    description:
      "Reorder a track-0 video clip to a new index: it lifts out (its old spot becomes a gap) and clips from the landing index shift right to make room — nothing else moves, so sound and titles stay synced. To move one clip in time, use place_clip.",
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
      "Put a project asset on the timeline, the same way the user dragging it in would: a video or image lands on video track 0 (at `start`, inserted at `index`, or appended at the end; a taken spot slides it right), audio lands on the soundtrack (at `start`, default the playhead). Asset ids come from `media` in editor_state — imports, attachments, and chat media alike. Call it only when the user asked for the media in the cut (\"add my beach photo\", \"stitch these into a movie\"); otherwise media stays on its card or panel for them to drag.",
    inputSchema: obj({
      asset_id: str("Project asset id from `media` in editor_state"),
      start: num("Timeline start s"),
      index: num("Insert position on video track 0 (video/image only; 0 = first)"),
    }, ["asset_id"]),
  },
  {
    name: "trim_clip",
    description:
      "Set a video clip's trim points inside its source media (seconds). Changing `in` hides the leading part; `out` the trailing part.",
    inputSchema: obj({ clipId: str("Video clip id"), in: num("New in point (optional)"), out: num("New out point (optional)") }, ["clipId"]),
  },
  {
    name: "refine_speech_cuts",
    description:
      "True up speech-cut edges mechanically: re-scans the audio around each clip's in/out and re-trims so every edge sits a ~0.25s breath inside a real pause — an edge that clips a word moves outward to the next pause, stray dead air trims off. Clip spacing survives: a tightened clip closes up, butted joints stay butted, and deliberate gaps keep their width. An edge with no pause within ~2s stays put and comes back flagged. Run it on every clip you recut for speech, after cutting and before listening; leave out clips whose edge you placed mid-speech on purpose.",
    inputSchema: obj(
      {
        clip_ids: {
          type: "array",
          items: { type: "string" },
          description: "Video clip ids whose in/out edges are speech cuts",
        },
      },
      ["clip_ids"]
    ),
  },
  {
    name: "set_clip_muted",
    description: "Mute or unmute a video clip's own audio.",
    inputSchema: obj({ clipId: str("Video clip id"), muted: bool("true to mute") }, ["clipId", "muted"]),
  },
  {
    name: "set_clip_hidden",
    description:
      "Hide or show a video clip on any track. A hidden clip stays on the timeline (grayed) but is excluded from playback and export — its span plays black and silent on track 0; an overlay layer just disappears.",
    inputSchema: obj({ clipId: str("Video clip id"), hidden: bool("true to hide") }, ["clipId", "hidden"]),
  },
  {
    name: "set_track_hidden",
    description:
      "Hide or show a whole timeline row at once — the track header's eye toggle. Applies to every item on that row: a hidden video track plays black and silent, a hidden soundtrack lane is silent, hidden text (title) lanes and subtitle tracks drop out of the picture. Items stay on the timeline, grayed.",
    inputSchema: obj({
      kind: { type: "string", enum: ["video", "soundtrack", "text", "subtitles"], description: "Which row kind" },
      track: num("Track/lane index, 0-based"),
      hidden: bool("true to hide"),
    }, ["kind", "track", "hidden"]),
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
      "Delete a video clip (any track), soundtrack clip, or overlay element (title/shape/sticker) by id. While track 0 is the only video track, deleting a track-0 clip ripples: its footprint closes and everything after it — clips, titles, captions, soundtrack — slides left in sync; items wholly inside that span are removed with it, straddlers are trimmed. With overlay video tracks present the delete leaves its gap in place (remove_gap closes it). Deletes on other tracks remove just that item.",
    inputSchema: obj({
      kind: { type: "string", enum: ["clip", "audio", "overlay"], description: "Item kind — 'clip' is any video clip, whatever track; 'overlay' is any title-lane element" },
      id: str("Item id"),
    }, ["kind", "id"]),
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
      "Update an overlay video clip: move it (start, track), trim (in/out), mute, hide, change its frame region (layout preset, or a custom region rect in frame fractions), fit, or speed.",
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
      speed: num("Playback rate (1 = normal, no upper limit)"),
    }, ["id"]),
  },
  {
    name: "add_title",
    description:
      "Add a text title overlay. Position is the text center as a fraction of the frame (x,y in 0..1; y=0.42 is the default band). Size is px at 1080-wide. Font ids come from the graphics skill (system set + the bundled Google families).",
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
      "Place a run of text on the timeline in one call — a lyric video, a kinetic-typography passage, a quote sequence — composed by a named look. `look` carries the design of one line (frame color, cards, type, entrance) AND the ensemble the run walks across its whole length: where successive lines land, which faces they rotate through, which entrances, and what each line does while it holds. So one call already produces a varied, composed run; it never lays a hundred identical lines at dead center. Lines come from `lines` ({text, start, end} in timeline seconds), or from the caption track with from_captions when a sync already timed them. Mark the loud lines with `emphasis: \"hero\"` and the quiet ones `\"whisper\"`, and label passages with `section` (\"verse\", \"chorus\") — a new section restarts the type and color rotas, so a chorus does not look like the verse before it. Anything you set per line (font, x/y, rotation, in_style, move, color, size) wins over the ensemble. The words land on `lane` and each card on the row under them. It sets the project background to the look's frame color unless background is false. Look ids, layouts and moves are in the text-videos and text-creativity skills.",
    inputSchema: obj({
      look: str("Look id from the text-videos skill (default lyric-card)"),
      variation: {
        type: "string",
        enum: [...TEXT_VARIATION_IDS],
        description:
          "How far the run departs from one repeated design. bold (default) walks the look's whole ensemble — faces, tilts, palette, keyframe moves; subtle keeps one typeface and varies placement and entrance; none lays every line identical, for a run you intend to hand-compose.",
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
              description: `What this line does WHILE it holds (a keyframe move; the entrance is separate). ${TEXT_MOVE_IDS.filter((m) => m !== "none").map((m) => `${m}: ${TEXT_MOVE_NOTES[m]}`).join(" ")}`,
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
    name: "freeze_frame",
    description:
      "Extract the video frame at a time (default: the playhead — what the user is looking at) as a still clip and insert it into the timeline. Default insert position is index 0, making it the first thing viewers see (a cover/hook frame).",
    inputSchema: obj({
      t: num("Timeline time of the frame to grab (default: playhead)"),
      duration: num("Still clip length in seconds, 0.5–10 (default 1)"),
      index: num("Insert position on the video track (default 0 = first)"),
    }),
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
