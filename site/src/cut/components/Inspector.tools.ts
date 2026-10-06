/**
 * The assistant's inspector tools — the per-item edits the inspector exposes
 * for whatever is selected: overlay elements, soundtrack clips, and a video
 * clip's volume, detached audio, framing, speed, and color grade — kept
 * beside the inspector component. The catalog spreads this list into the
 * model's toolset and `aiTools.ts` keys its handlers on `InspectorToolName`.
 */

import {
  GRADE_BASIC_FIELDS,
  GRADE_DETAIL_FIELDS,
  GRADE_HUE_MAX,
  GRADE_MAX,
  GRADE_PRESET_IDS,
  gradePresetCatalogText,
  HSL_BANDS,
  SOURCE_PROFILES,
  WHEEL_LABELS,
  WHEEL_ZONES,
  SOUND_COMPRESSOR_RANGE,
  SOUND_EQ_BANDS,
  SOUND_EQ_DB_RANGE,
  SOUND_LIMITER_RANGE,
  SOUND_PRESETS,
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  SPEED_CURVE_PRESET_IDS,
  speedCurvePresetCatalogText,
  MASK_FEATHER_MAX,
  MASK_KINDS,
  MASK_RADIUS_MAX,
  PEN_MIN_POINTS,
} from "@donkeycut/effects-kit";
import { bool, ids, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { builtinLutCatalogText } from "@/cut/lib/builtinLuts";
import { SPLIT_EDIT_MAX_S } from "@/cut/lib/soundSource";

/** Per-field slider hints; ranges interpolate the exported constants so the
 * schema can never drift from the model the renderer clamps to. */
const GRADE_FIELD_HINTS: Record<string, string> = {
  exposure: "(±2 stops, in linear light)",
  contrast: "around 18% grey",
  highlights: "trim (-) or boost (+) the brights",
  shadows: "lift (+) or crush (-) the darks",
  whites: "the white point: pull (-) or push (+) the very brightest values",
  blacks: "the black point: lift (+) or deepen (-) the very darkest values",
  brilliance: "brings up the darks and tames the brights together, like a photo app's brilliance",
  fade: "lifts the blacks toward grey for a faded-film look",
  temperature: "positive = warmer (mireds, CAT02 white balance)",
  tint: "negative = green, positive = magenta",
  saturation: `(-${GRADE_MAX} = grayscale)`,
  vibrance: "saturation weighted toward the muted colors",
  sharpen: "sharpens fine edges (luma only)",
  clarity: "local contrast across larger structures (luma only)",
};

/** A slider's range text: centred sliders run ±GRADE_MAX, one-sided ones 0..GRADE_MAX. */
const gradeRange = (min: number) => `${min < 0 ? `-${GRADE_MAX}` : "0"}..${GRADE_MAX}, 0 neutral`;

const gradeFieldProps = Object.fromEntries(
  [...GRADE_BASIC_FIELDS, ...GRADE_DETAIL_FIELDS].map((f) => [
    f.key,
    num(`${gradeRange(f.min)}${GRADE_FIELD_HINTS[f.key] ? ` — ${GRADE_FIELD_HINTS[f.key]}` : ""}`),
  ])
);

/** The tool argument for each wheel, keyed by the wheel's label in lower case
 * (lift, gamma, gain, offset). */
const WHEEL_ARGS: Record<string, (typeof WHEEL_ZONES)[number]> = Object.fromEntries(
  WHEEL_ZONES.map((z) => [WHEEL_LABELS[z].toLowerCase(), z])
);

/** Several clips at once, the same way `ids` fans a sweep out, plus every
 * clip on the timeline. */
const manyClips = {
  ids: ids("clipId"),
  all_clips: bool("Land the change on every clip on the timeline (instead of clipId or ids)"),
};

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

const wheelArgs = Object.fromEntries(
  Object.entries(WHEEL_ARGS).map(([name, z]) => [name, wheelArg(WHEEL_LABELS[z])])
);

export const INSPECTOR_TOOLS = [
  {
    name: "update_overlay",
    description:
      "Update any overlay element — title, shape, or sticker — by id (from the selection or state). Titles take text/size/font/weight/color/shadow/plate; shapes take w/h/fill/fill_opacity/radius/stroke; stickers take w/h. Every kind takes name, timing, position, rotation, opacity, hidden. This is the tool for 'make this text better' requests too. Pass ids to land one change on several elements at once (a group, every title in a run): fields a kind lacks are skipped on that element, and the whole write is one undo step.",
    inputSchema: obj({
      id: str("Overlay element id"),
      ids: { type: "array", items: { type: "string" }, description: "Several element ids to change together (instead of id)" },
      name: str("What the person calls this element — shown on its timeline chip and inspector title (empty string clears it, back to what it is)"),
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
      wrap_width: num("Text box width as a frame-width fraction, 0.01..2; 0 restores auto width. Text wraps and height follows content."),
      shadow: bool("Drop shadow (titles)"),
      plate: bool("Backdrop plate (titles)"),
      w: num("Width, fraction of frame width (shapes/stickers)"),
      h: num("Height, fraction of frame height (shapes/stickers; a sticker's 0 returns it to the source's aspect)"),
      fill: str("Fill color (shapes)"),
      fill_opacity: num("Fill opacity 0..1 (rect/ellipse)"),
      radius: num("Rect corner radius, px at 1080 short side"),
      stroke_color: str("Outline color — text or shape"),
      stroke_width: num("Outline width: em for titles (0..0.15), px at 1080 for shapes; 0 removes it"),
      rotation: num("Degrees clockwise, -180..180 (0 clears)"),
      opacity: num("Whole-element opacity 0..1 (1 clears)"),
      hidden: bool("Hide the element without deleting it"),
      lane: num("Move the element to another row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, []),
  },
  {
    name: "set_mask",
    description:
      "Mask an overlay element or a video clip — trim its picture to a shape or to the person in the shot. Kinds: rect (rounded box), square (rounded square, side = w of the frame width), circle (ellipse; w and h are frame fractions, so a perfect circle needs w × frame width = h × frame height — omitting h gives you that circle), linear (half-plane: at rotation 0 the top side stays), mirror (band across the item), heart / star / triangle / diamond / hexagon (the outline filled into the w × h box, point up), pen (an outline you give as `points` — the shape for any region the fixed shapes miss: the gap between two hands, a doorway, a screen in the shot; its box defaults to the whole frame, w = h = 1, so a point is an offset from the item's center in frame fractions, (-0.5, -0.5) the frame's top-left corner; the box's position, size, rotation and keys then carry the whole drawing), subject (the person matte: invert true sits the item behind the speaker; invert false keeps it only on the person — an element newly masked as subject defaults to behind, a clip to on-person). Position is the mask center's offset from the item's own center (a clip's region center), in frame fractions; w/h size it in frame fractions; feather softens the edge; invert keeps what the shape leaves out; radius rounds a rect or square's corners. Subject masks use only feather and invert. Pass kind \"none\" to remove the mask. `keys` animates the geometry over time — each key is the full geometry at a moment, moving linearly between keys; pass an empty list to clear the keys and keep the mask still.",
    inputSchema: obj({
      id: str("Overlay element id or video clip id"),
      kind: {
        type: "string",
        enum: [...MASK_KINDS, "none"],
        description: 'Mask shape, the person matte ("subject"), or "none" to remove the mask',
      },
      x: num("Center offset x from the element center, fraction of frame width (default 0)"),
      y: num("Center offset y, fraction of frame height (default 0)"),
      w: num("Width, fraction of frame width (default 0.5; square: the side; linear ignores)"),
      h: num("Height, fraction of frame height (mirror: band height; square/linear ignore)"),
      rotation: num("Degrees clockwise, -180..180"),
      feather: num(`Edge softness, px at the 1080 design short side (0..${MASK_FEATHER_MAX})`),
      invert: bool("Keep the pixels outside the shape"),
      radius: num(`Rect or square corner radius, px at 1080 short side (0..${MASK_RADIUS_MAX})`),
      points: {
        type: "array",
        description: `Pen only: the outline's corners in order around it, at least ${PEN_MIN_POINTS}, each an offset from the mask center in fractions of the mask box (with the pen's default w = h = 1: frame fractions from the item's center, -0.5..0.5 inside the frame); replaces the outline`,
        items: obj({ x: num("Offset x, fraction of the mask box width"), y: num("Offset y, fraction of the mask box height") }, ["x", "y"]),
      },
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
            radius: num("Rect or square corner radius, px at 1080 short side"),
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
      "Update a soundtrack clip: volume (0..3), fadeIn/fadeOut seconds, start position, lane, in/out trim, speed, reverse, hidden, or duck. Audio overlaps across lanes; clips on the same lane slide to its next free slot. To put music under narration, move music to lane 1 and start 0 in the same call, with narration on lane 0. `duck` is voiceover ducking — while this clip plays, ALL other audio drops to that gain (0..1); pass 1 to clear ducking.",
    inputSchema: obj({
      id: str("Soundtrack clip id"),
      ids: ids("id"),
      lane: { type: "integer", minimum: 0, description: "Audio lane, 0-based. Separate lanes play together." },
      volume: num("0..3 (1 = unchanged, above 1 boosts)"),
      fadeIn: num("Fade-in seconds"),
      fadeOut: num("Fade-out seconds"),
      start: num("Timeline start s"),
      in: num("Source in s"),
      out: num("Source out s"),
      speed: num("Playback rate (1 = normal, no upper limit)"),
      reverse: bool("Play the sound backward; false plays it forward again"),
      duck: num("Duck other audio to this gain while this clip plays, 0..1 (1 clears ducking)"),
      hidden: bool("Silence the clip without removing it (grayed on the timeline)"),
    }, ["id"]),
  },
  {
    name: "set_clip_volume",
    description: "Set the gain on a video clip's own audio (soundtrack clips use update_audio).",
    inputSchema: obj({ clipId: str("Video clip id"), ids: ids("clipId"), volume: num("0..3 (1 = unchanged, up to 3 boosts the clip's own sound)") }, ["volume"]),
  },
  {
    name: "sync_audio",
    description:
      "Dual-system sound: line up a separately recorded audio file (a lavalier, a recorder, a second camera's mic) with a video by matching it against the camera's own sound, then bind it to the video. Every clip of that video — the ones on the timeline now and any split, trimmed, sped, reversed, or copied later — plays the recording through its own trim and speed, and the camera's track goes quiet; the preview, every export, captions, and the listening tools all hear the recording. Name the video by clipId (one of its clips) or assetId, and the recording by audio_asset_id (an audio file in the project). The match reports `offset` (recording seconds = video seconds + offset) and `confidence`; when no single alignment stands out — a different take, or two files with no sound in common — it refuses and binds nothing, and the user can pick another file. clear: true returns the video to its own sound. editor_state shows each bound video's `soundFrom` on its media entry.",
    inputSchema: obj({
      clipId: str("A video clip whose source video gets the recording"),
      assetId: str("The video asset to bind, when no clip names it"),
      audio_asset_id: str("The audio asset holding the clean recording"),
      clear: bool("Unbind the recording: the video plays its own sound again"),
    }),
  },
  {
    name: "set_split_edit",
    description: `Split edit on a video clip: its sound starts ahead of its picture (lead — a J-cut, the next speaker heard before the cut) or carries on past it (tail — an L-cut, a voice running over the next shot). The extension plays the clip's own source from beyond its trim, under the neighbouring clip, ramping in from silence at the far end; pictures and clip positions stay where they are. Typical values: 0.05–0.5 s to soften a dialogue cut, 1–2 s to hand one scene into the next. Each side is capped at ${SPLIT_EDIT_MAX_S} s and at the source the clip has beyond its trim; 0 clears that side, and a side left out keeps its value. A cut carrying a transition keeps the transition's own handover, so that side plays no split edit. editor_state reports audioLead/audioTail on the clip.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ids: ids("clipId"),
      lead: num(`Seconds the sound starts before the picture, 0..${SPLIT_EDIT_MAX_S} (0 clears)`),
      tail: num(`Seconds the sound carries past the picture's end, 0..${SPLIT_EDIT_MAX_S} (0 clears)`),
    }),
  },
  {
    name: "set_clip_sound",
    description:
      `Shape a clip's own sound — video clip or soundtrack clip — with the Sound quality section's three stages: a ${SOUND_EQ_BANDS.length}-band equalizer, a compressor, and a limiter. Each stage runs on that clip alone, before its fades and any ducking, in the preview and every export. Pass \`preset\` to apply a shipped treatment (${SOUND_PRESETS.map((p) => `"${p.name}"`).join(", ")}) or one the user saved, by name or id; or set the stages directly, leaving out the ones that stay as they are. \`clear\` names stages to remove, and the "Off" preset removes all three. Read the clip's current treatment from editor_state before a partial change.`,
    inputSchema: obj(
      {
        clipId: str("Video clip id or soundtrack clip id"),
        preset: str(
          `A preset by name or id, plus whatever the user has saved. Shipped: ${SOUND_PRESETS.filter((p) => p.sound).map((p) => `"${p.name}" (${p.id}) — ${p.character}`).join("; ")}. "Off" (flat) leaves the clip's sound as it came.`
        ),
        clear: {
          type: "array",
          description: "Stages to remove from the clip's treatment.",
          items: { type: "string", enum: ["eq", "compressor", "limiter"] },
        },
        eq: {
          type: "array",
          description: `Gain in dB per band, −${SOUND_EQ_DB_RANGE}..+${SOUND_EQ_DB_RANGE}, in this order: ${SOUND_EQ_BANDS.map((b) => b.label).join(", ")} (the first band is a low shelf, the last a high shelf, the rest peaks). Fewer values leave the remaining bands flat.`,
          items: { type: "number" },
        },
        compressor: obj(
          {
            threshold: num(`dB, ${SOUND_COMPRESSOR_RANGE.threshold.min}..${SOUND_COMPRESSOR_RANGE.threshold.max}`),
            ratio: num(`${SOUND_COMPRESSOR_RANGE.ratio.min}..${SOUND_COMPRESSOR_RANGE.ratio.max} (:1)`),
            attack: num(`ms, ${SOUND_COMPRESSOR_RANGE.attack.min}..${SOUND_COMPRESSOR_RANGE.attack.max}`),
            release: num(`ms, ${SOUND_COMPRESSOR_RANGE.release.min}..${SOUND_COMPRESSOR_RANGE.release.max}`),
          },
          ["threshold", "ratio", "attack", "release"]
        ),
        limiter: obj(
          { ceiling: num(`dBFS ceiling, ${SOUND_LIMITER_RANGE.ceiling.min}..${SOUND_LIMITER_RANGE.ceiling.max}`) },
          ["ceiling"]
        ),
      },
      ["clipId"]
    ),
  },
  {
    name: "save_sound_preset",
    description:
      "Save a clip's current sound treatment (equalizer, compressor, limiter) to the user's Library under a name, so set_clip_sound can apply it to other clips by that name and the Sound quality section offers it in its preset dropdown.",
    inputSchema: obj(
      { clipId: str("Video clip id or soundtrack clip id whose treatment to save"), name: str("Preset name") },
      ["clipId", "name"]
    ),
  },
  {
    name: "detach_audio",
    description:
      "Detach Audio: lift a clip's sound onto the soundtrack track (mutes the clip) so it can be edited independently. Select the clip first or pass its id. Pass assetId instead to put a source's whole track on the soundtrack with none of its picture placed — how a cut blocked out as empty shots carries the reference's sound.",
    inputSchema: obj({
      clipId: str("Video clip id (optional if one is selected)"),
      assetId: str("Project asset id — its whole audio track lands on the soundtrack, no clip placed"),
      start: num("Timeline start s for an assetId detach (default 0)"),
    }),
  },
  {
    name: "set_framing",
    description:
      "Set how a video clip meets its box (the project frame, or its region): 'fit' letterboxes the whole picture (default), 'fill' scales it to cover the box and crops the overflow. zoom pushes further in from there, 1..4. Whenever the picture overflows, panX/panY (-1..1, 0=centered) choose what stays visible — e.g. panY=-1 keeps the top. flipH mirrors the picture left for right (a front-camera take that reads backward, text and all, wants flipH true), flipV top for bottom. Only the fields you pass change; the rest of the clip's framing stays. Landscape footage in a vertical project usually wants fill plus a pan that holds the subject.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      ids: ids("clipId"),
      mode: { type: "string", enum: ["fit", "fill"], description: "Framing mode" },
      zoom: num("Zoom past the fitted size, 1 (none) .. 4"),
      panX: num("Crop pan -1 (left) .. 1 (right), when the picture overflows"),
      panY: num("Crop pan -1 (top) .. 1 (bottom), when the picture overflows"),
      flipH: bool("Mirror the picture horizontally"),
      flipV: bool("Mirror the picture vertically"),
    }, ["clipId"]),
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
      "Set a video clip's playback speed, one rate across the whole clip, and/or play it backward. A still has no motion to retime and is refused; trim_clip is what changes how long it holds. Faster shortens the clip on the timeline; slower stretches it. Later clips, titles, captions, and soundtrack shift to stay in sync. A clip carrying a speed curve loses it when speed is passed: the rate becomes uniform again (set_speed_curve is the tool for a rate that changes through the footage). `reverse: true` plays the clip's trim backward, picture and sound, at its rate — the clip keeps its length and its curve, and its head now shows source `out`; `reverse: false` turns it forward again. `smooth: true` smooths the clip's slow motion: wherever its rate is under 1×, the frames between source frames are synthesized (the export estimates the motion between them) so the slow stretch moves without stepping; at 1× and above nothing changes. Turn it on for real slow motion from ordinary footage; `smooth: false` shows the source frames as they are.",
    inputSchema: obj({ clipId: str("Video clip id"), ids: ids("clipId"), speed: num("Playback rate (1 = normal, no upper limit)"), reverse: bool("Play the footage backward (true) or forward (false)"), smooth: bool("Smooth slow motion: synthesize the frames between source frames wherever the rate is under 1×") }),
  },
  {
    name: "set_speed_curve",
    description:
      `Give a video clip (any track) a speed curve: its rate changes through the footage instead of being one number, so one clip can race through a walk, land on a beat, and hold on a face. A still is refused — it has no motion to retime. Nodes are {at, speed}: \`at\` in SOURCE seconds inside the clip's trim — the unit detect_beats, trim_clip and watch_video speak, so beat times drop straight in — and speed ${SPEED_CURVE_MIN}–${SPEED_CURVE_MAX}×. The rate curves smoothly between nodes and holds flat past the outermost ones; the whole list replaces the clip's curve, and an empty list clears it (the clip keeps its length at one uniform rate). Or pass a preset to lay a named ramp over the trim: ${speedCurvePresetCatalogText()}. Technique: give a peak a beat of normal speed on either side or it reads as a glitch; below about 0.5× ordinary footage shows its own frame rate, so pass \`smooth: true\` with the curve — it synthesizes the frames between source frames wherever the rate is under 1× and leaves the faster stretches alone — unless the source is high-frame-rate already; sound stretches with its pitch kept, which holds up on speech to roughly 0.5–2×. The clip's timeline length becomes the integral of the curve and later items shift like a trim. Returns the resulting nodes, the clip's length before and after, and the rows that moved. In the UI the Speed Curve row opens the same graph over the timeline.`,
    inputSchema: obj(
      {
        clipId: str("Video clip id"),
        nodes: {
          type: "array",
          description: "The whole curve, any order; empty clears it",
          items: obj(
            {
              at: num("Source seconds, inside the clip's trim"),
              speed: num(`Rate at that moment, ${SPEED_CURVE_MIN}–${SPEED_CURVE_MAX}`),
            },
            ["at", "speed"]
          ),
        },
        preset: {
          type: "string",
          enum: SPEED_CURVE_PRESET_IDS,
          description: "A named ramp laid over the clip's trim, instead of nodes",
        },
        smooth: bool("Smooth slow motion: synthesize the frames between source frames wherever the curve is under 1×"),
      },
      ["clipId"]
    ),
  },
  {
    name: "set_color_grade",
    description:
      `Color-grade a video clip's basic sliders (any track; stills too): the Light group (${GRADE_BASIC_FIELDS.filter((f) => f.group === "light").map((f) => f.key).join(", ")}), the Color group (${GRADE_BASIC_FIELDS.filter((f) => f.group === "color").map((f) => f.key).join(", ")}) and the Detail pair (${GRADE_DETAIL_FIELDS.map((f) => f.key).join(", ")}). Fields patch the clip's current grade: only the ones you pass change, and every value 0 is neutral. The light sliders work in linear light on the picture after its source conversion and LUT; manual adjustments layer OVER the clip's color preset (set_color_preset), never replacing it. reset:true clears the manual grade first (the preset and LUT stay); auto:true fits a starting grade from the clip's base rendering (auto-tone: exposure to middle gray, contrast stretch, gray-world white balance — needs the clip's frame decoded, so seek into it first if this errors), and explicit fields then override it. Preview, timeline thumbnails, and export all render the same result. Read read_color_stats before grading so the numbers ground the move. Pass ids or all_clips to land the same patch on several clips as one undo step.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      ...gradeFieldProps,
      brightness: num(`-${GRADE_MAX}..${GRADE_MAX}, 0 neutral (plain gain; prefer exposure)`),
      hue: num(`Whole-frame hue rotation in degrees, -${GRADE_HUE_MAX}..${GRADE_HUE_MAX} (for one hue only, use set_color_hsl)`),
      auto: bool("Fit a starting grade from the clip's current frame"),
      reset: bool("Clear the existing manual grade before applying fields (keeps the preset and the LUT)"),
    }),
  },
  {
    name: "set_color_preset",
    description:
      `Apply a named color preset to a video clip, layered under its manual grade. Presets by category — ${gradePresetCatalogText()}. amount 0..1 scales the preset toward neutral (default 1); protect_skin keeps its color shifts off skin tones. Pass preset "none" to clear. Preview, tiles, and export all render the same result.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
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
      `Set a video clip's tone curves: per-channel [input, output] control points (0..255) through a monotone spline — master shapes all three channels, red/green/blue shape one each. A channel you pass replaces that channel; an empty list clears it; others keep their curve. curve_contrast (-${GRADE_MAX}..${GRADE_MAX}) writes an s-curve around mid-gray into the master curve for you, replacing it (lifted, faded blacks are the fade slider of set_color_grade). reset:true clears every curve first. Pass ids or all_clips to land the same curves on several clips.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      master: curvePoints("Master"),
      red: curvePoints("Red"),
      green: curvePoints("Green"),
      blue: curvePoints("Blue"),
      curve_contrast: num(`S-curve contrast -${GRADE_MAX}..${GRADE_MAX} (compiled into master points)`),
      reset: bool("Clear all curves before applying"),
    }),
  },
  {
    name: "set_color_wheels",
    description:
      `Set a video clip's four color wheels — ${WHEEL_ZONES.map((z) => WHEEL_LABELS[z].toLowerCase()).join(", ")} — the ASC CDL set: lift moves the shadows, gamma the midtones, gain the highlights, and offset shifts the whole picture equally. Each wheel pushes its range toward a hue (dx/dy is the wheel puck: angle = hue, 0° = red, 120° = green, 240° = blue; distance = strength) and trims its brightness (luma). A wheel you pass is replaced whole; {dx:0,dy:0,luma:0} clears it. reset:true clears all four. Pass ids or all_clips to land the same wheels on several clips.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      ...wheelArgs,
      reset: bool("Clear all wheels before applying"),
    }),
  },
  {
    name: "set_color_hsl",
    description:
      `Adjust one hue band of a video clip — shift its hue (±${GRADE_MAX} ≈ ±30°), scale its saturation, and lift or darken its luminance — leaving every other color alone ("just the sky bluer", "mute the greens"). Bands: ${HSL_BANDS.map((b) => b.id).join(", ")}. The band's three values are replaced whole (omitted values 0); all-zero clears the band. reset_all clears every band first.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      band: {
        type: "string",
        enum: HSL_BANDS.map((b) => b.id),
        description: "Hue band to adjust",
      },
      hue: num(`Hue shift -${GRADE_MAX}..${GRADE_MAX} (≈ ±30°)`),
      sat: num(`Saturation -${GRADE_MAX}..${GRADE_MAX}`),
      luma: num(`Luminance -${GRADE_MAX}..${GRADE_MAX}`),
      reset_all: bool("Clear every hue band first"),
    }),
  },
  {
    name: "set_color_lut",
    description:
      `Put a LUT on a video clip, or take it off. editor_state.luts lists every LUT by id ("lut:<key>"): the built-in film looks, marked builtIn — ${builtinLutCatalogText()} — and the user's own .cube/.3dl files in the Library. The LUT is applied to the picture after the clip's source conversion and under the grade, so a creative LUT works on log footage and the sliders shape what comes out. amount 0..1 mixes the LUT's result with its input (default 1). Pass lut "none" to remove it. A Log-to-Rec.709 technical LUT (a camera maker's) belongs on a clip whose source color is set to rec709 (set_source_color) so it is not converted twice. Pass ids or all_clips to land the same LUT on several clips as one undo step.`,
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      lut: str('A LUT id ("lut:<key>", from editor_state.luts) or "none" to remove the LUT'),
      amount: num("Intensity 0..1 (default 1; omitted keeps the clip's current amount)"),
    }, ["lut"]),
  },
  {
    name: "copy_color_grade",
    description:
      "Copy a video clip's whole color grade — preset, sliders, curves, wheels, hue bands, LUT and intensity — onto other clips, as one undo step. This is \"apply to all\": pass all_clips for every clip on the timeline, or ids for a chosen set. The source clip's grade replaces whatever the targets wore.",
    inputSchema: obj({
      clipId: str("The clip whose grade to copy"),
      ids: ids("clipId (the clips to copy it onto)"),
      all_clips: bool("Copy it onto every other clip on the timeline"),
    }, ["clipId"]),
  },
  {
    name: "set_source_color",
    description:
      `Set what a source's code values mean — its color profile — for footage the header did not settle or the user wants read differently: ${SOURCE_PROFILES.map((p) => `${p.id} (${p.label}: ${p.detail.replace(/\.$/, "")})`).join("; ")}. A log or HDR profile is converted to Rec.709 display values before any LUT or grade (Apple Log through the ACES output transform, HLG/PQ through BT.2100). "auto" returns the asset to the profile read from its file (editor_state.media shows each asset's sourceColor with what was detected). Pass assetId, or clipId for the clip's own source; every clip cut from that source changes with it.`,
    inputSchema: obj({
      assetId: str("Project asset id"),
      clipId: str("A video clip id — its source asset is the one changed"),
      profile: {
        type: "string",
        enum: [...SOURCE_PROFILES.map((p) => p.id), "auto"],
        description: 'Source profile, or "auto" for the detected one',
      },
    }, ["profile"]),
  },
  {
    name: "save_color_grade",
    description:
      "Save a clip's current color grade — preset, sliders, curves, wheels, hue bands and LUT — to the user's Library under a name, so apply_saved_grade can put it on other clips and the Color panel's Saved category offers it.",
    inputSchema: obj({ clipId: str("Video clip whose grade to save"), name: str("Preset name") }, ["clipId", "name"]),
  },
  {
    name: "apply_saved_grade",
    description:
      "Put one of the user's saved color grades (editor_state.savedGrades, or library_list templates carrying a grade) on a video clip, replacing the clip's whole grade. Pass ids or all_clips for several clips as one undo step.",
    inputSchema: obj({
      clipId: str("Video clip id"),
      ...manyClips,
      preset_id: str("The saved grade's id, or its name"),
    }, ["preset_id"]),
  },
  {
    name: "read_color_stats",
    description:
      "Read color statistics off a frame — per-channel and luma quantiles (0..255), channel means, mean saturation, and warmth (red/blue midtone ratio; >1 warm, <1 cool). Pass clipId for a video clip's current frame (seek into the clip first if it errors) or assetId for an image (a chat attachment or Media import). A clip reads as its base rendering — through the source conversion, before any LUT or grade, so the numbers describe the footage itself; graded:true reads it through the clip's LUT, preset and adjustments, which is how a move is verified. Read the base before grading — never grade blind — and the graded frame after.",
    inputSchema: obj({
      clipId: str("Video clip id (its current frame)"),
      assetId: str("Image asset id (chat attachment or import)"),
      graded: bool("Read the clip as graded (LUT, preset and adjustments applied) to verify a move; default reads the ungraded base"),
    }),
  },
  {
    name: "match_color_grade",
    description:
      "Match a video clip's color to a reference, computed from the pixels: per-channel quantile mapping compiled into tone curves plus a saturation delta. The computed curves carry the whole look, so the match replaces the clip's entire grade, preset and LUT included. The reference is ref_asset_id (an attached or imported image) or ref_clip_id (another clip's current frame). Use when the user shares a look to copy or asks to match two shots; refine afterward with the other grading tools, checking read_color_stats.",
    inputSchema: obj({
      clipId: str("Video clip to grade"),
      ref_asset_id: str("Reference image asset id"),
      ref_clip_id: str("Reference video clip id (its current frame's base rendering)"),
    }, ["clipId"]),
  },
] as const satisfies readonly AiToolDef[];

export type InspectorToolName = (typeof INSPECTOR_TOOLS)[number]["name"];
