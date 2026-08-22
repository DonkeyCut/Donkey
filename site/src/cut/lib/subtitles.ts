import {
  contrastText as kitContrastText,
  WORD_ACCENT_DEFAULT,
  WORD_ACCENT_LABELS,
  WORD_ACCENT_MODE_IDS,
  WORD_ACCENT_NOTES,
  wordWindows,
} from "@donkeycut/effects-kit";
import { formatTime } from "./time";
import type {
  CaptionStyleId,
  FontId,
  SubtitleCue,
  SubtitlesBlock,
  TextOverlay,
  WordAccentMode,
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

/** A track's effective caption anchor plus the block's look overrides
 * (karaoke accent, font size) — the `pos` argument `cueOverlay` takes. The
 * track's own dragged spot wins, then the block-level legacy spot (first
 * track only), then the style's default stacked upward per track so
 * simultaneous languages never overlap. */
export function trackPos(
  subs: SubtitlesBlock,
  style: CaptionStyle,
  lane: number
): { x: number; y: number; size?: number; font?: FontId; accentMode?: WordAccentMode; accentColor?: string } {
  const meta = subs.tracks?.[lane];
  return {
    x: meta?.x ?? (lane === 0 ? subs.x : undefined) ?? style.x,
    y: meta?.y ?? (lane === 0 ? subs.y : undefined) ?? Math.max(0.08, style.y - lane * 0.1),
    size: subs.size,
    font: subs.font,
    accentMode: subs.accentMode,
    accentColor: subs.accentColor,
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
  /** Karaoke accent for the spoken word; absent = DEFAULT_ACCENT. */
  accent?: string;
  /** How the spoken word lights up: an accent box behind it (plate styles) or
   * the accent color plus underline (open text). Absent = underline. */
  accentMode?: WordAccentMode;
  /** Word color on an accent box; absent = auto contrast. */
  accentText?: string;
}

/** Spoken-word accent for styles that don't pick their own. */
export const DEFAULT_ACCENT = WORD_ACCENT_DEFAULT;

/** The word emphasis treatments, in the order every picker offers them —
 * the caption panel, the element animation grid, and the assistant's tool
 * enums all read this one list, so a new treatment reaches all of them. */
export const WORD_ACCENT_MODES: { id: WordAccentMode; label: string; hint: string }[] =
  WORD_ACCENT_MODE_IDS.map((id) => ({
    id,
    label: WORD_ACCENT_LABELS[id],
    hint: WORD_ACCENT_NOTES[id],
  }));

/** Black or white, whichever reads on the given hex fill. */
export const contrastText = kitContrastText;

/** The effective karaoke treatment for the spoken word: user overrides on the
 * subtitles block win over the caption style's defaults, a swell with no
 * accent named keeps the caption's own color, and a custom color picks its
 * own contrast text for the box treatment. */
export function karaokeLook(
  style: CaptionStyle,
  subs?: { accentMode?: WordAccentMode; accentColor?: string }
): { mode: WordAccentMode; color: string; text: string } {
  const mode = subs?.accentMode ?? style.accentMode ?? "underline";
  // A swell says it with size, so with nobody naming an accent it keeps the
  // color the rest of the caption is written in.
  const color =
    subs?.accentColor ?? style.accent ?? (mode === "pop" ? style.color : DEFAULT_ACCENT);
  return {
    mode,
    color,
    text: subs?.accentColor ? contrastText(color) : style.accentText ?? contrastText(color),
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
    accentText: "#FFFFFF",
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
 * frame width at font `size`. The export burn-in renders each `\n`-separated
 * line centered without wrapping, so this is what guarantees captions stay in
 * bounds — bigger styles (and the punchy opener) wrap to fewer words per line.
 */
export function wrapCaptionForSize(text: string, size: number, frameW: number): string {
  const words = text.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (words.length === 0) return "";
  // ~88% of the frame width, with a conservative bold-glyph advance
  // (~0.58·size) so real fonts stay comfortably inside the safe area.
  const maxChars = Math.max(8, Math.floor((0.88 * frameW) / (0.58 * size)));
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (line && cand.length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = cand;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/**
 * Per-display-word timeline windows for a cue, partitioning [start, end] with
 * no gaps so the karaoke highlight never blinks off between words. Uses the
 * transcriber's word timings while they still match the text one-to-one;
 * otherwise (hand edits, social rewrites) splits proportionally by word length.
 */
export function cueWordWindows(cue: SubtitleCue): { start: number; end: number }[] {
  const dur = Math.max(0, cue.end - cue.start);
  return wordWindows(
    cue.text,
    dur,
    cue.words?.map((w) => w.t0 - cue.start)
  ).map((w) => ({ start: cue.start + w.start, end: cue.start + w.end }));
}

/** A cue as a synthetic overlay, so captions ride the title pipeline. The style
 * preset drives the look; a user font or font size overrides the preset's
 * (the opener emphasis still multiplies the size); a dragged caption position
 * (frame fractions) overrides the preset's spot; a word index marks that word
 * for the karaoke accent. */
export function cueOverlay(
  cue: SubtitleCue,
  style: CaptionStyle = CAPTION_STYLES.clean,
  isOpener = false,
  pos: { x?: number; y?: number; size?: number; font?: FontId; accentMode?: WordAccentMode; accentColor?: string } | undefined,
  wordIndex: number | undefined,
  frameW: number
): TextOverlay {
  const kl = wordIndex !== undefined ? karaokeLook(style, pos) : null;
  const size = Math.round(
    (pos?.size ?? style.size) * (isOpener && style.openerScale ? style.openerScale : 1)
  );
  return {
    id: `sub-${cue.id}`,
    text: wrapCaptionForSize(cue.text, size, frameW),
    start: cue.start,
    end: cue.end,
    x: pos?.x ?? style.x,
    y: pos?.y ?? style.y,
    size,
    font: pos?.font ?? style.font,
    weight: style.weight,
    color: style.color,
    shadow: style.shadow,
    plate: style.plate,
    ...(style.plateColor ? { plateColor: style.plateColor } : {}),
    ...(style.plateOpacity !== undefined ? { plateOpacity: style.plateOpacity } : {}),
    ...(kl && wordIndex !== undefined
      ? {
          highlightWord: wordIndex,
          highlightColor: kl.color,
          highlightMode: kl.mode,
          highlightText: kl.text,
        }
      : {}),
  };
}

/** The cue under a given time, if any. */
export function cueAt(cues: SubtitleCue[], t: number): SubtitleCue | undefined {
  return cues.find((c) => t >= c.start && t < c.end);
}

/** Compact panel timestamp (m:ss.s) — the same convention as the transport
 * readout, so a cue and the playhead never show different times for one
 * instant, and a rounded 59.97s can't render as an invalid ":60". */
export const fmtCueTime = formatTime;
