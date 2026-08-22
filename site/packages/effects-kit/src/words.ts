/**
 * Word-by-word emphasis on text: the whole line stays on screen and the word
 * being said takes the accent. Captions have had this since they carried word
 * timings; here it is the same treatment offered as a slot on any text
 * element, so a title placed by hand emphasizes on its own clock.
 *
 * The windows are the model. One per display word, covering the element's
 * span end to end with no gaps, so the accent never blinks off between two
 * words. `times` is the element's own clock — seconds from its start — filled
 * in when something measured the speech; its absence means nobody did, and
 * the words share the span by length.
 */

import type { Overlay, TextOverlay, WordAccentMode } from "./types";

/** Accent for emphasis that names no color of its own. */
export const WORD_ACCENT_DEFAULT = "#FFE94A";

/** How much a popped word swells while it is said, and the bounds a caller
 * may set instead. The swollen word takes its new width in the line, so the
 * words beside it move out of its way and settle back as it shrinks. */
export const WORD_POP_SCALE = 1.24;
export const WORD_SWELL_MIN = 1;
export const WORD_SWELL_MAX = 2;

/** The treatments, in the order every picker offers them. */
export const WORD_ACCENT_MODE_IDS: WordAccentMode[] = ["pop", "color", "underline", "box"];

export const WORD_ACCENT_LABELS: Record<WordAccentMode, string> = {
  pop: "Pop",
  color: "Color",
  underline: "Underline",
  box: "Highlight",
};

export const WORD_ACCENT_NOTES: Record<WordAccentMode, string> = {
  pop: "the word swells and the line makes room for it, in the text's own color unless an accent is set",
  color: "the word takes the accent color",
  underline: "accent color with a rule under the word",
  box: "an accent box behind the word",
};

/** Word emphasis as an element carries it. */
export interface OverlayWords {
  style: WordAccentMode;
  /** Accent color; absent = the treatment's own default (see `wordAccent`):
   * a swell keeps the text's color, the color treatments take the accent. */
  color?: string;
  /** How far the word swells while it is said, WORD_SWELL_MIN..MAX; absent =
   * the treatment's own default. */
  scale?: number;
  /** Word onsets in seconds from the element's start, one per display word.
   * Absent, or a count the text has outgrown, = an even share by length. */
  times?: number[];
}

/**
 * The color an emphasized word wears: what the element set, else the
 * treatment's own default. A swell says everything it has to say with size,
 * so it keeps the color the rest of the line is written in; the treatments
 * that speak in color take the accent.
 */
export function wordAccent(
  w: { style?: WordAccentMode; color?: string } | undefined,
  textColor: string
): string {
  if (w?.color) return w.color;
  return w?.style === "pop" ? textColor : WORD_ACCENT_DEFAULT;
}

/** How far the emphasized word swells: the element's own setting, else the
 * treatment's default — a pop swells, the rest hold their size. */
export function wordSwell(w: { style?: WordAccentMode; scale?: number } | undefined): number {
  if (!w) return 1;
  const set = w.scale;
  if (set !== undefined && Number.isFinite(set))
    return Math.min(WORD_SWELL_MAX, Math.max(WORD_SWELL_MIN, set));
  return w.style === "pop" ? WORD_POP_SCALE : 1;
}

/** The swell of the word a painted overlay has marked — the same reading as
 * `wordSwell`, off the highlight fields the painters actually carry. */
export function highlightSwell(o: { highlightMode?: WordAccentMode; highlightScale?: number }): number {
  return wordSwell({ style: o.highlightMode, scale: o.highlightScale });
}

/** Black or white, whichever reads on the given hex fill. */
export function contrastText(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "#111114";
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111114" : "#FFFFFF";
}

/** The display words of a text block: whitespace-split across every line.
 * Both renderers walk them in this order, which is what a word index means. */
export function displayWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * One window per display word, seconds from the element's start, partitioning
 * [0, dur] with no gaps. Measured onsets are used while they still match the
 * text one for one; otherwise (an edited line, a rewrite) the span is split
 * proportionally by word length.
 */
export function wordWindows(
  text: string,
  dur: number,
  times?: number[]
): { start: number; end: number }[] {
  const words = displayWords(text);
  const n = words.length;
  if (n === 0 || dur <= 0) return [];
  const starts: number[] = [];
  if (times && times.length === n) {
    for (let i = 0; i < n; i++) {
      const t = i === 0 ? 0 : Math.min(Math.max(times[i], 0), dur);
      starts.push(i > 0 && t < starts[i - 1] ? starts[i - 1] : t);
    }
  } else {
    const weights = words.map((w) => w.length + 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const w of weights) {
      starts.push((dur * acc) / total);
      acc += w;
    }
  }
  return starts.map((start, i) => ({ start, end: i === n - 1 ? dur : starts[i + 1] }));
}

/** The emphasis an element carries, or nothing — the slot is text only. */
export function overlayWords(o: Overlay): OverlayWords | undefined {
  if ((o.kind ?? "text") !== "text") return undefined;
  return o.anim?.words;
}

/** Which display word is emphasized at `tLocal`, or -1 before the first. */
export function wordAccentIndex(o: Overlay, tLocal: number, dur: number): number {
  const w = overlayWords(o);
  if (!w) return -1;
  return wordWindows((o as TextOverlay).text, dur, w.times).findIndex(
    (win) => tLocal >= win.start && tLocal < win.end
  );
}

/**
 * The element as it paints with one word emphasized — the same
 * `highlightWord` fields captions ride, so the painters need to know nothing
 * about where the index came from. An element with no emphasis, or a time
 * before its first word, rides through untouched.
 */
export function applyWordAccent<T extends Overlay>(o: T, index: number): T {
  const w = overlayWords(o);
  if (!w || index < 0) return o;
  const color = wordAccent(w, (o as TextOverlay).color ?? WORD_ACCENT_DEFAULT);
  return {
    ...o,
    highlightWord: index,
    highlightColor: color,
    highlightMode: w.style,
    highlightText: contrastText(color),
    highlightScale: wordSwell(w),
  } as T;
}
