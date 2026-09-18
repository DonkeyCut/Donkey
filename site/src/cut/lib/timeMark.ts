"use client";

import { retimeOf } from "@donkeycut/effects-kit";
import { clipLen } from "./store";
import type { AudioClip, VideoClip } from "./types";

/**
 * Moments a message points at.
 *
 * A chat message can name a place in the cut — "@1:34 zoom in here". The time
 * is written in the text, so the model reads it the way the user wrote it, and
 * a mark beside the text records the frame it was written on: the clip under
 * the moment, the source it plays, and the second inside that source.
 *
 * Between writing a message and running it the cut can move. The queue holds
 * messages while a turn runs, and that turn ripples, splits, retimes, trims
 * and deletes. So a queued message re-reads its marks against the live
 * document before it goes out, and the token in the text is rewritten to the
 * second that frame has reached.
 *
 * A source second is what makes that hold. Trim is in source seconds, so a
 * speed, a curve, a reverse and a preset all leave it alone and the clip's own
 * map puts it back on the timeline; a split copies it to both halves, so the
 * frame is found again through the source even on the half that took a new id.
 * A moment sitting in a gap has no frame, so it holds its distance from the
 * head of the clip beside it — a head is the edge an insert lands against, and
 * the one a split leaves where it was. A moment whose clip is gone altogether
 * keeps the second it was written at.
 */

/** A time token in message text, e.g. `@1:34` or `@0:02.5` or `@1:02:30`. */
export const TIME_TOKEN_RE = /@(\d{1,3}:[0-5]\d(?::[0-5]\d)?(?:\.\d{1,2})?)(?![\d:])/g;

/** What `@` offers for the playhead: the row's handle and its name, matched
 * by the picker the same way an asset's are. */
export const PLAYHEAD_HANDLE = "here";
export const PLAYHEAD_NAME = "playhead";

/** A written-out `@here` / `@playhead`, once something follows it. */
const PLAYHEAD_TOKEN_RE = new RegExp(
  `(^|[\\s([])@(${PLAYHEAD_HANDLE}|${PLAYHEAD_NAME})(?![\\w-])`,
  "gi"
);

/**
 * Swap every finished `@here` for the moment it names, so the word becomes the
 * time whether the user took it off the menu or typed straight through it.
 * `caret` is where they are: a token ending right there is still being typed
 * and is left alone until the next character lands. Null when nothing changed.
 */
export function resolvePlayheadTokens(
  text: string,
  at: number,
  s: TimeMarkState,
  caret?: number
): { text: string; marks: TimeMark[]; caret: number } | null {
  const marks: TimeMark[] = [];
  let out = "";
  let last = 0;
  let shift = 0;
  for (const m of text.matchAll(PLAYHEAD_TOKEN_RE)) {
    const start = m.index + (m[1] ?? "").length;
    const end = start + 1 + m[2].length;
    if (end === caret) continue;
    const mark = markAt(at, s);
    marks.push(mark);
    out += text.slice(last, start) + mark.token;
    if (caret !== undefined && end <= caret) shift += mark.token.length - (end - start);
    last = end;
  }
  if (marks.length === 0) return null;
  return { text: out + text.slice(last), marks, caret: (caret ?? 0) + shift };
}

/** How far outside a clip's trim a source second may sit and still count as
 * inside it — a rounding tolerance, not a reach. */
const TRIM_EPS = 1e-6;

/** A moment a message points at, and what it hangs off in the cut. */
export interface TimeMark {
  /** The token as it stands in the text right now. */
  token: string;
  /** The timeline second the token reads as. */
  at: number;
  /** The clip the moment hangs off; absent when nothing carries it. */
  clipId?: string;
  /** The source that clip plays, so the frame is findable even after the
   * clip it was written over is split, replaced or renumbered. */
  assetId?: string;
  /** The source second under the moment, for a moment over the clip itself. */
  src?: number;
  /** Seconds from the clip's head, for a moment sitting off the clip — the
   * head is the stable edge: splitting a clip leaves its head where it was. */
  lead?: number;
}

/** What the marks read against: everything on the timeline that carries time. */
export interface TimeMarkState {
  clips: VideoClip[];
  audioClips?: AudioClip[];
}

/** `94.2` -> `"1:34.2"`, `94` -> `"1:34"`, `3723` -> `"1:02:03"`. */
export function formatMark(t: number): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return tenth > 0 ? `${base}.${tenth}` : base;
}

/** `"1:34.2"` -> `94.2`. Null for anything that is not a time. */
export function parseMark(text: string): number | null {
  const parts = text.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) return null;
    total = total * 60 + n;
  }
  return total;
}

/** The token text for a moment: `@1:34`. */
export const markToken = (t: number) => `@${formatMark(t)}`;

/** Anything on the timeline that can carry a moment. */
type Carrier = VideoClip | AudioClip;

/** Everything on the timeline a moment can hang off, in the order a moment
 * picks one: the spine first, then the pictures over it, then the sound. A
 * project with no picture at all — a voiceover being assembled — anchors on
 * its audio, and rides the same ripples. */
function carriers(s: TimeMarkState): Carrier[] {
  const video = s.clips
    .filter((c) => Number.isFinite(c.start))
    .sort((a, b) => a.track - b.track || a.start - b.start);
  return [...video, ...(s.audioClips ?? [])];
}

/** Is `src` a source second this clip plays? Trim is in source seconds, so
 * this survives every retime — a speed, a curve, a reverse, a preset all
 * leave `in` and `out` where they are. */
function playsSource(c: Carrier, src: number): boolean {
  const lo = Math.min(c.in, c.out) - TRIM_EPS;
  const hi = Math.max(c.in, c.out) + TRIM_EPS;
  return src >= lo && src <= hi;
}

/** Where a clip puts a source second on the timeline, clamped to its span. */
function timeOfSource(c: Carrier, src: number): number {
  const len = clipLen(c);
  return c.start + Math.min(Math.max(retimeOf(c).tAt(src), 0), len);
}

/**
 * Hang a moment off the cut. Over a clip it holds the source second under it —
 * the frame — so any retime, trim or split still finds it. Off every clip it
 * holds its distance from the head of the clip it sits next to, the coming one
 * where there is one, since a head is what an insert lands against.
 */
export function markAt(at: number, s: TimeMarkState): TimeMark {
  const token = markToken(at);
  const list = carriers(s);
  // On a cut the incoming clip owns the moment — its first frame is what the
  // preview shows there — so a clip's own span is checked before the tail its
  // neighbour starts on.
  const over =
    list.find((c) => at >= c.start && at < c.start + clipLen(c)) ??
    list.find((c) => at >= c.start && at <= c.start + clipLen(c));
  if (over)
    return {
      token,
      at,
      clipId: over.id,
      assetId: over.assetId,
      src: retimeOf(over).srcAt(at - over.start),
    };
  const ahead = list
    .filter((c) => c.start > at)
    .sort((a, b) => a.start - b.start)[0];
  const behind = list
    .filter((c) => c.start < at)
    .sort((a, b) => b.start - a.start)[0];
  const near = ahead ?? behind;
  return near
    ? { token, at, clipId: near.id, assetId: near.assetId, lead: at - near.start }
    : { token, at };
}

/** Where a mark's moment sits now. */
export function markTime(mark: TimeMark, s: TimeMarkState): number {
  if (!mark.clipId) return mark.at;
  const list = carriers(s);
  const holder = list.find((c) => c.id === mark.clipId);
  // Off a clip: the distance from that clip's head is the whole of it. A head
  // the split moved to another id is still findable through the source.
  if (mark.lead !== undefined) {
    const heads = (holder ? [holder] : list.filter((c) => c.assetId === mark.assetId))
      .map((c) => c.start + mark.lead!)
      .sort((a, b) => Math.abs(a - mark.at) - Math.abs(b - mark.at));
    return heads.length > 0 ? Math.max(0, heads[0]) : mark.at;
  }
  const src = mark.src ?? 0;
  // The frame, wherever it plays now. A split hands half the clip a new id, a
  // trim can push the frame into the neighbour, and the same source can be on
  // the timeline more than once — so every clip over that source is a
  // candidate, and the one nearest where the moment last was wins.
  const covering = list
    .filter((c) => (c.id === mark.clipId || c.assetId === mark.assetId) && playsSource(c, src))
    .map((c) => timeOfSource(c, src))
    .sort((a, b) => Math.abs(a - mark.at) - Math.abs(b - mark.at));
  if (covering.length > 0) return Math.max(0, covering[0]);
  // The frame was trimmed away: the closest the clip still reaches.
  if (holder) return Math.max(0, timeOfSource(holder, src));
  return mark.at;
}

/**
 * Re-read a message's moments against the live cut: every time token is
 * rewritten to where its moment sits now, and a token that arrived without a
 * mark — typed by hand, or restored from storage — gets one here so it moves
 * with the cut from this point on.
 */
export function syncTimes(
  text: string,
  marks: TimeMark[],
  s: TimeMarkState
): { text: string; marks: TimeMark[] } {
  const pool = [...marks];
  const out: TimeMark[] = [];
  let next = "";
  let last = 0;
  for (const m of text.matchAll(TIME_TOKEN_RE)) {
    const written = parseMark(m[1]);
    if (written === null) continue;
    const held = pool.findIndex((p) => p.token === m[0]);
    const mark = held >= 0 ? pool.splice(held, 1)[0] : markAt(written, s);
    const at = held >= 0 ? markTime(mark, s) : written;
    const fresh: TimeMark = { ...mark, token: markToken(at), at };
    out.push(fresh);
    next += text.slice(last, m.index) + fresh.token;
    last = m.index + m[0].length;
  }
  return { text: next + text.slice(last), marks: out };
}

/** Split text into literal runs and time tokens, for drawing each moment as a
 * chip. The token text is kept exactly as written, so a caller that mirrors
 * the string character for character stays aligned. */
export function splitTimes(text: string): (string | { text: string; at: number })[] {
  const parts: (string | { text: string; at: number })[] = [];
  let last = 0;
  for (const m of text.matchAll(TIME_TOKEN_RE)) {
    const at = parseMark(m[1]);
    if (at === null) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ text: m[0], at });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
