/**
 * The one word evaluator.
 *
 * Everything a line does word by word — the karaoke accent captions have
 * always had, a title swelling on the beat, a sentence assembling itself as
 * it is spoken — comes through here. The windows are the model: one per
 * display word, covering the element's span end to end with no gaps, so a
 * treatment never blinks off between two words. `times` is the element's own
 * clock, filled in when something measured the speech; its absence means
 * nobody did, and the words share the span by length.
 *
 * A word's look at a moment is read off its effect's three poses and the
 * seconds between them (see `types.ts`), resolved to a `WordDraw` the
 * painters read straight. Neither painter knows what an effect is.
 */

import { bezierEase } from "../motion/evaluate";
import type { Overlay, TextOverlay } from "../types";
import { wordEffect, wordEffectRamps } from "./catalog";
import type { OverlayWords, WordDraw, WordEffect, WordPose } from "./types";

/** How far a word's alphabetic baseline sits below the middle of its em box,
 * in em. The canvas painter measures this off the face it is drawing and only
 * falls back here; a stylesheet cannot measure, so the DOM twin works from
 * this figure, which is where the two can differ by a hair while a word is
 * mid-resize. */
export const WORD_BASELINE_DROP = 0.3;

/** Accent for an effect that names no color of its own. */
export const WORD_ACCENT_DEFAULT = "#FFE94A";

/** How much a popped word swells while it is said, and the bounds a caller
 * may set instead. */
export const WORD_POP_SCALE = 1.24;
export const WORD_SWELL_MIN = 1;
export const WORD_SWELL_MAX = 2;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

/** Black or white, whichever reads on the given hex fill. */
export function contrastText(hex: string): string {
  const n = hexValue(hex);
  if (n === null) return "#111114";
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? "#111114" : "#FFFFFF";
}

function hexValue(hex: string): number | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  return m ? parseInt(m[1], 16) : null;
}

/** Two hex colors blended in sRGB. Anything that will not parse hands back
 * the endpoint it is nearest, so an unusual color string still draws. */
export function mixHex(from: string, to: string, p: number): string {
  if (p <= 0.001) return from;
  if (p >= 0.999) return to;
  const a = hexValue(from);
  const b = hexValue(to);
  if (a === null || b === null) return p < 0.5 ? from : to;
  let out = "#";
  for (let s = 16; s >= 0; s -= 8) {
    const v = Math.round(lerp((a >> s) & 255, (b >> s) & 255, p));
    out += v.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The color a word runs to: what the element set, else the effect's own
 * default. An effect that says everything with size keeps the color the rest
 * of the line is written in; the ones that speak in color take the accent.
 */
export function wordAccent(
  w: { style?: string; color?: string } | undefined,
  textColor: string
): string {
  if (w?.color) return w.color;
  return wordEffect(w?.style).accentDefault === "text" ? textColor : WORD_ACCENT_DEFAULT;
}

/** How far a word swells at its moment: the element's own setting, else the
 * peak its effect reaches. Never below 1 — this is also the room a frame
 * sampler leaves around the line for a word that grows past it. */
export function wordSwell(w: { style?: string; scale?: number } | undefined): number {
  if (!w) return 1;
  const set = w.scale;
  if (set !== undefined && Number.isFinite(set))
    return Math.min(WORD_SWELL_MAX, Math.max(WORD_SWELL_MIN, set));
  const e = wordEffect(w.style);
  return Math.max(1, e.before.scale ?? 1, e.active.scale ?? 1, e.after.scale ?? 1);
}

/** The opacity a word wears off its moment: the element's own setting, else
 * the faintest its effect calls for. */
export function wordDim(w: { style?: string; dim?: number } | undefined): number {
  if (w?.dim !== undefined && Number.isFinite(w.dim)) return clamp01(w.dim);
  const e = wordEffect(w?.style);
  return Math.min(1, e.before.opacity ?? 1, e.active.opacity ?? 1, e.after.opacity ?? 1);
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

/** A pose with every channel filled in, and the element's two overrides
 * folded in: the size knob replaces every scale above 1, the dim knob every
 * opacity below 1. Both are single settings across the effect, so an effect
 * that wanted two different faint levels would flatten them — none does. */
function settled(
  p: WordPose,
  swell: number,
  dim: number,
  /** The pose a word wears at its moment, which is where a swell the caller
   * asked for lands even on an effect that resizes nothing of its own. */
  atItsMoment = false
): Required<WordPose> {
  const scale = p.scale ?? 1;
  const opacity = p.opacity ?? 1;
  return {
    accent: p.accent ?? 0,
    opacity: opacity < 1 ? dim : 1,
    scale: scale > 1 || (atItsMoment && swell > 1) ? swell : scale,
    dx: p.dx ?? 0,
    dy: p.dy ?? 0,
    rotate: p.rotate ?? 0,
    mark: p.mark ?? 0,
  };
}

function blend(a: Required<WordPose>, b: Required<WordPose>, p: number): Required<WordPose> {
  return {
    accent: lerp(a.accent, b.accent, p),
    opacity: lerp(a.opacity, b.opacity, p),
    scale: lerp(a.scale, b.scale, p),
    dx: lerp(a.dx, b.dx, p),
    dy: lerp(a.dy, b.dy, p),
    rotate: lerp(a.rotate, b.rotate, p),
    mark: lerp(a.mark, b.mark, p),
  };
}

/**
 * One word's pose at `t` seconds on the element's clock: held at `before`
 * until its window opens, ramped to `active` over the attack, held there to
 * the end of the window, then ramped to `after` over the release. An attack
 * longer than the window itself is cut to fit, so a fast word still finishes
 * arriving before the next one starts.
 */
export function wordPoseAt(
  e: WordEffect,
  win: { start: number; end: number },
  t: number,
  opts: { swell: number; dim: number }
): Required<WordPose> {
  const before = settled(e.before, opts.swell, opts.dim);
  const active = settled(e.active, opts.swell, opts.dim, true);
  const after = settled(e.after, opts.swell, opts.dim);
  const ease = (u: number) => (e.ease ? bezierEase(e.ease, clamp01(u)) : clamp01(u));
  const span = Math.max(0, win.end - win.start);
  const attack = Math.min(e.attack, span);
  if (t < win.start) return before;
  if (attack > 0 && t < win.start + attack)
    return blend(before, active, ease((t - win.start) / attack));
  if (t < win.end) return active;
  if (e.release > 0 && t < win.end + e.release)
    return blend(active, after, ease((t - win.end) / e.release));
  return after;
}

/** The word effect an element carries, or nothing — the slot is text only. */
export function overlayWords(o: Overlay): OverlayWords | undefined {
  if ((o.kind ?? "text") !== "text") return undefined;
  return o.anim?.words;
}

/**
 * Every display word resolved for drawing at `t` seconds on the element's
 * clock. The accent is already blended into each word's fill, so a painter
 * reads colors and numbers and nothing else.
 */
export function wordDrawsAt(
  text: string,
  words: OverlayWords,
  textColor: string,
  dur: number,
  t: number
): WordDraw[] {
  const e = wordEffect(words.style);
  const accent = wordAccent(words, textColor);
  const markText = contrastText(accent);
  // A box puts the word inside the accent, so its fill runs to the color that
  // reads against that fill rather than to the accent itself.
  const target = e.mark === "box" ? markText : accent;
  const opts = { swell: wordSwell(words), dim: wordDim(words) };
  const restScale = (e.after.scale ?? 1) > 1 ? opts.swell : (e.after.scale ?? 1);
  return wordWindows(text, dur, words.times).map((win) => {
    const p = wordPoseAt(e, win, t, opts);
    return {
      color: mixHex(textColor, target, p.accent),
      opacity: p.opacity,
      scale: p.scale,
      layoutScale: Math.max(p.scale, restScale),
      dx: p.dx,
      dy: p.dy,
      rotate: p.rotate,
      ...(e.mark && p.mark > 0.001
        ? { mark: e.mark, markAlpha: p.mark, markColor: accent, markText }
        : {}),
    };
  });
}

/**
 * The element as it paints at `t`, its words resolved — the one field both
 * painters read, so neither needs to know an effect exists. An element with
 * no word effect rides through untouched.
 */
export function applyWordDraw<T extends Overlay>(o: T, t: number, dur: number): T {
  const w = overlayWords(o);
  if (!w) return o;
  const text = o as TextOverlay;
  return {
    ...o,
    wordDraw: wordDrawsAt(text.text, w, text.color ?? WORD_ACCENT_DEFAULT, dur, t),
  } as T;
}

/** Frames per second a ramping effect is cut at when a sampler has to bake it
 * into stills. Matches the slice rate the typed-out ramps use. */
const WORD_SLICE_FPS = 24;

/**
 * The spans a sampler has to draw separately to carry this effect: one per
 * stretch where the picture holds still, cut finer wherever a word is
 * ramping. An effect that lands on the beat comes back as its word windows
 * exactly — one still per word, which is what the caption burn-in has always
 * written. Spans partition [0, dur] with no gaps.
 */
export function wordSampleWindows(
  text: string,
  words: OverlayWords,
  dur: number,
  fps = WORD_SLICE_FPS,
  /** Most slices one ramp may be cut into. A sampler whose pictures are
   * expensive — a caption burn-in draws whole frames — bounds it, so a long
   * attack costs the same few pictures a short one does. */
  maxSlices = Infinity
): { start: number; end: number }[] {
  const wins = wordWindows(text, dur, words.times);
  if (wins.length === 0) return [];
  const e = wordEffect(words.style);
  const cuts = new Set<number>([0, dur]);
  const at = (v: number) => {
    if (v > 1e-3 && v < dur - 1e-3) cuts.add(Math.round(v * 1e4) / 1e4);
  };
  for (const w of wins) {
    at(w.start);
    at(w.end);
  }
  if (wordEffectRamps(e)) {
    const ramp = (from: number, secs: number) => {
      if (secs <= 0) return;
      const n = Math.min(Math.ceil(secs * fps), maxSlices + 1);
      for (let i = 1; i < n; i++) at(from + (secs * i) / n);
    };
    for (const w of wins) {
      ramp(w.start, Math.min(e.attack, Math.max(0, w.end - w.start)));
      ramp(w.end, e.release);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    if (sorted[i + 1] - sorted[i] > 1e-3) out.push({ start: sorted[i], end: sorted[i + 1] });
  }
  return out;
}

/** A hex color at a given alpha, as the 8-digit hex both CSS and a canvas
 * fill accept. */
export function hexAlpha(hex: string, a: number): string {
  const n = hexValue(hex);
  const byte = Math.round(clamp01(a) * 255)
    .toString(16)
    .padStart(2, "0");
  if (n === null) return hex;
  return `#${n.toString(16).padStart(6, "0")}${byte}`;
}

/** How far a word strays from its place, in em of its own type size — the
 * room a frame sampler has to leave around the line. A turn counts as reach
 * too: a word pivoting about its own center swings its ends out of the box.
 */
export function wordReach(w: { style?: string } | undefined): number {
  if (!w) return 0;
  const e = wordEffect(w.style);
  const of = (p: WordPose) =>
    Math.max(Math.abs(p.dx ?? 0), Math.abs(p.dy ?? 0)) + Math.abs(p.rotate ?? 0) / 30;
  return Math.max(of(e.before), of(e.active), of(e.after));
}

/** A word at rest — the pose a painter falls back to when the track it was
 * handed is shorter than the text it is drawing. */
export const REST_WORD: WordDraw = {
  color: "#FFFFFF",
  opacity: 1,
  scale: 1,
  layoutScale: 1,
  dx: 0,
  dy: 0,
  rotate: 0,
};
