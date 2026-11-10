import type { Mask, MaskKind, ShapeKind } from "@donkeycut/effects-kit";
import type { AssetType, FrameRect, MediaAsset, Overlay, Selection } from "./types";

/**
 * Replacing a timeline item's media. A clip keeps its slot and plays the new
 * source from an in-point; a box shape, or a sticker given a video, becomes a
 * clip framed to the element's box, its outline carried over as a mask.
 */

/** What a replaced item can play. A box element takes footage by becoming a
 * clip, so it takes what a clip takes. */
export type ReplaceTarget = { kind: "clip" | "audio" | "overlay"; id: string };

/** Shapes whose outline masks a picture. A line, an arrow and a doodle are
 * strokes with no box to fill. */
const MASK_OF_SHAPE: Partial<Record<ShapeKind, MaskKind>> = {
  rect: "rect",
  ellipse: "circle",
  triangle: "triangle",
  diamond: "diamond",
  star: "star",
  heart: "heart",
  hexagon: "hexagon",
};

/** Whether an element can take media in its place. */
export function overlayTakesMedia(o: Overlay): boolean {
  if (o.kind === "sticker") {
    return true;
  }
  return o.kind === "shape" && MASK_OF_SHAPE[o.shape] !== undefined;
}

/** The asset types an item takes as its replacement: a picture item takes
 * footage or a still; a soundtrack clip takes sound, a video's included, the
 * way a detached clip plays its video's sound. */
export function replaceTypes(kind: ReplaceTarget["kind"]): AssetType[] {
  return kind === "audio" ? ["audio", "video"] : ["video", "image"];
}

/** Where a source starts so `len` seconds of it fit: the asked second, held
 * inside the source. A 10 s source filling a 3 s slot starts at most at 7 s. */
export function replaceInPoint(duration: number, len: number, from?: number): number {
  if (from === undefined || !Number.isFinite(from)) {
    return 0;
  }
  return Math.max(0, Math.min(from, duration - len));
}

/** The region and mask a clip takes over from the element it replaces, or
 * null when the element has no box to fill. Element boxes are centered and
 * clip regions are anchored top-left, both in frame fractions. A sticker with
 * no stored height draws at its image's aspect, so its box does too. */
export function overlayClipBox(
  o: Overlay,
  sticker: MediaAsset | undefined,
  frame: { w: number; h: number }
): { frame: FrameRect; mask?: Mask } | null {
  if (!overlayTakesMedia(o)) {
    return null;
  }

  // The box in frame fractions.
  if (o.kind === "sticker") {
    const aspect = sticker?.width && sticker.height ? sticker.width / sticker.height : 1;
    const h = o.h ?? (o.w * frame.w) / aspect / frame.h;
    return { frame: { x: o.x - o.w / 2, y: o.y - h / 2, w: o.w, h } };
  }
  if (o.kind !== "shape") {
    return null;
  }
  const box = { x: o.x - o.w / 2, y: o.y - o.h / 2, w: o.w, h: o.h };

  // The outline as a mask. A square-cornered rect is the region itself.
  const kind = MASK_OF_SHAPE[o.shape]!;
  if (kind === "rect" && !o.radius) {
    return { frame: box };
  }
  return {
    frame: box,
    mask: { kind, w: o.w, h: o.h, ...(kind === "rect" ? { radius: o.radius } : {}) },
  };
}

/** A source this close to a span's length fills it whole: no other part to
 * choose. */
export const FITS_SLACK_S = 0.05;

/** Whether a clip's file runs longer than the part the clip plays, so another
 * part of it can be chosen: Adjust slides the clip along its own file. A
 * still, and an empty shot's block, have no other part. */
export function canAdjust(asset: MediaAsset, clip: { in: number; out: number }): boolean {
  if (asset.type !== "video" && asset.type !== "audio") {
    return false;
  }
  if (asset.block) {
    return false;
  }
  return asset.duration > clip.out - clip.in + FITS_SLACK_S;
}

/** The item a paste would replace: the one timeline item selected, when it
 * takes media — a clip, a soundtrack clip, a sticker or a box shape. Several
 * selected, or anything else, and a paste places as it always has. */
export function selectedTarget(s: {
  selection: Selection;
  multiSelection: Selection[];
  overlays: Overlay[];
}): ReplaceTarget | null {
  const sel = s.selection;
  if (!sel || s.multiSelection.length > 1) {
    return null;
  }
  if (sel.kind === "clip" || sel.kind === "audio") {
    return { kind: sel.kind, id: sel.id };
  }
  if (sel.kind !== "overlay") {
    return null;
  }
  const o = s.overlays.find((x) => x.id === sel.id);
  return o && overlayTakesMedia(o) ? { kind: "overlay", id: o.id } : null;
}

/** Whether media of `type` can go in the item. */
export const targetTakes = (target: ReplaceTarget, type: AssetType | null | undefined): boolean =>
  !!type && replaceTypes(target.kind).includes(type);
