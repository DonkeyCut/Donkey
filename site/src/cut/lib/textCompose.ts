import { textRoom, wrapTextToRoom } from "@donkeycut/effects-kit";
import type { OverlayAnim, OverlayAnimStyle } from "@donkeycut/effects-kit";
import { measureLine, textFontOf } from "./textFit";
import type { TextLook } from "./textLooks";
import type { TextMoveId } from "./textMotion";
import type { FontId } from "./types";

/**
 * How a run of text is composed across the frame and across its own length.
 *
 * A look says what one line looks like. This says what a hundred of them look
 * like together: where each lands, which face carries it, how it arrives, and
 * which lines are the loud ones. Without it every line of a lyric video comes
 * out identical and dead center, and the only way to vary anything is to edit
 * each element afterwards one call at a time.
 *
 * Everything here is deterministic — index in, pose out — so the same run
 * composes the same way twice, and index 0 always reproduces the look's own
 * settings exactly.
 */

/** How loud a line is. The model decides this per line from the meaning of
 * the words; nothing here reads the text to guess. */
export type TextEmphasis = "whisper" | "normal" | "hero";

/** How far the run departs from a single repeated design.
 * - `none`: every line identical — the look, nothing else.
 * - `subtle`: lines move around the frame and change entrance; one typeface.
 * - `bold`: the look's whole ensemble — faces, tilts, palette, hero accents. */
export type TextVariation = "none" | "subtle" | "bold";

/** Where successive lines land relative to the look's own anchor. */
export type TextLayout =
  | "center"
  | "stack"
  | "alternate"
  | "corners"
  | "drift"
  | "scatter"
  | "ladder";

export const TEXT_LAYOUT_IDS: TextLayout[] = [
  "center",
  "stack",
  "alternate",
  "corners",
  "drift",
  "scatter",
  "ladder",
];

export const TEXT_VARIATION_IDS: TextVariation[] = ["none", "subtle", "bold"];
export const TEXT_EMPHASIS_IDS: TextEmphasis[] = ["whisper", "normal", "hero"];

/** One-line descriptions, so the tool schema and the skill teach the same
 * thing the composer does. */
export const TEXT_LAYOUT_NOTES: Record<TextLayout, string> = {
  center: "Every line on the look's anchor. Still, formal, karaoke.",
  stack: "Lines step up and down the middle column, so a phrase builds vertically.",
  alternate: "Lines swing left and right of center — call and response.",
  corners: "Lines walk the four corners of the safe area. Busy, poster-like.",
  drift: "A slow diagonal walk across the frame and back. Ballads, long holds.",
  scatter: "A fixed scatter around the frame that never lands twice in a row. Chaotic energy.",
  ladder: "Each line one rung lower than the last, then back to the top. Lists, countdowns, verses.",
};

/** The offsets a layout walks, in frame fractions from the look's anchor.
 * Entry 0 is always zero: a single line, and the first line of any run, sits
 * exactly where the look put it. */
const LAYOUT_STEPS: Record<TextLayout, { dx: number; dy: number }[]> = {
  center: [{ dx: 0, dy: 0 }],
  stack: [
    { dx: 0, dy: 0 },
    { dx: 0, dy: -0.19 },
    { dx: 0, dy: 0.19 },
    { dx: 0, dy: -0.1 },
    { dx: 0, dy: 0.1 },
  ],
  alternate: [
    { dx: 0, dy: 0 },
    { dx: -0.17, dy: -0.12 },
    { dx: 0.17, dy: 0.12 },
    { dx: -0.15, dy: 0.1 },
    { dx: 0.15, dy: -0.1 },
  ],
  corners: [
    { dx: 0, dy: 0 },
    { dx: -0.21, dy: -0.17 },
    { dx: 0.21, dy: -0.17 },
    { dx: 0.21, dy: 0.17 },
    { dx: -0.21, dy: 0.17 },
  ],
  drift: [
    { dx: 0, dy: 0 },
    { dx: 0.07, dy: 0.07 },
    { dx: 0.14, dy: 0.14 },
    { dx: 0.07, dy: 0.2 },
    { dx: -0.07, dy: 0.14 },
    { dx: -0.14, dy: 0.05 },
    { dx: -0.08, dy: -0.06 },
  ],
  scatter: [
    { dx: 0, dy: 0 },
    { dx: 0.2, dy: -0.15 },
    { dx: -0.18, dy: 0.14 },
    { dx: 0.13, dy: 0.19 },
    { dx: -0.21, dy: -0.12 },
    { dx: 0.05, dy: -0.2 },
    { dx: -0.09, dy: 0.21 },
    { dx: 0.22, dy: 0.04 },
  ],
  ladder: [
    { dx: 0, dy: 0 },
    { dx: 0.05, dy: 0.11 },
    { dx: 0.1, dy: 0.22 },
    { dx: -0.05, dy: -0.11 },
    { dx: -0.1, dy: -0.22 },
  ],
};

/** Tilts a bold run walks. Entry 0 is upright, so the first line never leans. */
const TILTS = [0, -6, 5, -4, 7, -3, 6, -7, 4, -5];

/** How much bigger or smaller than the look's size each emphasis runs. */
const EMPHASIS_SCALE: Record<TextEmphasis, number> = {
  whisper: 0.68,
  normal: 1,
  hero: 1.34,
};

/** One face in a look's ensemble. */
export interface TextFace {
  font: FontId;
  weight: 400 | 700;
  /** Size multiplier against the look's own size — a condensed face carries a
   * bigger number than a wide one at the same optical weight. */
  scale?: number;
  italic?: boolean;
}

/** The rotas a look walks when a run asks for variation. Entry 0 of every
 * rota is the look's own setting, so a one-line run and the first line of a
 * long one are exactly what the look describes. */
export interface TextEnsemble {
  faces: TextFace[];
  /** Entrances, walked one per line. */
  motion: OverlayAnimStyle[];
  layout: TextLayout;
  /** Moves the run walks while each line HOLDS — see textMotion.ts.
   * Entrances say how a line arrives; these say what it does after. */
  moves: TextMoveId[];
  /** The move a hero line takes regardless of where the rota is. */
  heroMove?: TextMoveId;
  /** Line colors for a run with no cards behind it. */
  palette?: string[];
}

export interface ComposeLine {
  text: string;
  start: number;
  end: number;
  color?: string;
  size?: number;
  emphasis?: TextEmphasis;
  /** Verse, chorus, bridge — any label. Lines sharing a label compose as one
   * passage, and each new label starts the type and palette rotas somewhere
   * else, so a chorus does not look like the verse before it. */
  section?: string;
  font?: FontId;
  x?: number;
  y?: number;
  rotation?: number;
  inStyle?: OverlayAnimStyle;
  /** A named move for this line, overriding the look's rota. */
  move?: TextMoveId;
}

export interface ComposedLine {
  text: string;
  start: number;
  end: number;
  x: number;
  y: number;
  rotation: number;
  font: FontId;
  weight: 400 | 700;
  italic: boolean;
  size: number;
  color: string;
  anim: OverlayAnim;
  move: TextMoveId | string;
  /** Which of the look's cards sits behind this line. */
  cardIndex: number;
}

const clampPos = (v: number) => Math.min(0.9, Math.max(0.1, v));
const round2 = (n: number) => Math.round(n * 100) / 100;
const step = <T,>(arr: readonly T[], n: number): T => arr[((n % arr.length) + arr.length) % arr.length];

/** Comparison form of a line: letters and digits only. Two lines that read
 * the same are the same hook however they are punctuated. */
const normText = (t: string): string =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");

/**
 * A line broken and sized to the room it actually has.
 *
 * The look's size is a ceiling written for a wide frame at center; a vertical
 * cut, a long line, a wider face, or a line placed off to one side all get
 * breaks at word boundaries first and a smaller size only when breaking is not
 * enough. Every width here is measured on the face the line will be drawn in,
 * through the same seam the painter and the preview measure with, so a run
 * lands where the frame says it lands.
 */
export function fitLineToFrame(
  text: string,
  frame: { w: number; h: number },
  size: number,
  opts: {
    font: FontId;
    weight: 400 | 700;
    italic?: boolean;
    lineHeight?: number;
    x?: number;
    maxLines?: number;
  }
): { text: string; size: number } {
  if (text.includes("\n")) return { text, size }; // the caller broke it themselves
  const room = textRoom(opts.x ?? 0.5, frame.w);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || !(room > 0)) return { text, size };
  const maxLines = opts.maxLines ?? 3;
  const lineH = opts.lineHeight ?? 1.25;
  const widthAt = (line: string, px: number) =>
    measureLine(line, textFontOf({ font: opts.font, weight: opts.weight, italic: opts.italic }, px), px);

  const layout = (px: number) => wrapTextToRoom(text, room, (line) => widthAt(line, px)).split("\n");
  let lines = layout(size);
  let fitted = size;
  // A single word wider than the room is the one break that cannot help, so
  // the size comes down until it fits.
  const widest = Math.max(...lines.map((l) => widthAt(l, size)), 1);
  if (widest > room) fitted = Math.floor((size * room) / widest);
  // Too many lines is a design failure the same way overflow is: the run
  // shrinks until the stack is the height the look asked for.
  if (lines.length > maxLines) fitted = Math.min(fitted, Math.floor(size * (maxLines / lines.length)));
  if (fitted < size) lines = layout(Math.max(16, fitted));
  const tall = lines.length * fitted * lineH;
  if (tall > frame.h * 0.8) fitted = Math.floor((frame.h * 0.8) / (lines.length * lineH));
  const px = Math.max(16, Math.min(size, fitted));
  return { text: layout(px).join("\n"), size: px };
}

/**
 * Compose a run: every line's place in the frame, its face, its size, its
 * tilt and how it arrives.
 *
 * The rotas are walked by index, so the design moves whether or not the
 * caller said anything about a given line, and any field the caller did name
 * wins outright.
 */
export function composeTextRun(
  lines: ComposeLine[],
  look: TextLook,
  opts: {
    variation: TextVariation;
    layout?: TextLayout;
    frame: { w: number; h: number };
    /** The color cards the run is cycling; empty = the words sit on the
     * frame and the palette is free to carry them. */
    cards: string[];
  }
): ComposedLine[] {
  const { variation, frame } = opts;
  const cardCount = opts.cards.length;
  const onCards = look.text.onCards ?? [];
  const ens = look.ensemble;
  const layout = opts.layout ?? (variation === "none" ? "center" : ens?.layout ?? "center");
  const steps = LAYOUT_STEPS[layout] ?? LAYOUT_STEPS.center;
  const faces: TextFace[] =
    variation === "bold" && ens?.faces.length
      ? ens.faces
      : [{ font: look.text.font, weight: look.text.weight, italic: look.text.italic }];
  const motions: OverlayAnimStyle[] =
    variation === "none" || !ens?.motion.length
      ? [look.motion.in?.style ?? "fade"]
      : ens.motion;
  const moves: TextMoveId[] =
    variation === "none" || !ens?.moves.length ? ["none"] : ens.moves;
  const palette =
    variation === "bold" && cardCount === 0 && ens?.palette?.length
      ? [look.text.color, ...ens.palette]
      : [look.text.color];

  // Sections in the order they first appear, so the rotas can start a new
  // passage somewhere the last one did not sit.
  const sectionOrder: string[] = [];
  for (const l of lines) {
    const s = l.section;
    if (s && !sectionOrder.includes(s)) sectionOrder.push(s);
  }

  const seen = new Map<string, number>();

  return lines.map((line, i) => {
    const sec = line.section ? sectionOrder.indexOf(line.section) : 0;
    const emphasis = line.emphasis ?? "normal";

    // A hook that comes round again steps up rather than repeating flat.
    const key = normText(line.text);
    const repeats = key ? seen.get(key) ?? 0 : 0;
    if (key) seen.set(key, repeats + 1);
    const repeatBoost = variation === "none" ? 1 : 1 + Math.min(repeats, 3) * 0.09;

    const place = variation === "none" ? { dx: 0, dy: 0 } : step(steps, i);
    const x = line.x ?? clampPos(look.text.x + place.dx);
    const y = line.y ?? clampPos(look.text.y + place.dy);

    // Faces change per phrase pair; a new face every single line reads as
    // noise even in a ransom-note look.
    const face = step(faces, Math.floor(i / 2) + sec);
    const font = line.font ?? face.font;
    const tilt = line.rotation ?? (variation === "bold" ? step(TILTS, i + sec) : 0);

    const base = (line.size ?? look.text.size) * (line.size ? 1 : face.scale ?? 1);
    const wanted = Math.round(base * EMPHASIS_SCALE[emphasis] * repeatBoost);
    // Measured on the face this line is actually carried by, so a line that
    // takes the ensemble's wider typeface breaks where that face runs out of
    // room.
    const fit = fitLineToFrame(line.text, frame, wanted, {
      font,
      weight: face.weight,
      italic: face.italic ?? false,
      lineHeight: look.text.lineHeight,
      x,
    });

    const inStyle = line.inStyle ?? step(motions, i + sec);
    const inSeconds = Math.min(look.motion.in?.seconds ?? 0.35, Math.max(0.12, (line.end - line.start) * 0.4));

    const cardIndex = cardCount > 0 ? i % cardCount : -1;
    const onCard = cardIndex >= 0 && onCards.length > 0 ? step(onCards, cardIndex) : undefined;

    // What the line does while it holds. A hero line takes the look's hero
    // move; everything else walks the rota, so no two neighbours move alike.
    const moveId =
      line.move ??
      (emphasis === "hero" ? ens?.heroMove ?? step(moves, i + sec) : step(moves, i + sec));
    const anim: OverlayAnim = {
      in: { style: inStyle, seconds: round2(inSeconds) },
      ...(look.motion.out ? { out: look.motion.out } : {}),
      ...(look.motion.loop
        ? { loop: { style: look.motion.loop.style, speed: look.motion.loop.speed ?? 1 } }
        : {}),
      ...(moveId && moveId !== "none" ? { move: { style: moveId, strength: 1 } } : {}),
    };

    return {
      text: fit.text,
      start: line.start,
      end: line.end,
      x,
      y,
      rotation: tilt,
      font,
      weight: face.weight,
      italic: face.italic ?? false,
      size: fit.size,
      color: line.color ?? onCard ?? step(palette, i + sec),
      anim,
      move: moveId,
      cardIndex,
    };
  });
}
