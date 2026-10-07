/**
 * The camera card: the talking-head video's split layout as one clip
 * property, in any frame shape.
 *
 * A graphic fills the frame on a lower track. Over it, the speaker's clip
 * shows through a rounded card that bleeds off the frame: across the bottom
 * of a portrait frame, or up one side of a square or landscape frame, where
 * a full-width card would leave the graphic a strip. Above the card's top
 * edge the same footage shows again, keyed by the clip's person matte, so the
 * head breaks out of the card. Both parts are drawn from one decoded frame,
 * so the head and the card can never drift apart.
 *
 * This module is the geometry alone: which side the card takes, and where
 * the card, the footage and the pop-out band land inside the clip's box, in
 * canvas pixels. Every default comes from the box's shape and the source's
 * aspect. The compositor draws from it, the export's piece renderer draws
 * through the compositor, and the Inspector and the chat tool read the same
 * defaults and ranges.
 */

import type { ClipRemoval } from "@donkeycut/effects-kit";

/** Where the card sits: across the bottom, or up the left or right side. */
export type CardSide = "bottom" | "left" | "right";
export const CARD_SIDES = ["bottom", "left", "right"] as const satisfies readonly CardSide[];

export interface CameraCard {
  /** The card's side. Absent: from the box shape, the bottom of a portrait
   * box and the right side of a square or landscape one. */
  side?: CardSide;
  /** The card's top edge, as a fraction of the clip's box height from the
   * box top. Absent: from the side, the box shape and the source aspect. */
  top?: number;
  /** A side card's width in view, as a fraction of the box width. Absent:
   * from the box shape. A bottom card spans the box. */
  width?: number;
  /** Top corner radius, design px at the 1080 short side. */
  radius: number;
  /** How far the card reaches past the frame edges it bleeds off, design
   * px: both sides of a bottom card, the outer side of a side card. */
  sideBleed: number;
  /** The speaker's head shows above the card, keyed by the person matte. */
  popOut: boolean;
  /** How far below the card's top edge the pop-out fades out, design px.
   * It softens the shoulders where the card's corners curve away. */
  feather: number;
  /** Opacity of the soft shadow the card casts, 0..1; 0 casts none. */
  shadow: number;
  /** Footage size over the default placement; absent = 1. */
  scale?: number;
  /** Footage shift, as fractions of the box width and height; absent = 0. */
  offsetX?: number;
  offsetY?: number;
  /** The baked person matte the pop-out reads: the same free on-device
   * matte an auto cutout bakes, with the same shape. */
  matte?: ClipRemoval["matte"];
}

/** The reference look: at 1080×1920 a bottom card 1210×864 at x −65, y 1200,
 * top corners 200, a 40px fade under the card edge. */
export const CARD_DEFAULTS = {
  radius: 200,
  sideBleed: 65,
  popOut: true,
  feather: 40,
  shadow: 0.45,
} as const satisfies Omit<CameraCard, "side" | "top" | "width" | "scale" | "offsetX" | "offsetY" | "matte">;

export const CARD_TOP_MIN = 0.2;
export const CARD_TOP_MAX = 0.9;
export const CARD_WIDTH_MIN = 0.2;
export const CARD_WIDTH_MAX = 0.7;
export const CARD_RADIUS_MAX = 400;
export const CARD_BLEED_MAX = 300;
export const CARD_FEATHER_MAX = 120;
export const CARD_SCALE_MIN = 0.5;
export const CARD_SCALE_MAX = 3;
export const CARD_OFFSET_MAX = 1;
/** The shadow's blur, design px. */
const CARD_SHADOW_BLUR = 60;

/** Boxes at least this wide for their height take a side card. */
const SIDE_ASPECT = 0.999;
/** The default top of a bottom card and of a side card, before the source
 * asks for more headroom. */
const BOTTOM_TOP = 0.625;
const SIDE_TOP = 0.45;
/** A side card's default width: two fifths of a square box, a third of a
 * 21:9 one, on a log scale of the box aspect between and past them. */
const WIDTH_SQUARE = 0.4;
const WIDTH_WIDE = 1 / 3;
const WIDE_ASPECT = 21 / 9;
/** How much of the picture sits above the card's top edge by default, for a
 * landscape source and for a portrait one. A 16:9 talking head fills the
 * frame's height with the speaker, so the top of the head breaks the card;
 * a phone-held portrait take carries the head higher up a taller picture,
 * so more of it has to clear the card. Between the two, it follows the
 * source aspect on a log scale. */
const ABOVE_LANDSCAPE = 0.18;
const ABOVE_PORTRAIT = 0.42;
const LANDSCAPE_ASPECT = 16 / 9;
const PORTRAIT_ASPECT = 9 / 16;
/** How much picture sits below the card's top edge, as a multiple of the
 * card's visible height: the rest hangs off the bottom of the box. */
const BELOW_RATIO = 1.21;
/** The widest the footage gets by default, in card widths in view, while it
 * still reaches the box bottom: a narrow side card keeps the speaker at a
 * size that fits it. */
const SPAN_MAX = 2.6;
/** The corner curve: it starts this many radii from the corner, and its
 * handles sit this share of that reach from the corner. The result is
 * tighter at the apex than a circle of the same reach, and it eases into
 * the straight edges. */
const CORNER_REACH = 1.3;
const CORNER_HANDLE = 0.32;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CardLayout {
  /** The side the card took. */
  side: CardSide;
  /** The card. Only the top corners round; the bottom sits past the box. */
  card: Box;
  /** The top corners' radius, px. */
  radius: number;
  /** Where the footage draws, px. */
  picture: Box;
  /** The pop-out band over the card's columns inside the box: solid from
   * the box top down to `edge` (the card's top), fading to nothing at
   * `bottom`. */
  band: { top: number; edge: number; bottom: number; left: number; right: number };
  /** The shadow's blur, px. */
  shadowBlur: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isSide = (v: unknown): v is CardSide => CARD_SIDES.includes(v as CardSide);

/** The card with every field in range, and the fields that hold their
 * default left out. */
export function normalizeCard(c: CameraCard): CameraCard {
  const or = (v: number | undefined, d: number) => (finite(v) ? v : d);
  const scale = clamp(or(c.scale, 1), CARD_SCALE_MIN, CARD_SCALE_MAX);
  const offsetX = clamp(or(c.offsetX, 0), -CARD_OFFSET_MAX, CARD_OFFSET_MAX);
  const offsetY = clamp(or(c.offsetY, 0), -CARD_OFFSET_MAX, CARD_OFFSET_MAX);
  return {
    ...c,
    side: isSide(c.side) ? c.side : undefined,
    top: finite(c.top) ? clamp(c.top, CARD_TOP_MIN, CARD_TOP_MAX) : undefined,
    width: finite(c.width) ? clamp(c.width, CARD_WIDTH_MIN, CARD_WIDTH_MAX) : undefined,
    radius: clamp(or(c.radius, CARD_DEFAULTS.radius), 0, CARD_RADIUS_MAX),
    sideBleed: clamp(or(c.sideBleed, CARD_DEFAULTS.sideBleed), 0, CARD_BLEED_MAX),
    popOut: !!c.popOut,
    feather: clamp(or(c.feather, CARD_DEFAULTS.feather), 0, CARD_FEATHER_MAX),
    shadow: clamp(or(c.shadow, CARD_DEFAULTS.shadow), 0, 1),
    scale: Math.abs(scale - 1) > 1e-4 ? scale : undefined,
    offsetX: offsetX !== 0 ? offsetX : undefined,
    offsetY: offsetY !== 0 ? offsetY : undefined,
  };
}

/** The share of the picture's height above the card's top edge, from the
 * source aspect (width / height). */
export function aboveShare(aspect: number): number {
  if (!(aspect > 0)) return ABOVE_LANDSCAPE;
  const span = Math.log(LANDSCAPE_ASPECT) - Math.log(PORTRAIT_ASPECT);
  const t = clamp((Math.log(LANDSCAPE_ASPECT) - Math.log(aspect)) / span, 0, 1);
  return ABOVE_LANDSCAPE + (ABOVE_PORTRAIT - ABOVE_LANDSCAPE) * t;
}

/** The side a card takes in a box of `boxAspect` (width / height) when it
 * names none. */
const defaultCardSide = (boxAspect: number): CardSide => (boxAspect >= SIDE_ASPECT ? "right" : "bottom");

/** A side card's default width share in a box of `boxAspect`. */
export function defaultCardWidth(boxAspect: number): number {
  const a = boxAspect > 0 ? boxAspect : 1;
  const t = clamp(Math.log(a) / Math.log(WIDE_ASPECT), -2, 1);
  return clamp(WIDTH_SQUARE + (WIDTH_WIDE - WIDTH_SQUARE) * t, CARD_WIDTH_MIN, CARD_WIDTH_MAX);
}

/** The default footage height for a card whose top edge sits `vis` px above
 * the box bottom and shows `visW` px wide: the part below the edge fills the
 * card past the box bottom, capped so a narrow card keeps the speaker at a
 * size that fits it, and never narrower than the card. */
function footageHeight(a: number, k: number, vis: number, visW: number): number {
  const reach = Math.max(1, vis) / (1 - k);
  let h = BELOW_RATIO * reach;
  if (h * a > SPAN_MAX * visW) h = Math.max(reach, (SPAN_MAX * visW) / a);
  if (h * a < visW) h = visW / a;
  return h;
}

/** The card's width in view inside a box `w` wide. */
const viewWidth = (side: CardSide, share: number, w: number) => (side === "bottom" ? w : share * w);

/**
 * The card's resolved side, top and width share for a box of `boxW`×`boxH`
 * and a source of `srcW`×`srcH`: what the card names, and the shape's
 * defaults for the rest. A default top sits lower when the source needs the
 * headroom, so the top of the picture stays inside the box.
 */
export function resolveCardShape(
  card: Pick<CameraCard, "side" | "top" | "width">,
  boxW: number,
  boxH: number,
  srcW: number,
  srcH: number
): { side: CardSide; top: number; width: number } {
  const boxAspect = boxW > 0 && boxH > 0 ? boxW / boxH : PORTRAIT_ASPECT;
  const side = isSide(card.side) ? card.side : defaultCardSide(boxAspect);
  const width = finite(card.width) ? clamp(card.width, CARD_WIDTH_MIN, CARD_WIDTH_MAX) : defaultCardWidth(boxAspect);
  if (finite(card.top)) return { side, top: clamp(card.top, CARD_TOP_MIN, CARD_TOP_MAX), width };
  const a = srcW > 0 && srcH > 0 ? srcW / srcH : LANDSCAPE_ASPECT;
  const k = aboveShare(a);
  const H = boxH > 0 ? boxH : 1;
  const visW = viewWidth(side, width, boxW > 0 ? boxW : 1);
  // Room left above the picture with the card's top at `top`. It only grows
  // as the card moves down, so the first top with room is found by halving.
  const room = (top: number) => top * H - k * footageHeight(a, k, (1 - top) * H, visW);
  let lo: number = side === "bottom" ? BOTTOM_TOP : SIDE_TOP;
  if (room(lo) >= 0) return { side, top: lo, width };
  let hi = CARD_TOP_MAX;
  if (room(hi) < 0) return { side, top: hi, width };
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (room(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return { side, top: hi, width };
}

/**
 * The whole layout inside `box` (canvas px) for a source of `srcW`×`srcH`,
 * with `ds` canvas px per design px. The footage centers on the card's part
 * in view and scales about the point where the card's top edge crosses that
 * center line, so the same share of the speaker stays above the card at any
 * size; the offset then shifts it.
 */
export function cameraCardLayout(
  card: CameraCard,
  box: Box,
  srcW: number,
  srcH: number,
  ds: number
): CardLayout {
  const c = normalizeCard(card);
  const shape = resolveCardShape(c, box.w, box.h, srcW, srcH);
  const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : LANDSCAPE_ASPECT;
  const shadowBlur = c.shadow > 0 ? CARD_SHADOW_BLUR * ds : 0;
  const top = box.y + shape.top * box.h;
  const bottom = box.y + box.h;
  const bleed = c.sideBleed * ds;
  const visW = viewWidth(shape.side, shape.width, box.w);
  const right = shape.side === "right";
  const cardBox = {
    x: right ? box.x + box.w - visW : box.x - bleed,
    y: top,
    w: shape.side === "bottom" ? box.w + 2 * bleed : visW + bleed,
    // Past the box bottom by the shadow's reach and a margin, so neither
    // the card's bottom edge nor its shadow ever shows.
    h: bottom - top + 2 * shadowBlur + 24 * ds,
  };
  const radius = Math.min(c.radius * ds, cardBox.w / 2, cardBox.h);
  const k = aboveShare(aspect);
  const h = footageHeight(aspect, k, bottom - top, visW) * (c.scale ?? 1);
  const w = h * aspect;
  const cx = shape.side === "bottom" ? box.x + box.w / 2 : right ? box.x + box.w - visW / 2 : box.x + visW / 2;
  const picture = {
    x: cx - w / 2 + (c.offsetX ?? 0) * box.w,
    y: top - k * h + (c.offsetY ?? 0) * box.h,
    w,
    h,
  };
  return {
    side: shape.side,
    card: cardBox,
    radius,
    picture,
    band: {
      top: box.y,
      edge: top,
      bottom: Math.min(bottom, top + c.feather * ds),
      left: Math.max(box.x, cardBox.x),
      right: Math.min(box.x + box.w, cardBox.x + cardBox.w),
    },
    shadowBlur,
  };
}

/** The path calls a card outline needs: a canvas context, or a recorder in
 * a test. */
export interface PathSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  closePath(): void;
}

/** Trace the card's outline: eased top corners, square bottom corners.
 * Path commands only, so drawing it allocates nothing. */
export function traceCardPath(p: PathSink, card: Box, radius: number): void {
  const { x, y, w, h } = card;
  const e = Math.max(0, Math.min(radius * CORNER_REACH, w / 2, h));
  const d = e * CORNER_HANDLE;
  p.moveTo(x, y + h);
  p.lineTo(x, y + e);
  p.bezierCurveTo(x, y + d, x + d, y, x + e, y);
  p.lineTo(x + w - e, y);
  p.bezierCurveTo(x + w - d, y, x + w, y + d, x + w, y + e);
  p.lineTo(x + w, y + h);
  p.closePath();
}

/** The card a fresh layout starts from: side, top and width follow the
 * frame shape and the source. */
export function newCard(): CameraCard {
  return { ...CARD_DEFAULTS };
}

/** The key a card's matte job and staged matte frame go under, beside the
 * clip's own cutout under its bare id. */
export const cardMatteKey = (clipId: string): string => `card:${clipId}`;
