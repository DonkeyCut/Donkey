/**
 * The overlay element model: one discriminated union for everything that
 * composites over the video frame. Positions are center fractions of the
 * output frame (0..1); pixel sizes are design pixels at a 1080 short side,
 * so an element reads the same at any aspect or export resolution.
 */

import type { OverlayAnim } from "./anim";
import type { EffectOverlay } from "./effects";
import type { OverlayKey } from "./keys";
import type { Mask } from "./mask";

/** Fields every overlay element carries, whatever its kind. */
export interface OverlayBase {
  id: string;
  start: number; // timeline seconds
  end: number;
  x: number; // center, fraction of frame width 0..1
  y: number; // center, fraction of frame height 0..1
  /** Which overlay track (row) this sits on, 0-based. */
  lane?: number;
  /** Rotation about the element center, degrees clockwise; absent = 0. */
  rotation?: number;
  /** Whole-element opacity 0..1; absent = 1. */
  opacity?: number;
  /** Hidden elements stay on the timeline (grayed) but are excluded from the
   * played/exported picture. */
  hidden?: boolean;
  /** Group membership (select/move as one); assigned by the host's grouping. */
  groupId?: string;
  /** Preset In / Out / Loop animation (see anim.ts); absent = static. */
  anim?: OverlayAnim;
  /** Keyframed pose track, seconds from the element's start (see keys.ts).
   * Absent or empty = the element holds its resting pose; presets compose
   * over whichever of the two is in play. */
  kf?: OverlayKey[];
  /** Coverage that trims the element's pixels to a shape or to the person in
   * the shot (see mask.ts); absent = the whole element shows. */
  mask?: Mask;
}

/** How a highlighted word lights up in karaoke text: accent color only,
 * accent color plus underline, or an accent box behind the word. */
export type WordAccentMode = "color" | "underline" | "box";

/** A custom drop shadow. Every field is optional — absent ones take the
 * legacy defaults, so `shadow: true` and `shadow: {}` render identically. */
export interface TextShadowSpec {
  color?: string; // hex; opacity folds in separately
  blur?: number; // px at the 1080 design short side
  offsetY?: number; // px at the 1080 design short side
  opacity?: number; // 0..1
}

export type TextAlign = "left" | "center" | "right";

/** A text element. `kind` may be absent — documents written before the union
 * existed stored bare title objects, and absence still means text. `font` is a
 * host font id, resolved to a CSS stack through the render env. */
export interface TextOverlay extends OverlayBase {
  kind?: "text";
  text: string;
  size: number; // px at a 1080-wide design frame
  font: string;
  weight: 400 | 700;
  italic?: boolean;
  color: string;
  /** Outline drawn behind the fill (stroke-before-fill; the DOM pair is
   * -webkit-text-stroke with paint-order: stroke fill). Width is in em so the
   * outline scales with the text. */
  stroke?: { color: string; width: number };
  /** Extra tracking between glyphs, in em. */
  letterSpacing?: number;
  /** Line height as a multiplier; absent = the shared LINE_HEIGHT. */
  lineHeight?: number;
  /** How lines align inside the text block; absent = center. The block
   * itself stays centered on (x, y). */
  align?: TextAlign;
  /** Drop shadow: `true` = the legacy default look, an object customizes it. */
  shadow: boolean | TextShadowSpec;
  plate: boolean; // rounded plate behind the text
  plateRadius?: number; // plate corner radius in em
  plateColor?: string; // plate fill color
  plateOpacity?: number; // plate fill opacity 0..1
  /** Karaoke burn-in: index of the display word (whitespace-split across all
   * lines) drawn per the accent treatment. */
  highlightWord?: number;
  highlightColor?: string;
  highlightMode?: WordAccentMode;
  highlightText?: string;
}

export type ShapeKind =
  | "rect"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "star"
  | "heart"
  | "hexagon"
  | "line"
  | "arrow";

/** Shapes drawn as a stroke across the element box: `h` is the stroke
 * thickness and rotation gives them their direction. Every other kind is a
 * filled outline with the box as its bounds. */
export function lineLikeShape(k: ShapeKind): boolean {
  return k === "line" || k === "arrow";
}

export interface ShapeOverlay extends OverlayBase {
  kind: "shape";
  shape: ShapeKind;
  w: number; // width, fraction of frame width
  h: number; // height, fraction of frame height (line/arrow: stroke thickness)
  fill: string;
  fillOpacity?: number; // 0..1, absent = 1 (composes with `opacity`)
  radius?: number; // rect corner radius, px at 1080 short side
  stroke?: { color: string; width: number }; // outline, width px at 1080 short side
}

/** An image sticker. Height follows the source's own aspect, so only the
 * width is stored. */
export interface StickerOverlay extends OverlayBase {
  kind: "sticker";
  /** Host media asset holding the sticker image (PNG/JPG/SVG, or a Lottie
   * JSON document when `lottie` is set). */
  assetId?: string;
  w: number; // width, fraction of frame width
  /** The asset is a Lottie animation; it plays on a loop for the element's
   * whole duration, frame-seeked from timeline time. */
  lottie?: boolean;
}

export type Overlay = TextOverlay | ShapeOverlay | StickerOverlay | EffectOverlay;

export type OverlayKind = "text" | "shape" | "sticker" | "effect";

/** A patch that may touch any kind's fields (never the discriminant). */
export type OverlayPatch = Partial<
  Omit<TextOverlay, "kind"> &
    Omit<ShapeOverlay, "kind"> &
    Omit<StickerOverlay, "kind"> &
    Omit<EffectOverlay, "kind">
>;

export function overlayKind(o: Overlay): OverlayKind {
  return o.kind ?? "text";
}

export function isTextOverlay(o: Overlay): o is TextOverlay {
  return (o.kind ?? "text") === "text";
}

export function isShapeOverlay(o: Overlay): o is ShapeOverlay {
  return o.kind === "shape";
}

export function isStickerOverlay(o: Overlay): o is StickerOverlay {
  return o.kind === "sticker";
}

export function isEffectOverlay(o: Overlay): o is EffectOverlay {
  return o.kind === "effect";
}

/** Tolerant-load stamp: overlays saved before the union carry no `kind`;
 * stamping `"text"` on load gives every in-memory element a discriminant. */
export function stampOverlayKinds<T extends Overlay>(overlays: T[]): T[] {
  return overlays.map((o) => (o.kind ? o : { ...o, kind: "text" as const }));
}

/** Serialize counterpart: drop the `kind` a text element only carries because
 * the loader stamped it, so title-only documents write byte-identical to the
 * pre-union shape. */
export function stripDefaultOverlayKinds<T extends Overlay>(overlays: T[]): T[] {
  // Same array back when there is nothing to strip: hosts compare documents by
  // identity to tell an edit from a re-read, so a projection that always
  // allocates would read as a change every time.
  if (!overlays.some((o) => o.kind === "text")) return overlays;
  return overlays.map((o) => {
    if (o.kind !== "text") return o;
    const rest = { ...o };
    delete rest.kind;
    return rest;
  });
}

/**
 * A group renamer for one copying operation — a paste, a template applied.
 * Members copied together land in one new group; the copies never join the
 * group they were taken from, which is what keeps a pasted pair from welding
 * itself to the pair it came from. Returns a patch to spread over each copy,
 * empty for an ungrouped element. The host supplies `newId` so id format
 * stays its business.
 */
export function groupRemap(newId: () => string): (o: Overlay) => { groupId?: string } {
  const seen = new Map<string, string>();
  return (o) => {
    if (!o.groupId) return {};
    let next = seen.get(o.groupId);
    if (!next) {
      next = newId();
      seen.set(o.groupId, next);
    }
    return { groupId: next };
  };
}

/** What a title's look is made of, apart from its words, timing and place:
 * the one list, which both the type and the reader below derive from. A new
 * style field is added here and nowhere else. */
export const TEXT_STYLE_FIELDS = [
  "size",
  "font",
  "weight",
  "italic",
  "color",
  "stroke",
  "letterSpacing",
  "lineHeight",
  "align",
  "shadow",
  "plate",
  "plateColor",
  "plateOpacity",
  "plateRadius",
] as const;

/** A saved look, and what one title copies from another. */
export type TextStyle = Pick<TextOverlay, (typeof TEXT_STYLE_FIELDS)[number]>;

/** Read a text element's style, leaving everything that makes it that
 * particular title behind. */
export function pickTextStyle(o: TextOverlay): TextStyle {
  const style: Record<string, unknown> = {};
  for (const field of TEXT_STYLE_FIELDS) style[field] = o[field];
  return style as TextStyle;
}
