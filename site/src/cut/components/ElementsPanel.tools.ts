/**
 * The assistant's Elements tools — shapes and stickers — kept beside the
 * panel that gives users the same tiles. The catalog spreads this list into
 * the model's toolset and `aiTools.ts` keys its handlers on
 * `ElementsToolName`, so the panel and the model always offer the same
 * element kinds and a removed or renamed tool breaks the build until every
 * side catches up.
 */

import { num, obj, str, type AiToolDef } from "@/cut/lib/aiToolDef";
import { SHAPE_LABELS, type ShapeKind } from "@/cut/lib/types";

/** Every shape the panel's grid shows, in `SHAPE_LABELS` order. */
export const SHAPE_KINDS = Object.keys(SHAPE_LABELS) as ShapeKind[];

export const ELEMENTS_TOOLS = [
  {
    name: "add_shape",
    description:
      `Add a vector shape overlay (${SHAPE_KINDS.join(", ")}). Position is the shape center as frame fractions; w/h are frame fractions too (a line/arrow's h is its stroke thickness). Rotation gives lines and arrows their direction.`,
    inputSchema: obj({
      shape: { type: "string", enum: [...SHAPE_KINDS], description: "Shape kind" },
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
      lane: num("Element row (0 = the bottom row). Elements on one row never overlap — a title over a shape needs a higher row than the shape."),
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
      lane: num("Element row (0 = the bottom row). Elements on one row never overlap — a title over a shape needs a higher row than the shape."),
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
      lane: num("Element row (0 = the bottom row). Elements on one row never overlap — a title over a shape needs a higher row than the shape."),
    }, ["idea"]),
  },
] as const satisfies readonly AiToolDef[];

export type ElementsToolName = (typeof ELEMENTS_TOOLS)[number]["name"];
