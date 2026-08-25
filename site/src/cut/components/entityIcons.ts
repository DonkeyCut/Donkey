import { createElement, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftToLine,
  ArrowRight,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpToLine,
  AudioLines,
  Blend,
  Captions,
  Circle,
  Diamond,
  Droplets,
  Expand,
  FoldHorizontal,
  Heart,
  Hexagon,
  Layers,
  Minus,
  Moon,
  MoveRight,
  Sparkles,
  Square,
  Star,
  Sticker,
  Sun,
  Target,
  Triangle,
  Type,
  UnfoldHorizontal,
  type LucideIcon,
} from "lucide-react";
import { isAudioEffect, type EffectId } from "@donkeycut/effects-kit";
import type { AssetRef } from "@/cut/lib/assetRef";
import type { ShapeKind, TransitionStyle } from "@/cut/lib/types";

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

/** The glyph a transition wears on its bar and on its mention pill. */
export const TRANSITION_ICONS: Record<TransitionStyle, LucideIcon> = {
  crossfade: Blend,
  audiocross: AudioLines,
  crosszoom: Expand,
  dipblack: Moon,
  dipwhite: Sun,
  blur: Droplets,
  pushleft: ArrowLeft,
  pushright: ArrowRight,
  pushup: ArrowUp,
  pushdown: ArrowDown,
  wipeleft: ArrowLeftToLine,
  wiperight: ArrowRightToLine,
  wipeup: ArrowUpToLine,
  wipedown: ArrowDownToLine,
  circleopen: Circle,
  circleclose: Target,
  splitopen: UnfoldHorizontal,
  splitclose: FoldHorizontal,
};

/** The glyph an effect wears on its bar and on its mention pill: a waveform
 * for the treatments that work on the sound, sparkles for the ones that work
 * on the picture. */
export const EFFECT_CHIP_ICONS = { sound: AudioLines, picture: Sparkles } as const;

/** Which of the two an effect takes. */
export const effectIconKind = (effect: EffectId | undefined): "sound" | "picture" =>
  effect && isAudioEffect(effect) ? "sound" : "picture";

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
      return EFFECT_CHIP_ICONS[effectIconKind(ref.effectId)];
    case "transition":
      return TRANSITION_ICONS[ref.transitionStyle ?? "crossfade"];
    case "cue":
      return Captions;
    case "keyframe":
      return Diamond;
    case "template":
      return Layers;
    default:
      return null;
  }
}
