/**
 * The assistant's inspector tools — the per-item edits the inspector exposes
 * for whatever is selected: overlay elements, soundtrack clips, and a video
 * clip's volume, detached audio, framing, speed, and color grade — kept
 * beside the inspector component. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `InspectorToolName`.
 */

import {
  GRADE_BASIC_FIELDS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  GRADE_PRESET_IDS,
  gradePresetCatalogText,
  HSL_BANDS,
} from "@donkeycut/effects-kit";
import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";

/** Per-field slider hints; ranges interpolate the exported constants so the
 * schema can never drift from the model the renderer clamps to. */
const GRADE_FIELD_HINTS: Record<string, string> = {
  exposure: "(±1 stop)",
  contrast: "",
  highlights: "trim (-) or boost (+) the brights",
  shadows: "lift (+) or crush (-) the darks",
  temperature: "positive = warmer",
  tint: "negative = green, positive = magenta",
  saturation: `(-${GRADE_MAX} = grayscale)`,
  vibrance: "saturation weighted toward the muted colors",
};

const gradeFieldProps = Object.fromEntries(
  GRADE_BASIC_FIELDS.map((f) => [
    f.key,
    num(
      `-${GRADE_MAX}..${GRADE_MAX}, 0 neutral${GRADE_FIELD_HINTS[f.key] ? ` — ${GRADE_FIELD_HINTS[f.key]}` : ""}`
    ),
  ])
);

/** [input, output] control points, 0..255, for one curve channel. */
const curvePoints = (channel: string) => ({
  type: "array" as const,
  description: `${channel} curve control points as [input, output] pairs (0..255, sorted by input); replaces that channel; an empty list clears it`,
  items: { type: "array" as const, items: { type: "number" as const } },
});

const wheelArg = (zone: string) =>
  obj({
    dx: num(`Chroma x -${GRADE_MAX}..${GRADE_MAX} (the puck's position; angle = hue, distance = strength)`),
    dy: num(`Chroma y -${GRADE_MAX}..${GRADE_MAX}`),
    luma: num(`${zone} brightness trim -${GRADE_MAX}..${GRADE_MAX}`),
  });

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
      lane: num("Move the element to another row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, ["id"]),
  },
  {
    name: "set_mask",
    description:
      "Mask an overlay element or a video clip — trim its picture to a shape or to the person in the shot. Kinds: rect (rounded box), square (rounded square, side = w of the frame width), circle (ellipse; w and h are frame fractions, so a perfect circle needs w × frame width = h × frame height — omitting h gives you that circle), linear (half-plane: at rotation 0 the top side stays), mirror (band across the item), subject (the person matte: plain keeps the picture only on the person; invert keeps it off the person — behind the speaker). Position is the mask center's offset from the item's own center (a clip's region center), in frame fractions; w/h size it in frame fractions; feather softens the edge; invert keeps what the shape leaves out. Subject masks use only feather and invert. Pass kind \"none\" to remove the mask. `keys` animates the geometry over time — each key is the full geometry at a moment, moving linearly between keys; pass an empty list to clear the keys and keep the mask still.",
    inputSchema: obj({
      id: str("Overlay element id or video clip id"),
      kind: {
        type: "string",
        enum: ["rect", "square", "circle", "linear", "mirror", "subject", "none"],
        description: 'Mask shape, the person matte ("subject"), or "none" to remove the mask',
      },
      x: num("Center offset x from the element center, fraction of frame width (default 0)"),
      y: num("Center offset y, fraction of frame height (default 0)"),
      w: num("Width, fraction of frame width (default 0.5; square: the side; linear ignores)"),
      h: num("Height, fraction of frame height (mirror: band height; square/linear ignore)"),
      rotation: num("Degrees clockwise, -180..180"),
      feather: num("Edge softness, px at the 1080 design short side (0..200)"),
      invert: bool("Keep the pixels outside the shape"),
      radius: num("Rect corner radius, px at 1080 short side"),
      keys: {
        type: "array",
        description:
          "Mask keyframes, seconds from the element's start; omitted fields on a key take the mask's value at that moment",
        items: obj(
          {
            t: num("Seconds from the element's start"),
            x: num("Center offset x, fraction of frame width"),
            y: num("Center offset y, fraction of frame height"),
            w: num("Width, fraction of frame width"),
            h: num("Height, fraction of frame height"),
            rotation: num("Degrees clockwise, -180..180"),
            feather: num("Edge softness, px at 1080 short side"),
          },
          ["t"]
        ),
      },
    }, ["id"]),
  },
  {
    name: "set_clip_keyframes",
    description:
      "Give a video clip (any track) a keyframed pose track: each key is a whole pose at a time measured in seconds from the clip's own start — center position in frame fractions, scale multiplier on its fitted size, rotation, opacity — moving linearly between keys and holding outside them. Omitted fields on a key take the clip's pose at that moment. Pass an empty list to clear the track and return the clip to its region. Use for pans, push-ins, picture-in-picture flights, spins, and fades on video itself.",
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        keys: {
          type: "array",
          description: "Keys in any order; two at the same time collapse to one",
          items: obj(
            {
              t: num("Seconds from the clip's start"),
              x: num("Center x, fraction of frame width"),
              y: num("Center y, fraction of frame height"),
              scale: num("Size multiplier, 1 = the clip's fitted size (0.1..4)"),
              rotation: num("Degrees clockwise, -180..180"),
              opacity: num("0..1"),
            },
            ["t"]
          ),
        },
      },
      ["clipId", "keys"]
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
      "Set how a video clip meets its box (the project frame, or its region): 'fit' letterboxes the whole picture (default), 'fill' scales it to cover the box and crops the overflow. zoom pushes further in from there, 1..4. Whenever the picture overflows, panX/panY (-1..1, 0=centered) choose what stays visible — e.g. panY=-1 keeps the top. Landscape footage in a vertical project usually wants fill plus a pan that holds the subject.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      mode: { type: "string", enum: ["fit", "fill"], description: "Framing mode" },
      zoom: num("Zoom past the fitted size, 1 (none) .. 4"),
      panX: num("Crop pan -1 (left) .. 1 (right), when the picture overflows"),
      panY: num("Crop pan -1 (top) .. 1 (bottom), when the picture overflows"),
    }, ["clipId", "mode"]),
  },
  {
    name: "set_clip_style",
    description:
      "Style a video clip's box: rounded corners, a border ring along its edge, and a drop shadow cast by the clip's shape (its box, corners, and mask together — a circle-masked clip casts a circular shadow). Lengths are design px at the 1080 short side. Only the fields you pass change; pass clear:true to remove all styling.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      radius: num("Corner radius, design px (0 squares the corners)"),
      border_width: num("Border stroke width, design px (0 removes the ring)"),
      border_color: str("Border color (hex)"),
      shadow_blur: num("Shadow blur radius, design px; 0 with no offset removes the shadow"),
      shadow_x: num("Shadow x offset, design px (default 0)"),
      shadow_y: num("Shadow y offset, design px (default 0)"),
      shadow_color: str("Shadow ink (hex, default #000000)"),
      shadow_opacity: num("Shadow opacity 0..1 (default 0.35)"),
      clear: bool("Remove the box styling entirely"),
    }, ["clipId"]),
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
      "Color-grade a video clip's basic sliders (any track; stills too). Fields patch the clip's current grade: only the ones you pass change, and every value 0 is neutral. Manual adjustments layer OVER the clip's color preset (set_color_preset), never replacing it. reset:true clears the manual grade first (the preset stays); auto:true fits a starting grade from the clip's decoded frame (auto-tone: exposure to middle gray, contrast stretch, gray-world white balance — needs the clip's frame decoded, so seek into it first if this errors), and explicit fields then override it. Preview, timeline thumbnails, and export all render the same result. Read read_color_stats before grading so the numbers ground the move.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...gradeFieldProps,
      brightness: num(`-${GRADE_MAX}..${GRADE_MAX}, 0 neutral (plain gain; prefer exposure)`),
      hue: num(`Whole-frame hue rotation in degrees, -${GRADE_HUE_MAX}..${GRADE_HUE_MAX} (for one hue only, use set_color_hsl)`),
      auto: bool("Fit a starting grade from the clip's current frame"),
      reset: bool("Clear the existing manual grade before applying fields (keeps the preset)"),
    }, ["clipId"]),
  },
  {
    name: "set_color_preset",
    description:
      `Apply a named color preset to a video clip, layered under its manual grade. Presets by category — ${gradePresetCatalogText()}. amount 0..1 scales the preset toward neutral (default 1); protect_skin keeps its color shifts off skin tones. Pass preset "none" to clear. Preview, tiles, and export all render the same result.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      preset: {
        type: "string",
        enum: [...GRADE_PRESET_IDS, "none"],
        description: 'Preset id, or "none" to clear',
      },
      amount: num("Intensity 0..1 (default 1)"),
      protect_skin: bool("Keep the preset's color shifts off skin tones"),
    }, ["clipId", "preset"]),
  },
  {
    name: "set_color_curves",
    description:
      `Set a video clip's tone curves: per-channel [input, output] control points (0..255) through a monotone spline — master shapes all three channels, red/green/blue shape one each. A channel you pass replaces that channel; an empty list clears it; others keep their curve. The semantic knobs write the master curve for you: curve_contrast (-${GRADE_MAX}..${GRADE_MAX}) is an s-curve around mid-gray, fade (0..${GRADE_MAX}) lifts the blacks for a faded-film look; passing either replaces the master curve. reset:true clears every curve first.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      master: curvePoints("Master"),
      red: curvePoints("Red"),
      green: curvePoints("Green"),
      blue: curvePoints("Blue"),
      curve_contrast: num(`S-curve contrast -${GRADE_MAX}..${GRADE_MAX} (compiled into master points)`),
      fade: num(`Lifted blacks 0..${GRADE_MAX} (compiled into master points)`),
      reset: bool("Clear all curves before applying"),
    }, ["clipId"]),
  },
  {
    name: "set_color_wheels",
    description:
      `Set a video clip's color wheels — shadows, midtones, highlights — for split-toning: each wheel pushes its tonal range toward a hue (dx/dy is the wheel puck: angle = hue, 0° = red, 120° = green, 240° = blue; distance = strength) and trims its brightness (luma). A wheel you pass is replaced whole; {dx:0,dy:0,luma:0} clears it. reset:true clears all three.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      shadows: wheelArg("Shadow"),
      midtones: wheelArg("Midtone"),
      highlights: wheelArg("Highlight"),
      reset: bool("Clear all wheels before applying"),
    }, ["clipId"]),
  },
  {
    name: "set_color_hsl",
    description:
      `Adjust one hue band of a video clip — shift its hue (±${GRADE_MAX} ≈ ±30°), scale its saturation, and lift or darken its luminance — leaving every other color alone ("just the sky bluer", "mute the greens"). Bands: ${HSL_BANDS.map((b) => b.id).join(", ")}. The band's three values are replaced whole (omitted values 0); all-zero clears the band. reset_all clears every band first.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      band: {
        type: "string",
        enum: HSL_BANDS.map((b) => b.id),
        description: "Hue band to adjust",
      },
      hue: num(`Hue shift -${GRADE_MAX}..${GRADE_MAX} (≈ ±30°)`),
      sat: num(`Saturation -${GRADE_MAX}..${GRADE_MAX}`),
      luma: num(`Luminance -${GRADE_MAX}..${GRADE_MAX}`),
      reset_all: bool("Clear every hue band first"),
    }, ["clipId"]),
  },
  {
    name: "read_color_stats",
    description:
      "Read color statistics off a frame — per-channel and luma quantiles (0..255), channel means, mean saturation, and warmth (red/blue midtone ratio; >1 warm, <1 cool). Pass clipId for a video clip's current frame (pre-grade, so the numbers describe the footage itself; seek into the clip first if it errors) or assetId for an image (a chat attachment or Media import). Read stats before grading — never grade blind — and read them again after to verify the move.",
    inputSchema: obj({
      clipId: str("Video clip id (its current decoded frame)"),
      assetId: str("Image asset id (chat attachment or import)"),
    }),
  },
  {
    name: "match_color_grade",
    description:
      "Match a video clip's color to a reference, computed from the pixels: per-channel quantile mapping compiled into tone curves plus a saturation delta. The computed curves carry the whole look, so the match replaces the clip's entire grade, preset included. The reference is ref_asset_id (an attached or imported image) or ref_clip_id (another clip's current frame). Use when the user shares a look to copy or asks to match two shots; refine afterward with the other grading tools, checking read_color_stats.",
    inputSchema: obj({
      clipId: str("Video clip to grade"),
      ref_asset_id: str("Reference image asset id"),
      ref_clip_id: str("Reference video clip id (its current decoded frame)"),
    }, ["clipId"]),
  },
] as const satisfies readonly AiToolDef[];

export type InspectorToolName = (typeof INSPECTOR_TOOLS)[number]["name"];
