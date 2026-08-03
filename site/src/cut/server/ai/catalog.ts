/**
 * The assistant's tool catalog and skills library.
 *
 * Tools are defined once here (JSON Schema) and exposed to both providers
 * through the stdio MCP proxy. Every tool except the `server: true` ones is
 * executed in the browser against the editor store, so the assistant edits
 * the exact same state the user sees.
 */

import { ANIM_STYLE_IDS, TRANSITION_STYLE_IDS } from "../../lib/types";

export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Handled directly by the server (no browser round-trip). */
  server?: boolean;
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const bool = (description: string) => ({ type: "boolean", description });

export const AI_TOOLS: AiToolDef[] = [
  {
    name: "get_state",
    description:
      "Read the full current editor state: clips, soundtrack, overlay elements (titles, shapes, stickers), subtitles, selection, playhead, view settings, publish metadata. Use this whenever the context snapshot is not enough or might be stale.",
    inputSchema: obj({}),
  },
  {
    name: "capture_frame",
    description:
      "Capture the composited video frame the preview shows at the playhead as an image. Titles and captions are drawn over the canvas in the UI, so they don't appear here — this checks the footage, not the text.",
    inputSchema: obj({}),
  },
  {
    name: "watch_video",
    description:
      "Watch a video source with your own eyes: samples its frames at scene changes plus a steady floor into timestamped contact-sheet images, and returns the detected scene-change times (natural cut candidates). Pass clip_id to watch a timeline clip's source (the result includes that clip's source↔timeline time math) or asset_id for any project video or image. The stamp burned into each cell is SOURCE seconds — what trim_clip's in/out use — not timeline seconds. Coverage is capped per call: survey the whole range first, then call again with a narrow from/to and a small interval_seconds where the cut needs care; the result says where coverage stopped. Read the watching-and-cutting skill before editing footage by content.",
    inputSchema: obj({
      clip_id: str("Video clip id, track 0 or overlay (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (video or image) — watch the source itself"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end; spans at most 600s per call)"),
      interval_seconds: num("Target seconds between sampled frames, 0.5–30 (default spreads ~32 frames across the range)"),
    }),
  },
  {
    name: "detect_silence",
    description:
      "Find silent stretches in a source's audio — dead air, long pauses, gaps between takes. Returns [{start,end,duration}] in SOURCE seconds, plus each one's timeline times when clip_id is passed. Cheap and image-free; pair it with the transcript's cue timings to find filler, then cut with split_at / trim_clip / delete_item — place speech cuts inside these spans (cue timings drift from the audio), and read the watching-and-cutting skill for the pacing rules.",
    inputSchema: obj({
      clip_id: str("Clip id — video, overlay, or soundtrack; scopes to its trimmed range and maps results to timeline seconds"),
      asset_id: str("Project asset id (video or audio)"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
      threshold_db: num("Loudness below this counts as silence, dBFS (default -30)"),
      min_silence: num("Shortest silent stretch to report, seconds (default 0.35)"),
    }),
  },
  {
    name: "listen_audio",
    description:
      "Listen with your own ears to a project asset's sound — an audio asset, or the audio track of a video (its speech, music, burned-in narration) — so you can answer what it says or how it sounds. The sound rides back inline (≈12MB cap). Pass clip_id for a timeline clip's source (scopes to its trim) or asset_id for the whole source; add from/to (source seconds) to hear one stretch of a long file. Audio the user attached to their message already plays in it. To WRITE a caption track, use subtitles_generate.",
    inputSchema: obj({
      clip_id: str("Clip id — video or soundtrack (defaults from/to to its trimmed in/out)"),
      asset_id: str("Project asset id (audio or video) — listen to the whole source"),
      from: num("Source start s (default: the clip's in, else 0)"),
      to: num("Source end s (default: the clip's out, else the source's end)"),
    }),
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
    name: "set_side_panel",
    description:
      "Open a side-panel tab, or collapse the panel to the icon rail with 'none' so the preview canvas takes the freed width — use 'none' when the user asks to clean up or maximize the workspace. 'publish' is the Details tab.",
    inputSchema: obj({
      panel: {
        type: "string",
        enum: ["media", "library", "elements", "effects", "transitions", "video", "image", "audio", "subtitles", "publish", "none"],
        description: "Tab to open, or 'none' to collapse the panel",
      },
    }, ["panel"]),
  },
  {
    name: "split_at",
    description:
      "Split the video (or a selected soundtrack/overlay clip) at a time, like pressing S. Omit t to split at the playhead.",
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
    name: "set_clip_volume",
    description: "Set the gain on a video clip's own audio (soundtrack clips use update_audio).",
    inputSchema: obj({ clipId: str("Video clip id"), volume: num("0..1.5 (1 = unchanged)") }, ["clipId", "volume"]),
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
    name: "detach_audio",
    description:
      "Detach Audio: lift a clip's sound onto the soundtrack track (mutes the clip) so it can be edited independently. Select the clip first or pass its id.",
    inputSchema: obj({ clipId: str("Video clip id (optional if one is selected)") }),
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
      behind_subject: bool("Sit the text behind the person in the shot (needs a clearly separated speaker)"),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
    }, ["text"]),
  },
  {
    name: "add_shape",
    description:
      "Add a vector shape overlay: rect, ellipse, line, or arrow. Position is the shape center as frame fractions; w/h are frame fractions too (a line/arrow's h is its stroke thickness). Rotation gives lines and arrows their direction.",
    inputSchema: obj({
      shape: { type: "string", enum: ["rect", "ellipse", "line", "arrow"], description: "Shape kind" },
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.5)"),
      w: num("Width, fraction of frame width"),
      h: num("Height, fraction of frame height (line/arrow: thickness)"),
      fill: str("CSS color (default #FFFFFF)"),
      fill_opacity: num("Fill opacity 0..1 (rect/ellipse)"),
      radius: num("Rect corner radius, px at 1080 short side"),
      stroke_color: str("Outline color (rect/ellipse)"),
      stroke_width: num("Outline width px at 1080 short side (0 removes it)"),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
    }, ["shape"]),
  },
  {
    name: "add_sticker",
    description:
      "Add a sticker overlay from a project image asset (asset ids come from `media`; sticker uploads carry origin \"sticker\"). Width is a frame-width fraction; height follows the source's own aspect.",
    inputSchema: obj({
      asset_id: str("Project image asset id"),
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.5)"),
      w: num("Width, fraction of frame width (default 0.25)"),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
    }),
  },
  {
    name: "update_overlay",
    description:
      "Update any overlay element — title, shape, or sticker — by id (from the selection or state). Titles take text/size/font/weight/color/shadow/plate; shapes take w/h/fill/fill_opacity/radius/stroke; stickers take w. Every kind takes timing, position, rotation, opacity, hidden. This is the tool for 'make this text better' requests too.",
    inputSchema: obj({
      id: str("Overlay element id"),
      text: str("New text (titles)"),
      start: num("Start s"),
      end: num("End s"),
      x: num("Center x 0..1"),
      y: num("Center y 0..1"),
      size: num("Font size px at 1080w (titles)"),
      color: str("CSS text color (titles)"),
      font: str("Font id (titles; see the graphics skill)"),
      weight: { type: "number", enum: [400, 700], description: "Font weight (titles)" },
      italic: bool("Italic (titles)"),
      align: { type: "string", enum: ["left", "center", "right"], description: "Multi-line alignment (titles)" },
      letter_spacing: num("Tracking in em (titles; 0 = normal)"),
      line_height: num("Line height multiplier (titles; default 1.25)"),
      shadow: bool("Drop shadow (titles)"),
      plate: bool("Backdrop plate (titles)"),
      behind_subject: bool("Sit the text behind the person in the shot (titles)"),
      w: num("Width, fraction of frame width (shapes/stickers)"),
      h: num("Height, fraction of frame height (shapes)"),
      fill: str("Fill color (shapes)"),
      fill_opacity: num("Fill opacity 0..1 (rect/ellipse)"),
      radius: num("Rect corner radius, px at 1080 short side"),
      stroke_color: str("Outline color — text or shape"),
      stroke_width: num("Outline width: em for titles (0..0.15), px at 1080 for shapes; 0 removes it"),
      rotation: num("Degrees clockwise, -180..180 (0 clears)"),
      opacity: num("Whole-element opacity 0..1 (1 clears)"),
      hidden: bool("Hide the element without deleting it"),
    }, ["id"]),
  },
  {
    name: "create_sticker",
    description:
      "Create a custom sticker from an idea: the hosted image model draws it (signed in, spends credits), the background is removed (people on-device, other subjects via hosted matting), a white die-cut outline is added, and it lands as an origin-\"sticker\" asset placed on the timeline at the playhead. Takes ~10-20s; the tool returns when the sticker is placed.",
    inputSchema: obj({
      idea: str("What the sticker shows, e.g. \"a corgi in sunglasses\""),
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.5)"),
      w: num("Width, fraction of frame width (default 0.25)"),
    }, ["idea"]),
  },
  {
    name: "add_effect",
    description:
      "Add a time-ranged visual effect element over the video: a zoom into part of the frame, the treatments (grain, vhs, glitch, blur, vignette, lightleak, flash, shake) or a graded look (vintage, horror, halation, tech, noir, pastel, blockbuster, dreamy). It filters everything under it for its window (start..end) and stacks with other effects. Tasteful default: one effect at a time, amount under ~0.5.",
    inputSchema: obj({
      effect: { type: "string", enum: ["zoom", "grain", "vhs", "glitch", "blur", "vignette", "lightleak", "flash", "shake", "vintage", "horror", "halation", "tech", "noir", "pastel", "blockbuster", "dreamy"], description: "Effect id" },
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      amount: num("Strength 0.05..1 (default 0.5). For zoom it is the depth: 0.25 shallow, 0.5 moderate, 1 deep"),
      focus_x: num("Zoom only: the x of the point to zoom into, 0..1 (default 0.5)"),
      focus_y: num("Zoom only: the y of the point to zoom into, 0..1 (default 0.5)"),
    }, ["effect"]),
  },
  {
    name: "set_overlay_animation",
    description:
      "Animate an overlay element (title, shape, or sticker): preset In/Out ramps plus a Loop that runs its whole duration. Omitted slots keep their setting; pass \"none\" to clear one. In/Out styles: fade, pop, zoom, slideleft/slideright/slideup/slidedown (names are the motion direction), typewriter (titles only). Loop styles: pulse, wiggle, spin, float.",
    inputSchema: obj({
      id: str("Overlay element id"),
      in_style: str("Entrance style, or \"none\" to clear"),
      in_seconds: num("Entrance ramp seconds 0.1..2 (default 0.5)"),
      out_style: str("Exit style, or \"none\" to clear"),
      out_seconds: num("Exit ramp seconds 0.1..2 (default 0.5)"),
      loop_style: str("Loop style, or \"none\" to clear"),
      loop_speed: num("Loop rate multiplier 0.25..4 (default 1)"),
    }, ["id"]),
  },
  {
    name: "set_overlay_keyframes",
    description:
      "Give an overlay element a keyframed pose track, for motion the presets cannot express (a path across the frame, a slow push in, a hold-then-drift). Each key is a whole pose at a time measured in seconds from the element's own start; the pose moves linearly between keys and holds outside them. Omitted fields on a key take the element's current value. Pass an empty list to clear the track and return the element to its resting pose. Preset In/Out/Loop animation still composes on top, so a keyframed title can also fade in.",
    inputSchema: obj(
      {
        id: str("Overlay element id"),
        keys: {
          type: "array",
          description: "Keys in any order; two at the same time collapse to one",
          items: obj(
            {
              t: num("Seconds from the element's start"),
              x: num("Center x, fraction of frame width 0..1"),
              y: num("Center y, fraction of frame height 0..1"),
              scale: num("Size multiplier, 1 = the element's own size (0.1..4)"),
              rotation: num("Degrees clockwise, -180..180"),
              opacity: num("0..1"),
            },
            ["t"]
          ),
        },
      },
      ["id", "keys"]
    ),
  },
  {
    name: "update_audio",
    description:
      "Update a soundtrack clip: volume (0..1.5), fadeIn/fadeOut seconds, start position, in/out trim, speed, hidden, or duck. `duck` is voiceover ducking — while this clip plays, ALL other audio (video-clip sound and other music) drops to that gain (0..1); pass 1 to clear ducking. Use it to make a voiceover sit over quieter music.",
    inputSchema: obj({
      id: str("Soundtrack clip id"),
      volume: num("0..1.5"),
      fadeIn: num("Fade-in seconds"),
      fadeOut: num("Fade-out seconds"),
      start: num("Timeline start s"),
      in: num("Source in s"),
      out: num("Source out s"),
      speed: num("Playback rate (1 = normal, no upper limit)"),
      duck: num("Duck other audio to this gain while this clip plays, 0..1 (1 clears ducking)"),
      hidden: bool("Silence the clip without removing it (grayed on the timeline)"),
    }, ["id"]),
  },
  {
    name: "set_framing",
    description:
      "Set how a video clip meets the 9:16 frame: 'fit' letterboxes the whole picture (default), 'fill' scales it to cover the frame and crops the overflow. In fill mode panX/panY (-1..1, 0=centered) choose which part stays visible — e.g. panY=-1 keeps the top.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      mode: { type: "string", enum: ["fit", "fill"], description: "Framing mode" },
      panX: num("Crop pan -1 (left) .. 1 (right), fill mode only"),
      panY: num("Crop pan -1 (top) .. 1 (bottom), fill mode only"),
    }, ["clipId", "mode"]),
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
    name: "generate_image",
    description:
      "Generate an AI image from a text prompt (Donkey's hosted image model). Use for B-roll, cover frames, or backgrounds the user doesn't have footage for; when the user asks you to write or improve the prompt itself, put it in chat and wait for them to ask for the image. reference_asset_ids attaches project media the render should draw from (the user's attached references, a clip to restyle) — the prompt is recomposed around them; an audio reference contributes what it carries (its speech transcribed, its sound described) to that recomposed prompt. Returns when the image has landed. The image previews as a card in this chat, where the user can expand it, drag it onto the timeline, or file it into Media or the Library from its \"…\" menu; pass add_to_timeline:true (or an index) only when they asked for it in the cut. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("What to depict — be specific about subject, style, and lighting"),
      aspect: { type: "string", enum: ["16:9", "9:16", "1:1"], description: "Image shape (default: the supported shape closest to the project aspect)" },
      resolution: { type: "string", enum: ["1K", "2K", "4K"], description: "Output detail (default 1K)" },
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project asset ids to reference — images and videos ride as pictures; audio folds what it carries into the prompt. Append @seconds to read a video/audio reference at a pinned moment (\"<id>@16.3\")",
      },
      add_to_timeline: bool("Insert the still on the video track (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline; 0 = first/cover)"),
    }, ["prompt"]),
  },
  {
    name: "generate_video",
    description:
      "Generate an AI video clip from a text prompt (Donkey's hosted video model: one pass, audio included, 720p, up to ~10s — the model picks the length) — the default for any video ask: \"generate/make a video of/about X\" means ONE clip from this tool, even though it sounds whole. Reach for generate_scene only when they name a narrated multi-shot production (a story, episode, or narrated short). When the user asks you to write or improve the prompt itself, put it in chat and wait for them to ask for the video. reference_asset_id anchors the render on one project asset: for an image or video, by default the tool first designs the opening frame from it with the image model (that still previews in this chat), then animates that exact frame — so tell the user it designs the frame, then renders; for audio, what it carries (speech transcribed, sound described) folds into the prompt instead. When the user wants the referenced image itself brought to life (\"animate this image/picture\"), pass animate_reference:true — the image becomes the literal first frame, unchanged, and the prompt describes only the motion. A safety-blocked or rejected anchor degrades the render on its own (identity reference, then text-only — the same ladder scene shots walk), so never resubmit a failed render with weaker inputs yourself. The render takes a minute or two and the tool RETURNS as soon as it's started — the clip previews as a live card in this chat when it finishes. Pass add_to_timeline:true (or an index) only when they asked for it in the cut; otherwise the user drags it in from the card. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("The shot to generate — describe motion, subject, and mood"),
      aspect: { type: "string", enum: ["16:9", "9:16"], description: "Clip shape (default: the supported shape closest to the project aspect)" },
      reference_asset_id: str("One project asset id to reference — an image or video anchors the clip's opening frame; audio folds what it carries into the prompt. Append @seconds to read a video/audio reference at a pinned moment (\"<id>@16.3\")"),
      animate_reference: bool("The referenced image IS the opening frame: animate it directly, unchanged, skipping the frame-design step (use when the user says to animate that image)"),
      add_to_timeline: bool("Insert the clip on the video track when it lands (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline)"),
    }, ["prompt"]),
  },
  {
    name: "generate_character_video",
    description:
      "Generate a UGC-style selfie clip of a stock talking character speaking a line you write (Donkey's hosted video model). Pick a character id from stock_search kind:\"character\" — each has a persona and look; the same person then delivers the line to camera. Like generate_video this RETURNS IMMEDIATELY and the clip previews in this chat a minute or two later; add_to_timeline:true places it when it lands. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      character_id: str("Talking-character id from stock_search"),
      line: str("What the character says, spoken to camera"),
      add_to_timeline: bool("Insert the clip on the video track when it lands (default false — it stays on its chat card until the user asks)"),
      index: num("Insert position on the video track (passing it implies add_to_timeline)"),
    }, ["character_id", "line"]),
  },
  {
    name: "wait_for_renders",
    description:
      "Block until this project's in-flight video renders settle (up to ~100s), then report each one: landed (with its asset id, ready to place) or failed (with the error). Call it whenever the user's ask depends on a render that `renders` in the state shows as running — \"add it when it's done\", \"assemble the clips\" — and then finish the job in the same turn; never tell the user to come back and report when a card appears. If some renders are still running when it returns, say how long they've been going and call it again on the user's go-ahead.",
    inputSchema: obj({}),
  },
  {
    name: "generate_scene",
    description:
      "Generate a narrated, multi-shot cut assembled on the timeline — script, voiceover, and several shots — from a brief, or animate audio already in the project. Use this only when the user names that kind of production (\"tell a story about…\", \"turn this into a narrated 20-second short\", \"an episode\"); a plain \"generate/make a video of/about X\" is a single clip — generate_video, not this. It writes a script, breaks it into shots, and draws each shot's opening frame, then RETURNS that storyboard and STOPS: the user reviews the frames (and can ask to redraw any of them with regenerate_shot — cheap, no credits at this stage) — get their go-ahead and call approve_scene before the shots render, because each shot spends credits. Pass from_audio_asset_id to animate an audio spine the project already has (a voiceover, recording, or song → shots tiled over it) instead of writing a new script. Read the scene-productions skill before your first call — it covers the brief and look, references, aspect, and the from-audio flow. Needs the user signed in to Donkey (spends credits).",
    inputSchema: obj({
      brief: str("What the video is about — the story or subject. Omit only when animating existing audio."),
      from_audio_asset_id: str("Animate this project audio asset (id from media) — shots tile over it instead of a new script"),
      audio_language: str("BCP-47 language of the from_audio asset's speech (e.g. ko-KR). REQUIRED with from_audio_asset_id whenever the speech is not English — the on-device transcriber picks its recognizer from it, and the wrong recognizer garbles every shot planned over the audio"),
      target_seconds: num("Rough total length in seconds, 6–90 (default ~24)"),
      style: str("Optional look to steer the whole video (e.g. 'moody neon, handheld'); usually left to the brief"),
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project image/video asset ids that anchor the look (the user's attached references)",
      },
    }),
  },
  {
    name: "approve_scene",
    description:
      "Approve the pending generate_scene shot plan and start rendering. The shots render in the background and land on the timeline as they finish. Call this only when the user confirms (\"go\", \"do it\", \"looks good\") — approving spends credits per shot.",
    inputSchema: obj({}),
  },
  {
    name: "cancel_scene",
    description:
      "Stop the scene generation running in this project — planning or rendering halts immediately and the plan is discarded. Clips already placed stay on the timeline; credits already spent are not refunded. Call it when the user wants the run stopped, or to clear the way for a new generate_scene.",
    inputSchema: obj({}),
  },
  {
    name: "regenerate_shot",
    description:
      "Redo one shot of the generated scene by its number (1-based), optionally nudging it (\"wider\", \"at night\", \"more energetic\"). At the storyboard gate (before approval) it redraws just that shot's opening frame — cheap, no credits, the run stays waiting for approval. After the scene has rendered it re-renders the shot and swaps its clip on the timeline by itself — never delete the clip first.",
    inputSchema: obj({ n: num("Shot number, 1-based"), note: str("Optional change to apply to that shot") }, ["n"]),
  },
  {
    name: "recut_scene",
    description:
      "Re-cut a contiguous span of the generated scene's shots: replans just that span against the same audio — it can split into more shots or merge into fewer — keeping the style, cast, and every other shot's clip, then renders only the new shots (credits per new shot). Use it when the user wants a section restructured (\"split the last shot\", \"shots 2-3 drag, tighten them\", \"that part is missing the soccer scene\"); one shot redone as-is is regenerate_shot, a whole-look change is restyle_scene. Only valid after a scene has finished.",
    inputSchema: obj({
      from_shot: num("First shot of the span, 1-based"),
      to_shot: num("Last shot of the span, 1-based (equal to from_shot for one shot)"),
      instruction: str("What the span should become — the content to cover and how to pace it"),
    }, ["from_shot", "to_shot", "instruction"]),
  },
  {
    name: "restyle_scene",
    description:
      "Restyle the whole generated scene and redo every shot with a new look (\"make it black-and-white film noir\", \"turn it into anime\"). Only valid after a scene has been generated. Spends credits (every shot re-renders), so confirm first.",
    inputSchema: obj({ style: str("The new look for the whole video") }, ["style"]),
  },
  {
    name: "stock_search",
    description:
      "Search Cut's bundled stock catalogs: footage clips and stock images across Business/Nature/Travel/City/Technology/Anime/Animal/Food categories, plus talking characters (personas for generate_character_video). Stock is local and free — check it before spending generation credits when existing media could serve. Add a match to the project with stock_add.",
    inputSchema: obj({
      query: str("Words to match against prompts, categories, and tags (omit to browse)"),
      kind: { type: "string", enum: ["video", "image", "character"], description: "Limit to one catalog (default: all)" },
    }),
  },
  {
    name: "stock_add",
    description:
      "Import a stock video or image (by stock_search id) into the project. It previews as a card in this chat; pass add_to_timeline:true (or a `start`) to also drop it on the video track when the user asked for it in the cut. Free — the media ships with Cut.",
    inputSchema: obj({
      id: str("Stock item id from stock_search"),
      add_to_timeline: bool("Place it on video track 0 (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start s (passing it implies add_to_timeline; default when placed: appended at the end)"),
    }, ["id"]),
  },
  {
    name: "import_url",
    description:
      "Read any URL — TikTok, YouTube, Instagram Reels, an X/Twitter post or Article, an ordinary web page, or a direct video/audio/image link — with the bundled downloader and import what it holds into the project. Free and local. A web page comes back as its article text plus the pictures on it; a post as its video or photos; and the source's own words (returned as sourceText) are quoted for the user beside the media automatically — don't retype them in your reply. A source that is only words returns sourceText with no assets, which is a success: read it and answer from it. This is how you look something up: point it at the page and read what comes back. Media lands on a card in this chat and the user drags it to the timeline, Media, or the Library; place it yourself (add_clip) only when they asked for it in the cut. A short clip downloads in seconds; a long video can take a couple of minutes.",
    inputSchema: obj({ url: str("The page or media URL to download") }, ["url"]),
  },
  {
    name: "library_list",
    description:
      "List the shared Library — reusable media saved across projects: folders, assets (video/audio/image), and templates (saved arrangements of clips, overlays, titles, and captions). Library items live outside the project: library_add imports an asset, template_add re-materializes a template.",
    inputSchema: obj({}),
  },
  {
    name: "library_add",
    description:
      "Copy a Library asset into the project (it appears in `media` and previews as a card in this chat). This is the import step \"library\"-scope attachments need before editor tools can touch them. Pass add_to_timeline:true (or start/index) only when the user asked for it in the cut: video/image land on track 0, audio on the soundtrack.",
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
      "Re-materialize a Library template into the project: its media import as assets and its clips, overlays, titles, and captions land editable, exactly as saved (clip layers append to track 0; free-positioned parts line up at the playhead). Call it only when the user asked for the template in the cut.",
    inputSchema: obj({ id: str("Template id from library_list") }, ["id"]),
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
      "Organize the shared Library: create_folder / rename_folder / delete_folder (a deleted folder's items drop to the root), move_asset files an asset or template into a folder (omit folder_id for the root), delete_asset / delete_template remove an item. Deletes are permanent — projects keep their own copies, but delete only what the user explicitly asked to remove.",
    inputSchema: obj({
      action: {
        type: "string",
        enum: ["create_folder", "rename_folder", "delete_folder", "move_asset", "delete_asset", "delete_template"],
        description: "The organize operation",
      },
      name: str("Folder name (create_folder, rename_folder)"),
      folder_id: str("Folder id (rename_folder, delete_folder, move_asset destination — omit for root)"),
      id: str("Library asset or template id (move_asset, delete_asset, delete_template)"),
    }, ["action"]),
  },
  {
    name: "file_asset",
    description:
      "File a project asset where the user keeps things: to \"media\" moves created media (generated, chat, voiceover…) into the Media panel by clearing its origin tag; to \"library\" copies any project asset into the shared Library for reuse. The same moves as each card's \"…\" menu — make them when the user asks.",
    inputSchema: obj({
      asset_id: str("Project asset id from `media`"),
      to: { type: "string", enum: ["media", "library"], description: "Destination" },
    }, ["asset_id", "to"]),
  },
  {
    name: "delete_asset",
    description:
      "Remove a project asset and every timeline clip that uses it — the Media panel's trash. Removed media does not come back with undo, so call it only when the user explicitly asked to remove that media, and report how many clips went with it.",
    inputSchema: obj({ asset_id: str("Project asset id from `media`") }, ["asset_id"]),
  },
  {
    name: "subtitles_generate",
    description:
      "Transcribe the cut on-device (Apple speech) and create subtitle captions on a subtitle track (the active one unless `track` says otherwise; other tracks keep their captions) — it WRITES captions the user sees, so call it only when they asked for subtitles; to just hear what an audio asset says, listen_audio. Cue times come back snapped to the audio, so treat them as in sync — retime a cue only when the user points at one. Runs in the background; returns when finished. If no speech is found, no subtitles are added.",
    inputSchema: obj({
      locale: str("Speech language as BCP-47 like en-US (default: the track's language)"),
      track: num("Subtitle track to write, 0-based (default: the active track)"),
    }),
  },
  {
    name: "captions_generate",
    description:
      "Transcribe (if needed) then REWRITE one subtitle track's captions into punchy social-video captions — short lines that fit inside the video frame (they may wrap onto two lines but never overflow), a few emoji, a curiosity-hook opener. style: clean | hook | punchy (default hook). Cue timings are preserved. It replaces the track's existing text wholesale — for a targeted edit (removing filler words, fixing one line), edit the cues with update_cue instead.",
    inputSchema: obj({
      style: str("Caption style: clean, hook, or punchy"),
      track: num("Subtitle track to rewrite, 0-based (default: the active track)"),
    }),
  },
  {
    name: "subtitles_from_visuals",
    description:
      "Caption a cut that has NO usable speech by watching sampled frames and writing timed narration captions (uses the user's Claude login to look at the frames). Use this instead of subtitles_generate when the video is silent b-roll, music-only, or otherwise has nothing to transcribe. Runs in the background; returns when finished.",
    inputSchema: obj({
      locale: str("Caption language as BCP-47 like en-US (default: the track's language)"),
      track: num("Subtitle track to write, 0-based (default: the active track)"),
    }),
  },
  {
    name: "subtitles_add_track",
    description:
      "Add a subtitle track (up to 3, one language each — e.g. English on track 0, Korean on track 1; each shows as its own caption line, draggable to its own spot). The new track becomes active and starts empty: fill it with subtitles_translate_track, or subtitles_generate in its language.",
    inputSchema: obj({ language: str("The track's language as BCP-47, e.g. ko-KR (optional)") }),
  },
  {
    name: "subtitles_remove_track",
    description:
      "Remove a subtitle track and its captions; higher tracks shift down. Removing the only track empties it — so this also answers \"delete the subtitles\".",
    inputSchema: obj({ track: num("Track to remove, 0-based") }, ["track"]),
  },
  {
    name: "subtitles_translate_track",
    description:
      "Translate existing captions into another language on their own subtitle track — the way to answer \"add Korean subtitles\". Reuses the track already set to that language or adds one (max 3), then translates the source track's cues one-to-one, timings kept. The captions must exist first (subtitles_generate).",
    inputSchema: obj({
      language: str("Target language as BCP-47, e.g. ko-KR"),
      from_track: num("Source track, 0-based (default: the first track with captions)"),
    }, ["language"]),
  },
  {
    name: "list_voices",
    description:
      "List the AI voices available for voiceover (Gemini's prebuilt set; each has a one-word character like Warm, Upbeat, Gravelly). Call this when the user asks for a specific kind of voice so you can pass the right voice id to voiceover_generate or read_subtitles_aloud.",
    inputSchema: obj({}),
  },
  {
    name: "voiceover_generate",
    description:
      "Generate a spoken AI voiceover from a script (Donkey's hosted speech model). The audio previews as a playable card in this chat; pass add_to_timeline:true (or a `start`) to also drop it on the soundtrack when the user asked for it in the cut ('add a voiceover', 'narrate this'). When the user asks you to write or rework the script itself, put the text in chat and wait for them to ask for the voiceover. Pick a `voice` id from list_voices, or omit for a good default. `direction` steers delivery in natural language and can ask for another language — 'say it in Spanish' translates the script before synthesis; the script itself may carry inline tags like [whispers] or [excited]. `duck` lowers all other audio to that gain while the voice plays (0..1; ~0.3–0.5 is typical, 1 = don't duck). Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      script: str("What the voice should say"),
      voice: str("Voice id from list_voices (optional; a sensible default is chosen)"),
      direction: str("Delivery instruction, e.g. 'Say warmly, like an old friend'; may include a language ask, which translates the script (optional)"),
      language: str("Pronunciation language as BCP-47, e.g. es-US, ja-JP (optional; default auto-detects — this reads the script as written, it does not translate)"),
      duck: num("Lower other audio to this gain while the voice plays, 0..1 (default 0.4; 1 = no ducking)"),
      add_to_timeline: bool("Place it on the soundtrack (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start in seconds (passing it implies add_to_timeline; default when placed: the playhead)"),
    }, ["script"]),
  },
  {
    name: "generate_music",
    description:
      "Generate a music track from a text prompt (Donkey's hosted music model, Gemini/Lyria) — a full song with sung vocals, or an instrumental bed. Describe mood, genre, instruments, and tempo. By default it renders an instrumental bed (instrumental:true); pass instrumental:false for a full song, where the model writes and sings its own lyrics — or include your own with [Verse]/[Chorus] tags and a singer description in the prompt. length \"clip\" is ~30s (default), \"song\" a longer ~2-minute track. reference_asset_ids matches a track to the user's own media (\"a song that matches this audio\", \"score the tone of this video\"): pass the project asset ids — an audio track to emulate, or video/images whose mood to carry — and a multimodal pass folds a description of that sound into the prompt (the model itself never hears the audio, so always pass the reference rather than describing it yourself). When you match an audio reference that has singing, pass instrumental:false so the new track sings too. When the user asks you to write or refine the lyrics or brief itself, put it in chat and wait for them to ask for the music. It RETURNS once the track has landed and previews as a playable card in this chat; pass add_to_timeline:true (or a `start`) to drop it on the soundtrack when the user asked for it in the cut. For \"background music for this video\", read the timeline (videoTrack, project duration) to fit the mood and length, keep it instrumental so any speech stays on top, and set those clips' `duck` so the bed dips under them. This is SUNG music — a spoken narration is voiceover_generate. Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      prompt: str("The music to generate — mood, genre, instruments, tempo; for a song, the theme to sing about, or your own [Verse]/[Chorus] lyrics"),
      instrumental: bool("Vocal-free background bed (default true). Pass false to let the model write and sing a full song"),
      length: { type: "string", enum: ["clip", "song"], description: "clip = ~30s (default), song = ~2-minute track" },
      reference_asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Project asset ids to match the sound of — an audio track to emulate, or video/images whose mood the score should carry. Append @seconds to match the passage around a pinned moment (\"<id>@62\")",
      },
      volume: num("Bed volume 0..1.5 when placed (default 0.4 so it sits under speech)"),
      add_to_timeline: bool("Place it on the soundtrack (default false — it stays on its chat card until the user asks)"),
      start: num("Timeline start in seconds (passing it implies add_to_timeline; default when placed: the playhead)"),
    }, ["prompt"]),
  },
  {
    name: "read_subtitles_aloud",
    description:
      "Speak one subtitle track's cues as an AI voiceover (Donkey's hosted speech model) — each line placed at its own cue time — and add it to the soundtrack. Turns captions into narration. Requires subtitles to exist first (generate them if needed). `duck` lowers other audio under the voice (0..1). Needs the user signed in to Donkey (spends their credits).",
    inputSchema: obj({
      voice: str("Voice id from list_voices (optional)"),
      direction: str("Delivery instruction, e.g. 'Narrate briskly, documentary style'; may include a language ask, which translates the lines (optional)"),
      language: str("Pronunciation language as BCP-47, e.g. es-US, ja-JP (optional; default auto-detects — reads cues as written; for another language use a translated subtitle track)"),
      duck: num("Lower other audio to this gain while the voice plays, 0..1 (default 0.4)"),
      track: num("Subtitle track to read, 0-based (default: the active track)"),
    }),
  },
  {
    name: "subtitles_set_view",
    description: "Toggle subtitles on the video (preview + export burn-in) and/or the timeline cue track.",
    inputSchema: obj({ showOnVideo: bool("Captions on the video"), showOnTimeline: bool("Cue track on the timeline") }),
  },
  {
    name: "update_cue",
    description: "Edit a subtitle cue's text or retime it (start/end seconds).",
    inputSchema: obj({ id: str("Cue id"), text: str("New text"), start: num("Start s"), end: num("End s") }, ["id"]),
  },
  {
    name: "delete_cue",
    description: "Delete a subtitle cue.",
    inputSchema: obj({ id: str("Cue id") }, ["id"]),
  },
  {
    name: "set_publish",
    description:
      "Set the TikTok publish metadata: caption (4,000 char limit incl. tags), tags (space-separated words, # added automatically), soundTitle, handle.",
    inputSchema: obj({
      caption: str("Caption text"),
      tags: str("Space or comma separated tags"),
      soundTitle: str("Sound title"),
      handle: str("Creator handle without @"),
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
  {
    name: "open_export",
    description:
      "Open the export dialog so the user can render the cut (presets from Original quality down to Draft 720p). Exporting itself stays a user action.",
    inputSchema: obj({}),
  },
  {
    name: "set_speed",
    description:
      "Set a video clip's playback speed. Faster shortens the clip on the timeline; slower stretches it. Later titles and captions shift to stay in sync.",
    inputSchema: obj({ clipId: str("Video clip id"), speed: num("Playback rate (1 = normal, no upper limit)") }, ["clipId", "speed"]),
  },
  {
    name: "set_color_grade",
    description:
      "Color-grade a video clip (any track; stills too). Fields patch the clip's current grade: only the ones you pass change, and every value 0 is neutral. reset:true clears the whole grade first; auto:true fits a starting grade from the clip's decoded frame (auto-tone: exposure to middle gray, contrast stretch, gray-world white balance — needs the clip's frame decoded, so seek into it first if this errors), and explicit fields then override it. Preview, timeline thumbnails, and export all render the same result.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      brightness: num("-50..50, 0 neutral"),
      contrast: num("-50..50, 0 neutral"),
      saturation: num("-50..50 (-50 = grayscale), 0 neutral"),
      exposure: num("-50..50 (±1 stop), 0 neutral"),
      temperature: num("-50..50, positive = warmer, 0 neutral"),
      hue: num("Hue rotation in degrees, -180..180"),
      auto: bool("Fit a starting grade from the clip's current frame"),
      reset: bool("Clear the existing grade before applying fields"),
    }, ["clipId"]),
  },
  {
    name: "set_transition",
    description:
      "Set the transition from this clip into the next clip on its track (any video track), in seconds (0 clears it, max 2). A transition is a blend across the cut — it never moves, trims or overlaps clips, and it plays only while the pair touches. On upper tracks every style blends as an alpha dissolve (the tracks beneath show through). Only valid when a next same-track clip exists. Each edge holds one effect: setting a transition clears the animations adjacent to its joint (and set_animation on that edge replaces the transition). Read the transitions-and-fades skill before styling cuts.",
    inputSchema: obj({
      clipId: str("Video clip id (the clip the transition starts from)"),
      seconds: num("Transition length in seconds, 0–2 (0 = hard cut)"),
      style: {
        type: "string",
        enum: [...TRANSITION_STYLE_IDS],
        description: "Transition look (default crossfade)",
      },
    }, ["clipId", "seconds"]),
  },
  {
    name: "set_animation",
    description:
      "Animate one clip's own entrance (which:'in') or exit (which:'out'): fade, zoom, pop, or a slide named by its motion direction. style 'none' clears. Track-0 clips take every style; upper-track clips only fade and zoom. Each edge holds one effect, last pick wins: animating an edge a transition owns replaces that transition, and setting a transition clears the animations adjacent to its joint. At an abutting cut the animation plays over the neighbor's held frame; at the timeline's ends and across gaps it plays against black.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      which: { type: "string", enum: ["in", "out"], description: "Entrance or exit" },
      style: {
        type: "string",
        enum: [...ANIM_STYLE_IDS, "none"],
        description: "Animation style, or 'none' to clear",
      },
      seconds: num("Ramp length in seconds, 0.1–2 (default 0.5)"),
    }, ["clipId", "which", "style"]),
  },
  {
    name: "merge_cue",
    description:
      "Merge a subtitle cue into the previous cue on its own track (joins their text and timing). Not valid for a track's first cue.",
    inputSchema: obj({ id: str("Cue id to merge into its predecessor") }, ["id"]),
  },
  {
    name: "set_aspect",
    description:
      "Set the project's output frame ratio as \"W:H\". The frame is the user's own setting, so call this only when they asked for a shape or a format (\"make it vertical\", \"for TikTok\", \"square\") — never inferred from a reference image's shape, a platform named in passing, or what would suit a generation you are about to run. Presets: 16:9 (YouTube), 9:16 (TikTok/Reels/Shorts), 1:1, 4:3, 3:4, 2:1 — but any ratio up to an 8:1 shape works, with whole or decimal sides (\"9:5\", \"2.39:1\" — stored reduced, so 2.39:1 becomes 239:100). The frame renders with its short side at 1080px: 9:16 → 1080×1920, 16:9 → 1920×1080, 9:5 → 1944×1080.",
    inputSchema: obj({ aspect: { type: "string", description: "Output ratio as \"W:H\", e.g. \"9:16\", \"1:1\", \"9:5\", \"2.39:1\"" } }, ["aspect"]),
  },
  {
    name: "set_project_fade",
    description:
      "Set the whole video's fade in from black and/or fade out to black, in seconds (0 clears, max 2). Applied to the final picture and mix at the start/end of the cut, independent of which clip sits there.",
    inputSchema: obj({ fadeIn: num("Fade-in seconds (omit to keep)"), fadeOut: num("Fade-out seconds (omit to keep)") }),
  },
  {
    name: "set_project_name",
    description: "Rename the current project.",
    inputSchema: obj({ name: str("New project name") }, ["name"]),
  },
  {
    name: "list_skills",
    description: "List the available skill documents about how this editor works.",
    inputSchema: obj({}),
    server: true,
  },
  {
    name: "read_skill",
    description:
      "Read a skill document (detailed docs for a part of the editor: every setting, where it lives, and how it behaves). Use before working in an unfamiliar area.",
    inputSchema: obj({ name: str("Skill name from list_skills") }, ["name"]),
    server: true,
  },
];

/** Deep documentation the model can pull in on demand. */
export const AI_SKILLS: Record<string, string> = {
  "editor-overview": `# Cut editor overview
Cut is a local, project-based short-video editor. Each project has an output aspect ratio "W:H" — presets 16:9, 9:16, 1:1, 4:3, 3:4, 2:1, or any custom ratio like 9:5 — rendered with the frame's short side at 1080px and switchable from the pill in the top bar; the current one is in editor_state project.aspect. Layout:
- Left icon rail tabs: Media (user-imported files + Exports list), Library (shared reusable assets), Video (stock clip browser — footage + talking characters — beside the AI video generator), Image (stock images beside the AI image generator), Audio (AI voiceover + audio files), Text (title presets), Subtitles (transcript editor), Publish (caption/tags/sound metadata). Camera/mic recording lives in the top bar next to the aspect picker.
- Media shows only what the user imported. Everything Cut makes carries an origin tag (generated, voiceover, recording, stock, freeze, chat — see \`media\` in editor_state) and lives where it was created — media you make previews on a card in this chat, panel renders sit in their job lists; a "…" menu on each files it into Media or the Library, and every card drags onto the timeline. Deleting a chat thread deletes the chat media the user never placed or filed away.
- Center: the video preview canvas (composited at the project's frame size) with draggable text overlays and subtitle captions.
- Right: the Inspector — its content follows the selection (video clip, overlay video, soundtrack clip, title, or cue).
- Bottom: the timeline (resizable by dragging its top border). Rows top-to-bottom: the video tracks in z-order (positive tracks, then track 0, then negative tracks behind it), soundtrack lanes (green), titles (purple), subtitle tracks (amber, when enabled). Every track is free-positioned in time.
Everything autosaves to the project folder. Undo/redo is unlimited (⌘Z / ⇧⌘Z).
Times are in seconds on the shared timeline. The playhead is currentTime; a skimmer previews under the mouse without moving the playhead.`,

  "timeline-editing": `# Timeline editing
- Every track is free-positioned: items carry a start time, gaps are allowed, and a track-0 gap plays black (and silence). videoTrack entries in editor_state report gapBefore where one exists.
- While track 0 is the only video track, deleting a track-0 clip ripples: the span it occupied closes, later items on every track slide left together, items wholly inside the span go with it, and straddlers are trimmed. A gap that already existed stays. With overlay video tracks present the delete leaves its gap (remove_gap closes it by sliding that track's later clips left). Deletes on other tracks remove just that item.
- Two ways to move a track-0 clip: place_clip sets its start (respects gaps, slides right if the spot is taken); move_clip reorders by index, opening a slot at the landing point — clips after it shift right, every other gap survives. Index-based inserts (freeze_frame, generated clips) open a slot the same way.
- add_clip puts a project asset on the timeline the way a drag does: video/image onto track 0 (a \`start\`, an \`index\` insert, or appended at the end), audio onto the soundtrack.
- Overlay video: a video/image asset can sit on a track above track 0 (track 1, 2… — topmost wins). A full-frame overlay covers everything below it; give it a layout to share the frame — top/bottom/left/right halves for a split screen, pip for a floating corner box, or a custom region rect. add_overlay_video creates one from a media asset; update_overlay_video moves/trims/regions/mutes/hides it. The user makes them by dragging media above track 0; they drag the region in the preview.
- A clip's timeline length is (out-in)/speed; total duration runs to the last clip's end, gaps included. Transitions blend at cuts and never change layout or length.
- trim_clip changes in/out inside the source media. in >= 0, out <= source duration, out-in >= 0.1.
- set_speed sets a clip's playback rate; it changes the clip's timeline length, and later titles/captions ripple to stay in sync.
- set_transition joins a clip into the next one (0–2s, 17 styles); set_animation animates one clip's own entrance/exit — read the transitions-and-fades skill before styling cuts. Splitting or deleting clears the affected transition. Grading a clip's picture is add_effect: an effect dropped over a clip opens covering it.
- split_at cuts the track-0 clip under that time into two clips at the exact frame. With a soundtrack or overlay clip selected it splits that instead.
- The user can multi-select (⌘/⇧-click) and delete several items at once; a hover chip on each video clip toggles its own audio.
- Anything can be hidden instead of deleted: it stays on the timeline (grayed) but drops out of playback and export — a hidden video clip plays black and silent. Per item: set_clip_hidden, or the \`hidden\` field on update_overlay_video/update_overlay/update_audio. Whole rows: set_track_hidden (video/soundtrack/text/subtitles) and set_track_muted (video) — the eye/speaker toggles on the track headers.
- detach_audio lifts a video clip's sound to the soundtrack track (and mutes the clip) so audio can be cut independently of video.
- freeze_frame grabs one frame (default: the playhead — what the user currently sees) as a still clip and inserts it, by default at index 0 as a cover/hook frame ("make this the first frame"). The still is baked at the project's current aspect with the clip's framing applied; if the user later switches aspect they should capture a fresh one.
- set_framing: per-clip Fit (letterbox) vs Fill (crop to cover the project frame). In Fill, panX/panY position the crop window; the user can also drag the video directly in the preview. The control lives in the Inspector under "Framing" when a video clip is selected. Landscape footage usually wants fill + a pan that keeps the subject.
- The user can copy/paste any selected segment (video, overlay video, audio, title) with ⌘C/⌘V; pastes aim for the playhead and slide right to free space.
- Zoom: set_view pxPerSec (12..800) or fit. The timeline panel height: set_view timelineH (170..600).`,

  "watching-and-cutting": `# Watching footage & cutting by content
When a request depends on what the footage actually contains — "cut the dead air", "clip the best moment", "remove the boring part", "split where the scene changes" — watch it first. Never guess at content you haven't seen.

Your eyes and ears:
- watch_video(clip_id | asset_id, from?, to?, interval_seconds?): samples the SOURCE at scene changes plus a steady floor and returns timestamped contact sheets — cells read left→right, top→bottom, and each burned stamp is source seconds — plus sceneChanges, the natural cut candidates. Coverage is capped per call: survey the whole range at the default interval first, then zoom into the moments that matter with a narrow from/to and interval_seconds 0.5–1. When truncated, continue from coveredTo.
- detect_silence(clip_id | asset_id, threshold_db?, min_silence?): silent stretches in source seconds; with clip_id each also carries its timeline times.
- capture_frame: one composited frame at the playhead — for checking the final look, not for surveying footage.

The flow for "edit this for me":
1. get_state — every clip, its trim (in/out), speed, gaps, and the other tracks.
2. Speech? subtitles_generate first — cue timings are timeline seconds and say what is said when.
3. watch_video each distinct source (or the ranges in question); note scene changes and what happens where.
4. Plan in thoughts: group the cues into sentences and thoughts, decide which thoughts stay whole, then detect_silence to find where the speaker actually pauses. Cue timings approximate the audio — a trailing word often spills past its cue — so aim every speech cut into a detected silence span, and aim loose: up to a second of spare air on each side beats a tight cut, because the refine step trues the edges after. A cue boundary with no silence span around it means the speech runs continuously there, so leave that joint alone.
5. Execute: split_at (timeline s) to divide, delete_item to drop a segment, trim_clip (source s) to tighten edges, place_clip/move_clip to close gaps or reorder, set_speed to compress slow stretches.
6. Refine: refine_speech_cuts with every recut clip id. It re-scans the audio at each edge and re-trims it to sit a ~0.25s breath inside the real pause, keeping the clips' spacing. It reads sound, not intent — leave out a clip whose edge you placed mid-speech on purpose.
7. Verify by ear: listen_audio at each edge the refine flagged, plus a spot-check or two (scope from/to to ~2s around the joint), and check the first and last words arrive whole and the hand-off into the next thought sounds natural. A clipped word → widen that trim deeper into the silence and listen again. After a heavy edit, listen once end-to-end. seek + capture_frame when the change is visual.

Time math (get this right):
- watch_video, detect_silence, and trim_clip speak SOURCE seconds; split_at and place_clip speak TIMELINE seconds.
- timeline_t = clip.start + (source_t − clip.in) / clip.speed, valid while source_t is inside [in, out]. Each watch result's clip block carries this formula with the real numbers filled in.
- The same source can appear in several clips — map per clip.

Cutting speech well: pace is part of the message. Keep a beat of the speaker's own pause between sentences (~0.3s) and a slightly longer one between thoughts (~0.5s) — shorten a long pause to that beat instead of deleting it, and speech butted directly together reads as rushed. Cut loose and let refine_speech_cuts set the breath at each edge. Prefer split_at + delete_item, then place_clip to close the gap (a beat of black may be wanted — ask the cut, not the tool); trim_clip only tightens a clip's edges.`,

  "transitions-and-fades": `# Transitions, animations, looks & fades
Route the ask to the right feature:
- set_transition: a styled join between one video clip and the next, blended across the cut. It never moves clips or shortens anything, and it plays only while the pair touches.
- set_animation: one clip's own entrance ("in") or exit ("out") — the clip fades/zooms/pops/slides on its own edge. Never moves neighbors. For "fade this clip in", "make it slide in", use this. A wipe is a transition, not an animation.
- set_project_fade: the whole video fades in from black at the start and/or out to black at the end — picture and full mix (titles, captions, soundtrack). Survives clip reordering. For "fade in the video", "fade to black at the end", use this.
- update_audio fadeIn/fadeOut: audio-only ramps on one soundtrack clip ("fade the music out").

set_transition styles (clipId = the leading clip; 0 clears, max 2s): crossfade blends; crosszoom adds a zoom punch; dipblack/dipwhite dip through a solid color; blur defocuses through the cut; pushleft/right/up/down shove the old frame out; wipeleft/right/up/down reveal with a hard traveling edge; circleopen/close and splitopen/close are shape reveals. Directional names describe the motion.
set_animation styles: fade (audio follows), zoom, pop, slideleft/right/up/down — the slide names are the motion direction (slideleft enters from the right edge moving left, or exits off the left). Each edge holds one effect and the last pick wins: set_animation on a transitioned edge replaces that transition, set_transition clears the animations adjacent to its joint.
Picking for a vibe: "smooth" → crossfade; "punchy/energetic" → crosszoom or a push; "dramatic scene change" → dipblack 0.5–0.8s; "dreamy" → blur (or the dreamy look); "retro" → vhs or vintage look. Between clips 0.4–0.8s reads well; 1s+ is slow and cuts total duration.
UI: select a clip → Inspector "Effects" opens the panel (Transition / In / Out / Looks tabs); a blue badge marks each styled joint on the timeline. Preview and export render the same treatment.`,

  "graphics": `# Graphics: titles, shapes & stickers
The title lanes hold three overlay element kinds, all sharing timing (start/end), center position (x/y fractions 0..1), rotation (degrees), opacity, and a lane; \`overlays\` in editor_state lists them with their \`kind\`. All burn into the export exactly as previewed.
Titles (add_title / update_overlay): text, size (frame px; the design short side is 1080), font (sf=SF Pro, serif=New York, rounded, mono, impact), weight (400/700), color, shadow, plate (translucent dark backdrop).
Shapes (add_shape): rect, ellipse, line, arrow. w/h are frame fractions; rect/ellipse take fill + fill_opacity, corner radius (rect), and an outline (stroke_color/stroke_width); line/arrow draw in \`fill\` with h as their thickness, and rotation gives them their direction (0° points right, 90° points down).
Stickers (add_sticker): a project image asset (generated cutouts in the Elements panel carry origin "sticker"); w is a frame-width fraction and height follows the source's aspect. Lottie JSON uploads become animated stickers that loop for the element's duration.
Custom stickers (create_sticker): one call generates the image, removes the background, adds the die-cut outline, and places it — use it when the user asks for a sticker of something they don't have (it spends credits like image generation).
Effects (add_effect): time-ranged treatments over the finished picture — the footage and everything laid over it. Two families, one list: the treatments (grain, vhs, glitch, blur, vignette, lightleak, flash, shake) and the graded looks (vintage, horror, halation, tech, noir, pastel, blockbuster, dreamy). Placed like any element and tuned with \`amount\` (update_overlay); an effect added over a clip opens covering that clip, and trims like anything else. One effect at a time reads best, amounts under ~0.5.
Advanced text (update_overlay): italic, align (multi-line), letter_spacing (em), line_height, stroke_color/stroke_width (em outline behind the fill), and richer shadows. Bundled Google families join the system set — inter, montserrat, poppins, oswald, space-grotesk, playfair, caveat, bebas, anton, archivo-black, bangers, lobster, pacifico, permanent-marker, dm-serif — and the user can upload .ttf/.otf fonts (they appear as font ids like "asset:<id>").
Animation (set_overlay_animation): every element takes preset In/Out ramps (fade, pop, zoom, slides, typewriter for titles) and a Loop (pulse, wiggle, spin, float) that runs its whole duration. Entrances 0.3–0.6s read well; one loop per scene, sparingly.
Keyframes (set_overlay_keyframes): for motion no preset covers — a path across the frame, a slow push in, a drift that holds first. A key is a whole pose (position, scale, rotation, opacity) at a time in seconds from the element's start; the pose moves linearly between keys and holds outside them, and presets still compose on top. Two or three keys carry almost everything; reach for a preset first and keyframes when the user describes a specific path or timing. In the UI the diamond in the inspector adds a key at the playhead, and dragging the element then records into it.
Behind the speaker: a title with behind_subject sits behind the person in the shot (on-device person segmentation; preview and export match). It reads well when the speaker is clearly separated from the background; with no detectable person it degrades to a normal front title. Groups: the user can group elements (select several, Group in the inspector) — selecting one selects all, and moves/resize/rotate/timing ride together.
Good TikTok titles: short punchy lines, high contrast (white/yellow + shadow or plate), size 72–110, keep inside the middle 80% of the frame (x 0.1..0.9, y 0.1..0.9), avoid the caption band (y≈0.8) when subtitles are on.
Tasteful graphics: shapes read best as accents (a highlight box behind a stat, an arrow pointing at the subject, a color bar under a title) — semi-transparent fills (fill_opacity 0.2–0.5) sit better over footage than solid blocks. One or two stickers a scene; size 0.15–0.3 of the frame width.
In the UI: the timeline toolbar adds Text; the Elements side-panel tab browses stickers and shapes and creates sticker images, and the Effects tab holds the effects — a click in any panel picks a tile, and dragging one onto the timeline is what places it; dragging in the preview places an element, its corner handle resizes, the top handle rotates; the Inspector edits every field.`,

  "audio-and-subtitles": `# Audio, voiceover & subtitles
Soundtrack clips: volume 0..1.5, fadeIn/fadeOut seconds (max half the clip), start = timeline position, in/out = trim inside the source; clips can spread across several soundtrack lanes (the \`lane\` field), new sounds slide to free space in their lane. Fades render with ffmpeg afade on export.
Ducking: a soundtrack clip's \`duck\` (0..1, via update_audio) lowers ALL other audio — video-clip sound and other music — to that gain while the clip plays; 1 clears it. Voiceovers set this so narration sits over quieter music. It applies in both the preview and the export.
Voiceover (Donkey's hosted speech model — signed in, spends credits, like image/video generation):
- voiceover_generate(script, voice?, direction?, duck?, add_to_timeline?, start?, language?): synthesizes the script into a playable chat card; add_to_timeline:true (or a start) also drops it on the soundtrack at the playhead (or start) when the user asked for it in the cut. Defaults to a 0.4 duck when placed so it sits over other audio. Voices are Gemini's prebuilt set — list_voices returns them (id + one-word character like Warm, Upbeat, Gravelly); omit voice for a good default. \`direction\` steers delivery in natural language ("Say warmly, like an old friend") and may ask for another language — "say it in Spanish" translates the script before synthesis; the script itself can carry inline tags like [whispers], [excited], [laughs]. \`language\` only pins pronunciation of the text as written.
- read_subtitles_aloud(voice?, direction?, duck?, track?): speaks one subtitle track's cues, each line at its own cue time — captions become narration. Needs cues first. The Inspector offers the same per-clip: "Generate audio for clip" transcribes just that clip when it has no cues yet, then voices it.
Music (Donkey's hosted music model, Gemini/Lyria — signed in, spends credits):
- generate_music(prompt, instrumental?, length?, add_to_timeline?, start?, volume?): renders a track from a mood/genre/tempo brief — a full song with sung vocals (instrumental:false; the model writes the lyrics, or pass your own [Verse]/[Chorus] lines) or a vocal-free bed (instrumental:true, the default). length "clip" (~30s, default) or "song" (~2min). It returns when the track lands and previews as a chat card; add_to_timeline (or a start) drops it on the soundtrack at a soft bed volume. For "background music for this video", keep it instrumental, read videoTrack/duration to fit the mood and length, and set any speech clips' \`duck\` so the bed sits under them. This is sung music — a spoken narration is voiceover_generate; the Audio tab's Voice/Music sub-tabs mirror the two.
Subtitle tracks: a project carries up to 3, one language each (editor_state subtitles.tracks; each cue's \`track\`). Each track shows its own caption line, dragged to its own spot; all share one visual style. The panel and generation write to the ACTIVE track — the track tool param switches it. subtitles_add_track / subtitles_remove_track manage them; subtitles_translate_track("ko-KR") is the whole "add Korean subtitles" flow when captions exist (it adds/reuses the track and translates cue-for-cue).
Generating: subtitles_generate transcribes the cut's audio on-device (Apple speech, macOS 26) onto the target track; cues are caption-sized (≈38 chars). subtitles_from_visuals is the fallback for a cut with NO speech — it watches sampled frames (via the user's Claude login) and writes timed narration captions of what's on screen. So: speech present → subtitles_generate; silent/music-only footage the user wants captioned → subtitles_from_visuals. Never fabricate a spoken transcript.
captions_generate rewrites a track's cues into punchy social captions (emoji, curiosity-hook opener) in a style (clean/hook/punchy), keeping timings — use it when the ask is social/TikTok captions rather than a plain transcript.
Editing: update_cue (text or retime), delete_cue, merge_cue (joins into the previous cue on the same track). In the panel, Return splits a caption at the cursor onto real word timings; hand-edited text drops its word timings.
subtitles_set_view: showOnVideo (preview + export burn-in), showOnTimeline (amber cue rows).
Caption look: the Subtitles panel offers 10 visual presets (clean, hook, punchy, minimal, editorial, typewriter, block, highlight, bubble, neon), a per-word karaoke highlight with accent overrides, and each track's caption drags to a new spot in the preview. No tool sets the look — direct the user to the panel. captions_generate's clean/hook/punchy choice shapes the caption text it writes; the visual preset is separate.`,

  "ai-generation": `# Stock media & AI generation
Three ways to get footage the user doesn't have: bundled stock (local, free), a URL they point at (import_url downloads TikTok / YouTube / Instagram / direct links, free), and hosted generation (signed in, spends credits). Prefer stock when it genuinely fits; generate when the shot needs to be specific.
Stock: stock_search browses the bundled catalogs — footage clips and images in 8 categories plus ~20 UGC talking characters — matching prompts, categories, and tags. stock_add imports an item into the project as a chat card; add_to_timeline:true (or a start) also drops it on the timeline when the user asked. In the UI these live in the Video and Image tabs beside the generators; clicking a stock tile seeds the generate panel with its prompt.
Generation:
- generate_image(prompt, aspect?, resolution?, reference_asset_ids?, add_to_timeline?, index?): the hosted image model renders the prompt at 16:9, 9:16, or 1:1 (default: the supported shape closest to the project aspect) and 1K/2K/4K. The still previews in the chat; placed (add_to_timeline:true or an index) it rides video track 0 as a still clip (8s default, stretchable). Great for a cover/hook frame (index 0), a background, or a b-roll still.
- generate_video(prompt, aspect?, reference_asset_id?, add_to_timeline?, index?): the hosted video model renders a short clip with audio in one pass — 720p, up to ~10s, the model picks the length (no duration knob; the user trims the clip on the timeline). With reference_asset_id it stages: the image model designs the opening frame from the reference first (that still previews in the chat), then the video model animates that exact frame. The render takes a minute or two, so the tool returns once it's started and the clip previews in the chat when it finishes (on the timeline only when asked) — tell the user it's rendering. Don't call it again for the same shot while one is in flight.
- Every render's live status is \`renders\` in editor_state (running with elapsed seconds, done with its asset id, failed with the error) — report render progress from there, never from memory. When the user's ask depends on a running render ("assemble the clips", "add it when it's done"), call wait_for_renders and finish the job in the same turn — never hand the waiting to the user.
- generate_character_video(character_id, line, …): a stock talking character delivers a line to camera, same async render as generate_video. Characters come from stock_search kind:"character" — each has a persona; you write the line (chat deliverable rules apply: asked for "a script", write it in chat first).
References: users attach media to their message or the generate panels; project asset ids (see \`media\` in editor_state, including attachments — OS drops become project assets) pass through reference_asset_ids / reference_asset_id. Images draw from any number of references; video stages one reference into a designed opening frame and animates it; generate_music matches the sound of an audio reference or the mood of a video/image one. When the user says "use this clip/image/song" or "match this", pass the reference — don't just describe it in the prompt.
If generation fails with a sign-in or credits message, relay that plainly — generation needs a Donkey sign-in with credits. Write vivid, specific prompts (subject, style, lighting, motion); the user's request is usually shorthand, so flesh it out. A narrated multi-shot production is generate_scene — read the scene-productions skill before planning one, especially from an audio file or in a named style.`,

  "scene-productions": `# Scene productions (generate_scene)
generate_scene plans a narrated multi-shot cut; approve_scene renders it. Planning is free; every shot render spends credits, so present the plan card and wait for the user's go-ahead — never approve on your own. Per shot, the pipeline already guarantees: smooth continuous motion (no stop-motion or held poses), zero on-screen text, character consistency via a style bible plus reference sheets, gapless non-overlapping placement, and a reviewer that retakes failed renders. Audio: a brief-driven scene has NO separate narration track — the video model speaks each shot's line, so the clip plays its own burned-in narration with a soft music bed under it; a from-audio scene mutes the shots as b-roll under the user's spine instead.
Aspect: every shot renders at the project's shape, frozen when the plan is approved — 9:16 or 16:9, and a custom project ratio freezes the closest of the two, with the shots letterboxed in the frame. The project's shape is the user's own setting and a scene run never changes it: a reference in another shape, a platform the brief mentions, and the shots' own letterboxing are all reasons to say something, not to reframe their project. They asked for a vertical or horizontal video → set_aspect first, then plan.
Look: the user's style reference is the strongest anchor — pass attached images/clips as reference_asset_ids; they anchor the style bible and every shot. A reference contributes the LOOK; when the user wants its pictured character or place in the video itself, say that in the brief — otherwise the pipeline designs a fresh cast in the reference's technique. The brief describes the same look in plain visual traits so words and image agree; with no reference, build the trait wording from the ask (a simple children's cartoon → "flat hand-drawn 2D animation, clean thick outlines, simple rounded characters, soft colors, gentle fluid motion"). Describe any show, franchise, or artist by traits — the generator rejects trademarked names. Name recurring wardrobe and props in the brief so independently rendered shots match.
From an audio file (the audio rides the timeline as the spine): listen_audio first and extract every fact — who speaks, who appears, each topic in order. Then generate_scene with from_audio_asset_id PLUS a brief carrying those facts; the brief outranks transcript mishears. Speech in another language: write the brief's facts in English and pass audio_language so the on-device transcriber uses the right recognizer. Long silence or music in the source becomes filler shots — suggest trimming first (detect_silence); shots tile the full asset length, so warn on long files (many paid shots).
Scope: deliver exactly what was asked — no subtitle tracks, titles, or extra music on top (brief mode lays its own soft music bed; from-audio mode adds none). One scene run at a time — cancel_scene stops the active one when the user wants it gone or replaced.
After renders land: spot-check with capture_frame or watch_video (aspect, style, motion). The user may point at clips by @ token ("@c2 doesn't match the audio") — the clip attachment's id maps to videoTrack in editor_state, whose sceneShot is the n regenerate_shot takes; carry their complaint as its note, and check the audio itself with listen_audio (the spine asset in from-audio mode, or the shot clip's own source in a brief-driven scene, where the narration is burned into each clip) — subtitles_generate would write a caption track nobody asked for. A shot that failed all its takes holds a still — repair it ONLY with regenerate_shot n (it re-runs the shot's identity ladder and swaps the clip in place); deleting the still or rendering a replacement with generate_video orphans the shot and loses the run's identity anchors and review. Revisions ladder by scope, never a fresh generate_scene (that replans and re-bills the whole video): one shot redone or nudged → regenerate_shot; a section restructured — split, tightened, content added ("the last shot is missing the soccer scene") → recut_scene from_shot..to_shot with the ask as its instruction (replans just that span on the same audio, keeps the cast and every other clip, bills only the new shots, no approval gate — the user's ask is the go-ahead); a whole-look change → restyle_scene (every shot re-renders, confirm first). Undo removes clips; spent credits stay spent.`,

  "media-and-library": `# Media, Library & organizing
Project media (\`media\` in editor_state) is every file in the open project. The Media panel shows the user's own imports — assets with no origin tag; created media (origin generated, voiceover, stock, chat, freeze, recording) lives where it was made until filed away.
- add_clip / add_overlay_video place a project asset on the timeline; listen_audio plays an asset's sound to you — an audio asset, or a video/clip's own track; watch_video is the visual sibling.
- file_asset moves a created asset into Media (to:"media", clears its origin) or copies any asset into the Library (to:"library").
- delete_asset removes an asset from the project plus its timeline clips; the media does not come back with undo, so only on an explicit ask, and say what went with it.
The Library is shared across every project: folders, reusable assets, and templates — a template is a saved arrangement (clips, overlays, titles, captions, by reference) that comes back editable.
- library_list browses it; library_add copies an asset into the project (the import step "library"-scope attachments need); template_add re-materializes a template; save_template saves timeline items as one.
- library_organize handles folders (create/rename/delete), filing (move_asset), and deletes (permanent — explicit ask only).
- import_url reads any URL (TikTok, YouTube, Instagram, an X post or Article, a web page, direct links): a page comes back as its article text and its pictures, a post as its video or photos, and a source that is only words as sourceText alone. Media lands as a card in the chat with that text quoted beside it; the user drags a card to the timeline, Media, or the Library. Place it with add_clip only when they asked for it in the cut.
Attachments: media files dropped on the chat import into project media by themselves; library attachments wait for library_add.`,

  "publish-and-export": `# Publish & export
Publish tab fields (set_publish): caption (TikTok limit 4,000 chars INCLUDING tags/emoji; hook in the first line), tags (3–5 focused tags recommended; stored space-separated, rendered as #tags), soundTitle (TikTok lets you rename the sound once after posting), handle (shown as @handle in platform previews).
Export (open_export): presets Original (matches the sharpest source clip along the aspect, 1080p floor, 4K cap), Best 1080p CRF19, Quick share 1080p, Draft 720p — H.264 + AAC, 30fps, rendered at the project aspect ratio, titles and subtitles burned in. Files land in the project's exports/ folder and appear in the Media tab's Exports section, where each can be previewed plain or in TikTok/Instagram/YouTube chrome with the publish metadata rendered in place, revealed in Finder, or deleted.`,
};

/** System prompt shared by all providers. */
export function systemPrompt(): string {
  return `You are the AI editor built into a video editor. Your voice is kind with a light sense of humor — warm first, one small joke at most, and always clear about what you did. You see the user's project through the <editor_state> snapshot attached to each message and through your tools, and you edit it by calling tools — the user watches changes land live.

Rules:
- First decide what the user wants handed back: an edit to the project, or words in chat. "Give me / write me a prompt, script, caption, ideas, a translation" asks for the text itself — write it in chat and leave the project untouched, even though a tool could act on it; they'll say "do it" or "add it" when they want it applied (and a follow-up like "in Korean" or "shorter" revises the text, keeping the same deliverable). A complaint or observation ("ugh, this is cluttered") is words too: sympathize, offer what you could do, and touch nothing until they say go. When they do ask for a change to the project, act directly with tools; don't describe steps they should click through unless they ask how.
- Do what the newest message asks, then stop. The turns above are finished work: what an earlier reply already ran is recorded with it, and the snapshot shows where the project landed — start from there and leave settled work alone. Ideas beyond the ask (a transition, a look, music, captions) belong in one closing sentence for the user to take up.
- Use ids exactly as given in the state — <editor_state> lists every clip, title, cue, asset, and setting with its id, so an edit it already answers ("mute all clips", "delete the second title") goes straight to the tools. Act on what your tools return — each reports what it changed, so batch independent edits into one step and call get_state only when the snapshot is stale or a result surprised you. A tool that comes back "unreachable" or "no live editor session" is a dropped bridge, not a limit and not your request's fault — the editor never received the call, so quietly make the same call once more before doing anything else, and never tell the user to reconnect or restart the editor.
- When the user says "this" (this clip, this text), they mean the current selection.
- Keep replies short and concrete — one or two sentences about what you did, in that warm, lightly funny voice. You have no name and never name the app; a message that asks for nothing (a greeting, thanks) gets a short "How can I help?" / "What would you like to do?" back — words alone, no tool calls. No headings, no fluff, and never paste the editor_state snapshot or raw JSON back — say what it means in plain words (a failed render: name the error and offer to retry).
- Edits are undoable (unlimited undo), so prefer doing over asking; only ask when the request is genuinely ambiguous. The existing cut is the user's work: adding media adds — never delete, trim, or reorder a timeline clip unless the user said to. Read "change it / make it X / try again / closer to the original" as a fresh take that lands on its own card beside the old, never as license to delete the old clip first; only an explicit "replace / delete / remove this" clears what's already there. Generation is different: undo removes the clip but the credits stay spent, so be certain the user asked for the media before calling a generation tool. Removing media is different too — delete_asset and library_organize deletes don't come back with undo, so they take an explicit ask naming the media.
- Times are seconds. The frame follows project.aspect in editor_state — any "W:H" ratio, short side 1080px; project.frame has the exact pixels. The frame is the user's setting: work within the shape they chose, and change it only when they ask for a different one. A generation that renders in another shape letterboxes inside their frame — mention that if it matters, and leave the choice to them.
- Read list_skills / read_skill before working in an area you're unsure about — they document every setting. A tool whose description already answers the ask goes straight through.
- Transcription tools write tracks the user sees — run subtitles_generate / captions_generate only when captions were asked for, never just to read the words: existing cues are in editor_state, and audio plays to you via listen_audio. Don't transcribe a video with no speech (subtitles_from_visuals narrates silent footage), and never invent a spoken transcript.
- Voiceovers duck other audio by default so they stay audible. Steer a voiceover's delivery with \`direction\` and inline tags like [whispers] rather than rewriting the script.
- generate_image / generate_video / generate_character_video / voiceover_generate / read_subtitles_aloud / generate_music make media through hosted models (spends the user's Donkey credits, needs sign-in); call them when the user asked for the media itself — a request for the prompt or script gets text in chat. generate_music makes a music track — a vocal-free background bed by default ("add music to this video"), or a full sung song (instrumental:false); it's sung music, so a spoken narration is voiceover_generate. Bundled stock media (stock_search / stock_add) is free — use it when it fits. Media the user attached is in \`media\`; pass those asset ids as generation references when they say "use this", and place project assets in the cut with add_clip when they ask for them there ("make a movie from these photos"). Generated media previews on a chat card the user can expand, drag in, or file away; add it to the timeline (add_to_timeline:true or an index) only when they asked for it in the cut. Write a rich, specific prompt from their shorthand. Video renders take a minute or two. "Generate a video of/about X" means one generate_video clip; only when they name a narrated multi-shot production (a story, episode, narrated short) does generate_scene plan it and stop at the storyboard — the user reviews the frames (regenerate_shot redraws any before approval, no credits), then call approve_scene, since it renders many paid shots (regenerate_shot / recut_scene / restyle_scene revise it after).
- You can see and hear: audio the user attaches to their message plays right in it — answer "what does this say" from what you hear, no tool call. For project footage, watch_video samples a source's frames into timestamped contact sheets (scene changes included) — watch before cutting footage you haven't seen; listen_audio plays a source's audio — an audio asset or a video/clip's own track; detect_silence finds dead air; capture_frame shows the one rendered frame at the playhead. The watching-and-cutting skill has the flow.`;
}

export const AI_SKILL_INDEX = Object.keys(AI_SKILLS);

/** The ledger an assistant turn carries when the conversation is replayed
 * rather than resumed. A provider session keeps its own tool traffic; a
 * replayed conversation carries text alone, so without this line a past reply
 * reads as a plan nobody carried out — and the next message makes the model
 * run the whole thing again on top of what it was actually asked for. Names
 * and counts are the whole record: the editor snapshot carries the result.
 * Empty when the turn ran nothing. */
export function toolsRanBlock(names: string[]): string {
  if (names.length === 0) return "";
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const list = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
  return `\n\n<tools_ran>This reply already ran: ${list}. That work is done.</tools_ran>`;
}

/** The <attached_assets> block a user turn carries when it has attachment
 * refs. One builder serves hosted chat, the engine chat, and the eval mirror,
 * so the doctrine — especially the clip-scope steering — can never drift
 * between them. Empty when there is nothing attached. */
export function attachedAssetsBlock(refs: unknown[]): string {
  if (refs.length === 0) return "";
  // A ref is described here, never fetched from here: the payload rides as
  // parts on the newest turn. Its url would be replayed as prompt text on
  // every later turn — and for a captured frame or a dropped text file that
  // url IS the payload, a data: URL the media budget cannot see or trim.
  const described = refs.map((r) => {
    const rest = { ...(r as Record<string, unknown>) };
    delete rest.url;
    delete rest.thumb;
    return rest;
  });
  const clipHint = refs.some((r) => (r as { scope?: string }).scope === "clip")
    ? '\nA "clip" attachment means the user is pointing at that segment of the cut: diagnose with read-only looks (watch_video, listen_audio — never subtitles_generate, which writes captions), then revise the clip in place — regenerate_shot for its sceneShot, edit tools otherwise — without deleting it.'
    : "";
  return `\n\n<attached_assets>\nThe user attached these assets to this message; their text may cite one by @handle or @name. Assets with scope "project" are in the open project (ids usable with the editor tools); "clip" assets are clips on the timeline — a video clip's id matches videoTrack in editor_state (a scene-run clip carries its sceneShot number there), an audio clip's (kind "audio") id matches soundtrack; "library" and "stock" assets live outside the project until imported; "file" assets came straight from the user's computer and exist only on this message. An asset with "t" carries a moment the user pinned, in seconds into it — the attached frame (or audio segment) reads from there, and that moment is what they mean by the reference; when you pass such an asset to a generation tool, forward the pin by appending it to the asset id ("<assetId>@<seconds>"):\n${JSON.stringify(described)}${clipHint}\n</attached_assets>`;
}
