import {
  contrastText as kitContrastText,
  textRoom,
  wrapTextToRoom,
  wordDrawsAt,
  WORD_ACCENT_DEFAULT,
  wordEffect,
  wordSampleWindows,
  type OverlayWords,
} from "@donkeycut/effects-kit";
import { measureLine, textFontOf } from "./textFit";
import { formatTime } from "./time";
import type {
  CaptionStyleId,
  FontId,
  SubtitleCue,
  SubtitlesBlock,
  TextOverlay,
  WordEffectId,
} from "./types";

export type { CaptionStyleId } from "./types";

/** How many subtitle tracks (languages) the block carries: its track metas,
 * or any higher lane a cue still sits on; at least one. */
export function subtitleLaneCount(subs: SubtitlesBlock): number {
  let n = Math.max(1, subs.tracks?.length ?? 0);
  for (const c of subs.cues) n = Math.max(n, (c.lane ?? 0) + 1);
  return n;
}

/** One track's cues, in start order. */
export function laneCues(subs: SubtitlesBlock, lane: number): SubtitleCue[] {
  return subs.cues.filter((c) => (c.lane ?? 0) === lane);
}

/** Whether one subtitle track is hidden from the played/exported picture.
 * Preview and export both read this, so a hidden language never renders in
 * one and burns in the other. */
export function laneHidden(subs: SubtitlesBlock, lane: number): boolean {
  return subs.tracks?.[lane]?.hidden === true;
}

/** A track's language: its own meta, then the block-level legacy locale (which
 * described the first track only), then English. The panel's language select
 * and every generation path read this same chain, so the language shown is
 * always the language sent. */
export function trackLocale(subs: SubtitlesBlock, lane: number): string {
  return subs.tracks?.[lane]?.locale ?? (lane === 0 ? subs.locale : undefined) ?? "en-US";
}

/** The block-level word-effect overrides a caption track carries: which
 * effect, and the two settings an effect may have. Absent = the caption
 * style's own. */
export interface CaptionWordOverrides {
  accentMode?: WordEffectId;
  accentColor?: string;
  accentScale?: number;
  accentDim?: number;
}

/** A track's effective caption anchor plus the block's look overrides — what
 * `cueOverlay` reads to place and dress one cue. */
export interface CaptionPos extends CaptionWordOverrides {
  x: number;
  y: number;
  size?: number;
  font?: FontId;
}

/** One track's anchor, filled in: the track's own dragged spot wins, then the
 * block-level legacy spot (first track only), then the style's default
 * stacked upward per track so simultaneous languages never overlap. */
export function trackPos(
  subs: SubtitlesBlock,
  style: CaptionStyle,
  lane: number
): CaptionPos {
  const meta = subs.tracks?.[lane];
  return {
    x: meta?.x ?? (lane === 0 ? subs.x : undefined) ?? style.x,
    y: meta?.y ?? (lane === 0 ? subs.y : undefined) ?? Math.max(0.08, style.y - lane * 0.1),
    size: subs.size,
    font: subs.font,
    accentMode: subs.accentMode,
    accentColor: subs.accentColor,
    accentScale: subs.accentScale,
    accentDim: subs.accentDim,
  };
}

/** Caption look shared by the preview layer and the export burn-in —
 * TikTok-style bold white on a translucent plate, low center. */
export const SUB_STYLE = {
  x: 0.5,
  y: 0.8,
  size: 42,
  font: "sf",
  weight: 700,
  color: "#FFFFFF",
  shadow: true,
  plate: true,
} as const;

/** A caption preset: the shared subtitle look plus optional opener emphasis
 * (a bigger, punchier first line). */
export interface CaptionStyle {
  id: CaptionStyleId;
  label: string;
  x: number;
  y: number;
  size: number;
  font: FontId;
  weight: 400 | 700;
  color: string;
  shadow: boolean;
  plate: boolean;
  plateColor?: string;
  plateOpacity?: number;
  /** Multiply the opening cue's size, so the hook lands bigger. */
  openerScale?: number;
  /** Accent color for the word effect; absent = DEFAULT_ACCENT. */
  accent?: string;
  /** Which word effect the style's captions run: an accent box behind the
   * spoken word (plate styles), a line building itself up, and so on. Absent
   * = underline. */
  accentMode?: WordEffectId;
}

/** Spoken-word accent for styles that don't pick their own. */
export const DEFAULT_ACCENT = WORD_ACCENT_DEFAULT;

/** Black or white, whichever reads on the given hex fill. */
export const contrastText = kitContrastText;

/** The word effect a caption track runs, as the element model carries it:
 * user overrides on the subtitles block win over the caption style's
 * defaults, and an effect that says everything with size keeps the color the
 * rest of the caption is written in when nobody named an accent. */
export function captionWords(style: CaptionStyle, subs?: CaptionWordOverrides): OverlayWords {
  const id = subs?.accentMode ?? style.accentMode ?? "underline";
  const color =
    subs?.accentColor ??
    style.accent ??
    (wordEffect(id).accentDefault === "text" ? style.color : DEFAULT_ACCENT);
  return {
    style: id,
    color,
    ...(subs?.accentScale !== undefined ? { scale: subs.accentScale } : {}),
    ...(subs?.accentDim !== undefined ? { dim: subs.accentDim } : {}),
  };
}

export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = {
  clean: {
    id: "clean",
    label: "Clean",
    x: 0.5,
    y: 0.8,
    size: 42,
    font: "sf",
    weight: 700,
    color: "#FFFFFF",
    shadow: true,
    plate: true,
    accentMode: "box",
  },
  hook: {
    id: "hook",
    label: "Curiosity hook",
    x: 0.5,
    y: 0.78,
    size: 46,
    font: "rounded",
    weight: 700,
    color: "#FFFFFF",
    shadow: true,
    plate: true,
    plateColor: "#0A84FF",
    plateOpacity: 0.9,
    openerScale: 1.28,
    accentMode: "box",
  },
  punchy: {
    id: "punchy",
    label: "Big & punchy",
    x: 0.5,
    y: 0.74,
    size: 50,
    font: "impact",
    weight: 700,
    color: "#FFE94A",
    shadow: true,
    plate: false,
    openerScale: 1.34,
    accent: "#FFFFFF",
  },
  minimal: {
    id: "minimal",
    label: "Minimal",
    x: 0.5,
    y: 0.82,
    size: 36,
    font: "sf",
    weight: 400,
    color: "#FFFFFF",
    shadow: true,
    plate: false,
  },
  editorial: {
    id: "editorial",
    label: "Editorial",
    x: 0.5,
    y: 0.8,
    size: 42,
    font: "serif",
    weight: 700,
    color: "#FFFFFF",
    shadow: true,
    plate: false,
  },
  typewriter: {
    id: "typewriter",
    label: "Typewriter",
    x: 0.5,
    y: 0.8,
    size: 38,
    font: "mono",
    weight: 400,
    color: "#FFFFFF",
    shadow: false,
    plate: true,
    accentMode: "box",
  },
  block: {
    id: "block",
    label: "Block",
    x: 0.5,
    y: 0.8,
    size: 44,
    font: "sf",
    weight: 700,
    color: "#FFFFFF",
    shadow: false,
    plate: true,
    plateColor: "#111114",
    plateOpacity: 1,
    accentMode: "box",
  },
  highlight: {
    id: "highlight",
    label: "Highlighter",
    x: 0.5,
    y: 0.8,
    size: 42,
    font: "sf",
    weight: 700,
    color: "#111114",
    shadow: false,
    plate: true,
    plateColor: "#FFE94A",
    plateOpacity: 0.95,
    accent: "#FF375F",
    accentMode: "box",
  },
  bubble: {
    id: "bubble",
    label: "Bubblegum",
    x: 0.5,
    y: 0.8,
    size: 42,
    font: "rounded",
    weight: 700,
    color: "#FFFFFF",
    shadow: false,
    plate: true,
    plateColor: "#FF375F",
    plateOpacity: 0.92,
    accentMode: "box",
  },
  neon: {
    id: "neon",
    label: "Neon",
    x: 0.5,
    y: 0.78,
    size: 46,
    font: "impact",
    weight: 700,
    color: "#30D158",
    shadow: true,
    plate: false,
    openerScale: 1.2,
    accent: "#FFFFFF",
  },
};

/** The active caption preset for a subtitles block. */
export function captionStyle(style: CaptionStyleId | undefined): CaptionStyle {
  return CAPTION_STYLES[style ?? "clean"] ?? CAPTION_STYLES.clean;
}

/** Balance a caption onto up to two lines so it never overflows the frame. */
export function wrapCaption(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= 26) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let i = t.indexOf(" "); i !== -1; i = t.indexOf(" ", i + 1)) {
    if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  return best === -1 ? t : t.slice(0, best) + "\n" + t.slice(best + 1);
}

/**
 * Wrap a caption into as many lines as it takes to keep every line inside the
 * frame width at font `size` in `font`. The export burn-in renders each
 * `\n`-separated line centered without wrapping, so this is what decides how
 * a cue sits in the frame.
 *
 * The line is measured on the face it will be drawn in. A character count has
 * to assume the widest glyph that face could hold, which broke short cues onto
 * two lines with most of the frame still empty beside them; a measured line
 * puts a cue on one line whenever one line fits.
 */
export function wrapCaptionForSize(
  text: string,
  size: number,
  frameW: number,
  font: FontId = "sf",
  weight: 400 | 700 = 700,
  x = 0.5
): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return "";
  const css = textFontOf({ font, weight, italic: undefined }, size);
  return wrapTextToRoom(flat, textRoom(x, frameW), (line) => measureLine(line, css, size));
}

/** A cue as a synthetic overlay, so captions ride the title pipeline. The style
 * preset drives the look; a user font or font size overrides the preset's
 * (the opener emphasis still multiplies the size); a dragged caption position
 * (frame fractions) overrides the preset's spot; `at` resolves the track's
 * word effect at that moment on the timeline. */
export function cueOverlay(
  cue: SubtitleCue,
  style: CaptionStyle = CAPTION_STYLES.clean,
  isOpener = false,
  pos: Partial<CaptionPos> | undefined,
  at: number | undefined,
  frameW: number
): TextOverlay {
  const words = at !== undefined ? cueWords(cue, style, pos) : null;
  const size = Math.round(
    (pos?.size ?? style.size) * (isOpener && style.openerScale ? style.openerScale : 1)
  );
  const x = pos?.x ?? style.x;
  const text = wrapCaptionForSize(
    cue.text,
    size,
    frameW,
    pos?.font ?? style.font,
    style.weight,
    x
  );
  return {
    id: `sub-${cue.id}`,
    text,
    start: cue.start,
    end: cue.end,
    x,
    y: pos?.y ?? style.y,
    size,
    font: pos?.font ?? style.font,
    weight: style.weight,
    color: style.color,
    shadow: style.shadow,
    plate: style.plate,
    ...(style.plateColor ? { plateColor: style.plateColor } : {}),
    ...(style.plateOpacity !== undefined ? { plateOpacity: style.plateOpacity } : {}),
    ...(words && at !== undefined
      ? {
          wordDraw: wordDrawsAt(
            text,
            words,
            style.color,
            Math.max(0, cue.end - cue.start),
            at - cue.start
          ),
        }
      : {}),
  };
}

/** A caption's pictures are full frames, one per span, and a cut carries one
 * of them for every word of speech in it. A ramp is sampled at this rate, and
 * never at more than this many steps however long the ramp runs, which is
 * enough to read an arrival while holding a subtitled export to a few
 * pictures per word. */
const CAPTION_WORD_FPS = 12;
const CAPTION_WORD_SLICES = 2;

/**
 * One cue's word effect with the transcriber's own onsets on it. The clock is
 * the measured speech wherever there is any, so the effect walks the line at
 * the pace it is actually said; a cue with no timings shares its span by word
 * length instead. Everything that draws or samples a cue reads this one
 * function, so the picture a burn-in span stands for is resolved against the
 * same windows the span was cut from.
 */
export function cueWords(
  cue: SubtitleCue,
  style: CaptionStyle,
  subs?: CaptionWordOverrides
): OverlayWords {
  const times = cue.words?.map((w) => w.t0 - cue.start);
  return { ...captionWords(style, subs), ...(times ? { times } : {}) };
}

/**
 * The moments a cue has to be drawn at to carry its word effect: one span per
 * stretch the picture holds still. An effect that lands on the beat comes
 * back as one span per word, which is what the caption burn-in has always
 * written; one that ramps is cut finer inside a word's window.
 */
export function cueWordFrames(
  cue: SubtitleCue,
  style: CaptionStyle,
  subs?: CaptionWordOverrides
): { start: number; end: number }[] {
  const dur = Math.max(0, cue.end - cue.start);
  return wordSampleWindows(cue.text, cueWords(cue, style, subs), dur, CAPTION_WORD_FPS, CAPTION_WORD_SLICES).map((w) => ({
    start: cue.start + w.start,
    end: cue.start + w.end,
  }));
}

/** The cue under a given time, if any. */
export function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | undefined {
  return cues.find((c) => t >= c.start && t < c.end);
}

/** Compact panel timestamp (m:ss.s) — the same convention as the transport
 * readout, so a cue and the playhead never show different times for one
 * instant, and a rounded 59.97s can't render as an invalid ":60". */
export const fmtCueTime = formatTime;
