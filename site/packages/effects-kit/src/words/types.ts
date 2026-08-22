/**
 * The word-effect format: three poses and the seconds between them.
 *
 * A word effect is what a line does word by word while it plays. Each display
 * word owns a window on the element's clock (see `wordWindows`), and the
 * effect says how that word looks before its window, at it, and after it has
 * passed. An emphasis travels — `after` is `before`, so the treatment moves
 * along the line. A build accumulates — `after` is `active`, so the line
 * assembles itself as it is spoken.
 *
 * Everything in the picker is one entry in this shape, stored as data beside
 * this file. Adding an effect means adding an entry; no code lists them.
 */

import type { Easing } from "../motion/types";

/** One word's look at one moment. Offsets are em of the word's own type size,
 * rotation is degrees clockwise about its center; every channel is optional
 * and an absent one rests. */
export interface WordPose {
  /** How far the word has taken the accent color, 0..1. */
  accent?: number;
  /** The word's own opacity, multiplying the element's. */
  opacity?: number;
  /** Type-size multiplier. A word drawn bigger takes its new width in the
   * line, so its neighbours move out of its way and settle back after. */
  scale?: number;
  dx?: number;
  dy?: number;
  rotate?: number;
  /** How far the effect's mark is drawn, 0..1. */
  mark?: number;
}

/** The mark an effect draws behind or under the word it is on. */
export type WordMark = "underline" | "box";

/** Which shelf of the picker an effect sits on: an emphasis that travels
 * along the line, or a build the line assembles itself through. */
export type WordFamily = "emphasis" | "build";

export interface WordEffect {
  label: string;
  /** What the effect does, in one line — the text the tool schemas and the
   * assistant's skills are written from. */
  note: string;
  family: WordFamily;
  /** Before the word's window. */
  before: WordPose;
  /** Once it has arrived. */
  active: WordPose;
  /** After its window has passed. */
  after: WordPose;
  /** Seconds from the word's onset to `active`; 0 = it lands on the beat. */
  attack: number;
  /** Seconds from the end of its window to `after`; 0 = it leaves on the
   * beat. */
  release: number;
  ease?: Easing;
  mark?: WordMark;
  /** The color the accent channel runs to when the element names none: the
   * accent (`accent`), or the text's own color (`text`), which is what an
   * effect that says everything with size wants. */
  accentDefault?: "accent" | "text";
}

/** The effect ids, as saved on an element and on the subtitles block. */
export type WordEffectId = string;

/** Word effects as an element carries them. */
export interface OverlayWords {
  style: WordEffectId;
  /** Accent color; absent = the effect's own default (see `wordAccent`). */
  color?: string;
  /** How far a word swells at its moment; replaces every pose scale above 1.
   * Absent = the effect's own. */
  scale?: number;
  /** The opacity a word wears off its moment; replaces every pose opacity
   * below 1. Absent = the effect's own. */
  dim?: number;
  /** Word onsets in seconds from the element's start, one per display word.
   * Absent, or a count the text has outgrown, = an even share by length. */
  times?: number[];
}

/** One word, resolved for drawing: what both painters read and neither
 * computes. */
export interface WordDraw {
  /** The fill, with the accent already blended in. */
  color: string;
  opacity: number;
  scale: number;
  /** The size the word takes room at, which is its own or its resting size,
   * whichever is wider. A word swelling past its rest pushes its neighbours
   * aside; one still growing into place holds the room it will end up
   * needing, so the line does not slide about as it assembles. */
  layoutScale: number;
  /** Em of the word's own type size. */
  dx: number;
  dy: number;
  rotate: number;
  /** The mark to draw, and how far; absent = none. */
  mark?: WordMark;
  markAlpha?: number;
  markColor?: string;
  /** Word color over a box, which needs to read against the fill. */
  markText?: string;
}
