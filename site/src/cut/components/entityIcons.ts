import { createElement, type ReactNode } from "react";
import {
  Captions,
  Circle,
  Diamond,
  Heart,
  Hexagon,
  Minus,
  MoveRight,
  Sparkles,
  Square,
  Star,
  Sticker,
  Triangle,
  Type,
  UnfoldHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { AssetRef } from "@/cut/lib/assetRef";
import type { ShapeKind } from "@/cut/lib/types";

/** The glyph a shape wears on its timeline chip and mention pill. */
export const SHAPE_CHIP_ICONS: Record<ShapeKind, LucideIcon> = {
  rect: Square,
  ellipse: Circle,
  triangle: Triangle,
  diamond: Diamond,
  star: Star,
  heart: Heart,
  hexagon: Hexagon,
  line: Minus,
  arrow: MoveRight,
};

/** The entity's icon as a rendered element, sized by `className`. Null for
 * media refs — those show the media itself. */
export function entityGlyph(ref: AssetRef, className: string): ReactNode {
  const icon = entityIcon(ref);
  return icon ? createElement(icon, { className }) : null;
}

/** The icon an entity ref's pill and chip lead with. Null for media refs —
 * those show the media itself. */
export function entityIcon(ref: AssetRef): LucideIcon | null {
  switch (ref.entityKind) {
    case "title":
      return Type;
    case "shape":
      return SHAPE_CHIP_ICONS[ref.shapeKind ?? "rect"];
    case "sticker":
      return Sticker;
    case "effect":
      return Sparkles;
    case "transition":
      return UnfoldHorizontal;
    case "cue":
      return Captions;
    case "keyframe":
      return Diamond;
    default:
      return null;
  }
}
