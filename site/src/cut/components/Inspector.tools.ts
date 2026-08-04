/**
 * The assistant's inspector tools — the per-item edits the inspector exposes
 * for whatever is selected: overlay elements, soundtrack clips, and a video
 * clip's volume, detached audio, framing, speed, and color grade — kept
 * beside the inspector component. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `InspectorToolName`.
 */

import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

export const INSPECTOR_TOOLS = [
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
    name: "set_clip_volume",
    description: "Set the gain on a video clip's own audio (soundtrack clips use update_audio).",
    inputSchema: obj({ clipId: str("Video clip id"), volume: num("0..1.5 (1 = unchanged)") }, ["clipId", "volume"]),
  },
  {
    name: "detach_audio",
    description:
      "Detach Audio: lift a clip's sound onto the soundtrack track (mutes the clip) so it can be edited independently. Select the clip first or pass its id.",
    inputSchema: obj({ clipId: str("Video clip id (optional if one is selected)") }),
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
] as const satisfies readonly AiToolDef[];

export type InspectorToolName = (typeof INSPECTOR_TOOLS)[number]["name"];
