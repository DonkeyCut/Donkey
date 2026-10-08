/**
 * The assistant's Elements tools — shapes and stickers — kept beside the
 * panel that gives users the same tiles. The catalog spreads this list into
 * the model's toolset and `aiTools.ts` keys its handlers on
 * `ElementsToolName`, so the panel and the model always offer the same
 * element kinds and a removed or renamed tool breaks the build until every
 * side catches up.
 */

import { DOODLE_FPS, DOODLE_INKS_MAX, PATTERN_KINDS, SHADOW_BLUR_MAX, SHADOW_OFFSET_MAX, STRIPE_GAP_MAX, STRIPE_LINE_MAX, STRIPE_LINE_MIN } from "@donkeycut/effects-kit";
import { bool, num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { SHAPE_LABELS, type ShapeKind } from "@/cut/lib/types";

/** Every shape the panel's grid shows, in `SHAPE_LABELS` order. */
export const SHAPE_KINDS = Object.keys(SHAPE_LABELS) as ShapeKind[];

export const ELEMENTS_TOOLS = [
  {
    name: "add_shape",
    description:
      `Add a vector shape overlay (${SHAPE_KINDS.join(", ")}). Position is the shape center as frame fractions; w/h are frame fractions too (a line/arrow's h is its stroke thickness). Rotation gives lines and arrows their direction. A doodle is animated graffiti in translucent paint: inside its box (default: the whole frame) it paints one hand-drawn mark — a dry-brush smear, a painted X, a burst, a tall painted bar, a brushed ring, a pair of fat loops — often with a thin hand line beside it (a tall oval, standing strands, a scribble), and deals new ones ${DOODLE_FPS} times a second, each in the fill or one of its inks (default: the teal, cream, red, orange and white graffiti set). Put it on a row under the titles to paint behind them, or between titles to sit over one line and under another.`,
    inputSchema: obj({
      shape: { type: "string", enum: [...SHAPE_KINDS], description: "Shape kind" },
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.5)"),
      w: num("Width, fraction of frame width"),
      h: num("Height, fraction of frame height (line/arrow: thickness)"),
      fill: str("CSS color (default #FFFFFF; a doodle's default is the graffiti set's teal)"),
      inks: {
        type: "array",
        items: { type: "string" },
        maxItems: DOODLE_INKS_MAX,
        description: `Doodle: up to ${DOODLE_INKS_MAX} more paints beside the fill; each mark takes one of them or the fill`,
      },
      fill_opacity: num("Fill opacity 0..1 (rect/ellipse)"),
      radius: num("Rect corner radius, px at 1080 short side"),
      stroke_color: str("Outline color (rect/ellipse)"),
      stroke_width: num("Outline width px at 1080 short side (0 removes it)"),
      pattern: { type: "string", enum: [...PATTERN_KINDS, "none"], description: 'Not line/arrow: the fill color laid as a pattern clipped to the outline — "stripes" are parallel lines with clear gaps (a loading bar); absent or "none" = solid' },
      pattern_width: num(`Stripe line thickness, px at 1080, ${STRIPE_LINE_MIN}..${STRIPE_LINE_MAX} (default 2)`),
      pattern_gap: num(`Clear space between stripes, px at 1080, 0..${STRIPE_GAP_MAX} (default 1)`),
      pattern_angle: num("Stripe direction in degrees clockwise, -90..90; 0 = vertical lines"),
      shadow: bool("Drop shadow on or off (default off); the shadow_* fields switch it on"),
      shadow_color: str("Shadow hex color, e.g. #00E5FF"),
      shadow_blur: num(`Shadow blur, px at 1080, 0..${SHADOW_BLUR_MAX}`),
      shadow_opacity: num("Shadow opacity 0..1"),
      shadow_y: num(`Shadow drop, px at 1080, -${SHADOW_OFFSET_MAX}..${SHADOW_OFFSET_MAX}; 0 with a bright color makes a glow`),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
      lane: num("Element row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, ["shape"]),
  },
  {
    name: "add_sticker",
    description:
      "Add a sticker overlay from a project image asset (asset ids come from `media`; sticker uploads carry origin \"sticker\"). Width is a frame-width fraction; height follows the source's own aspect unless h sets it.",
    inputSchema: obj({
      asset_id: str("Project image asset id"),
      start: num("Start time s (default: playhead)"),
      end: num("End time s (default: start+3)"),
      x: num("Center x 0..1 (default 0.5)"),
      y: num("Center y 0..1 (default 0.5)"),
      w: num("Width, fraction of frame width (default 0.25)"),
      h: num("Height, fraction of frame height; omit to keep the source's aspect"),
      rotation: num("Degrees clockwise, -180..180"),
      opacity: num("Whole-element opacity 0..1"),
      lane: num("Element row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }),
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
      h: num("Height, fraction of frame height; omit to keep the source's aspect"),
      lane: num("Element row (0 = the front row, drawn over every higher row). Elements on one row never overlap — a title over a shape needs a lower row than the shape."),
    }, ["idea"]),
  },
] as const satisfies readonly AiToolDef[];

export type ElementsToolName = (typeof ELEMENTS_TOOLS)[number]["name"];
