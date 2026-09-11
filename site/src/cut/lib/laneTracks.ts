"use client";

import { retimeOf, type Retimable, type SpeedNode } from "@donkeycut/effects-kit";

/**
 * The lane-track coordinator: the one place for how items on the timeline's
 * tracks behave. Video clips, audio, titles, and subtitle cues all route
 * their pointer gestures through here, so selection, moving, resizing,
 * collision, snapping, and retracking work identically everywhere — and a
 * new track type gets every behavior by writing one small adapter.
 *
 * The shared behaviors:
 * - Grab: cmd/shift toggles the multi-selection; a plain grab selects the
 *   item and moves the playhead under the pointer.
 * - Move: the bar ghosts under the pointer while the neighbors on the row it
 *   aims at part around the landing slot; either edge snaps to logical
 *   times. The row under the pointer takes the item; carrying it past the
 *   top or bottom of its band by `NEW_ROW_PX` opens a brand-new row there,
 *   which then holds itself until the pointer returns to a row. Lanes stay
 *   contiguous, so an emptied row collapses.
 * - Resize: edges snap; growing into a neighbor pushes its whole run along;
 *   each edge rubber-bands past its source bound and springs back on release —
 *   the left past its floor (timeline start, packed leaders, or a media item's
 *   first sample), the right past its ceiling (the last sample it can reveal).
 * - Placement collision: adding/pasting slides to the next free slot on the
 *   lane — the store's `nextFreeStart` is that one primitive.
 * - Cut: the store's `splitAtPlayhead` slices whichever kind is selected.
 *
 * An adapter can vary exactly three things: `closesGap` (a video clip's
 * slot heals behind it; a sound bed or title keeps its absolute time),
 * `rowsDescend` (the video stack draws track 0 at the bottom), and
 * `multiLane` (cues never leave their language row).
 */

import type React from "react";
import { refFromAsset, startPointerRefDrag } from "./assetRef";
import { startDrag } from "./drag";
import { additiveClick, snapHeldOff } from "./hostKeys";
import { clipLen, getClipSpans, moveOverlayGroup, nextFreeStart, overlayLaneOrder, projectDuration, reanchorTransitions, startTrimRipple, useEditor } from "./store";
import { playheadAt } from "./playhead";
import type {
  AudioClip,
  MediaAsset,
  Overlay,
  Selection,
  SubtitleCue,
  VideoClip,
} from "./types";

type S = ReturnType<typeof useEditor.getState>;

// A drag lane: one per doc structure. "video" is every video track (a
// clip's lane is its track number); "overlay" is the title lanes, where every
// overlay element kind rides one adapter.
export type LaneKind = "video" | "audio" | "overlay" | "cue";

/** The Selection kind a lane maps to: a video clip selects as `"clip"`. */
const laneSelectionKind = (kind: LaneKind): NonNullable<Selection>["kind"] =>
  kind === "video" ? "clip" : kind;

/** Visual gutter between adjacent clips; time math stays exact. */
export const CLIP_GAP = 4;
/** Pull a dragged or resized edge to a logical time within this many px. */
export const SNAP_PX = 6;
/** How far past the top or bottom of its band a drag has to carry an item to
 * open a new row. Every drop inside the band lands on a row, which opens room
 * for it, so this reach is the one gesture that adds a row — and it is long
 * enough that drifting off a row while sliding along it never does. */
export const NEW_ROW_PX = 24;

/** A display row's screen box, top first in the order the band paints. */
export interface RowBox {
  top: number;
  h: number;
}

/** The display row a drag aims at from the pointer's screen y: the row under
 * the pointer (a pointer in the gap between two rows takes the row below),
 * `-1` past the top of the band, `rows.length` past the bottom. Reaching past
 * an edge takes `NEW_ROW_PX` of travel; holding it takes none, since by then
 * the new row's own box fills the space the pointer is in — `held` is the row
 * the drag resolved to last. An edge whose row the item holds alone offers
 * nothing: the row it left would collapse behind it and the fresh one would
 * renumber straight back to the picture already on screen, so `edges` says
 * which sides are open. */
export function resolveRow(
  rows: readonly RowBox[],
  y: number,
  held: number | null,
  edges: { top: boolean; bottom: boolean }
): number {
  const n = rows.length;
  if (n === 0) return 0;
  const top = rows[0];
  const bottom = rows[n - 1];
  if (edges.top && y < top.top - (held === -1 ? 0 : NEW_ROW_PX)) return -1;
  if (edges.bottom && y > bottom.top + bottom.h + (held === n ? 0 : NEW_ROW_PX)) return n;
  const i = rows.findIndex((r) => y <= r.top + r.h);
  return i < 0 ? n - 1 : Math.max(0, i);
}

/** The lane an item lands on while its slot is laid out around the pointer:
 * residents whose midpoint sits left of the pointer keep their spot (the
 * slot lands after them), the rest slide right as a run to make room.
 * Anchoring on the pointer rather than the ghost's geometric center lets an
 * item take the front as soon as you point past a neighbor's middle — an
 * item longer than the gap ahead could never drag its own center that far
 * left. `restAt` is each resident's resting spot for this frame. Returns the
 * slot start and where every resident should sit. */
export function partAround<X extends { view: LaneItem }>(
  residents: readonly X[],
  pointerTime: number,
  start: number,
  len: number,
  restAt: (x: X) => number
): { slotStart: number; clamped: boolean; at: (x: X) => number } {
  const others = [...residents].sort((a, b) => a.view.start - b.view.start);
  const before = others.filter((x) => x.view.start + x.view.len / 2 <= pointerTime);
  const after = others.filter((x) => x.view.start + x.view.len / 2 > pointerTime);
  const clampFloor = before.reduce((m, b) => Math.max(m, restAt(b) + b.view.len), 0);
  const slotStart = Math.max(start, clampFloor);
  const delta = after.length ? Math.max(0, slotStart + len - restAt(after[0])) : 0;
  const pushed = new Set(after.map((x) => x.view.id));
  return {
    slotStart,
    clamped: slotStart !== start,
    at: (x) => (pushed.has(x.view.id) ? restAt(x) + delta : restAt(x)),
  };
}
/** How far (px) an edge can rubber-band past its bound before springing back. */
const RUBBER_PX = 32;

/** Normalized geometry of one item on a lane track. */
interface LaneItem {
  id: string;
  start: number;
  len: number;
  lane: number;
}

type Patch<T> = { id: string; patch: Partial<T> };

/**
 * Everything kind-specific, so the gestures stay generic. Patches are built
 * from gesture-start snapshots, which makes a retreating drag restore the
 * originals exactly (including a cue's word timings).
 */
interface LaneAdapter<T> {
  minLen: number;
  /** Vertical drag retracks among this kind's own lanes. */
  multiLane: boolean;
  /** Display rows run from the highest lane down: the video stack draws
   * track 0 at the bottom, so the row past its top is a new highest track
   * and the row past its bottom a new track 0. */
  rowsDescend?: boolean;
  raws(s: S): T[];
  view(raw: T): LaneItem;
  /** Apply patches transiently (no undo entry; the gesture checkpoints once). */
  apply(patches: Patch<T>[]): void;
  movePatch(raw: T, start: number): Patch<T>;
  trimLeftPatch(raw: T, newStart: number): Patch<T>;
  trimRightPatch(raw: T, newEnd: number): Patch<T>;
  /** Left-trim with the edge at `start` while the source reads from the
   * start-equivalent `reveal` — when the edge pins at its floor, `reveal`
   * keeps walking the source back and the tail grows. Media kinds only. */
  revealLeftPatch?(raw: T, start: number, reveal: number): Patch<T>;
  /** Earliest timeline start the left edge can reveal to (media source floor). */
  leftFloor(s: S, raw: T): number;
  /** Longest timeline footprint the item can grow to (media source bound). */
  maxLen(s: S, raw: T): number;
  /** Write a committed lane number (multi-lane kinds only). */
  lanePatch?(raw: T, lane: number): Patch<T>;
  /** The media behind the item, so dragging it can feed reference drop zones. */
  assetOf?(s: S, raw: T): MediaAsset | undefined;
  /** The asset's beat grid mapped through this item onto the timeline —
   * snap targets, so an edge lands on the music. Media kinds only. */
  beatTimes?(s: S, raw: T): number[];
  /** A lifted item's slot closes behind it: while one drags, same-lane items
   * past its old spot rest slid left by its length, so the run heals the
   * moment the item leaves. Video tracks set this; free-form lanes (audio,
   * titles, cues) hold every resting spot. */
  closesGap?: boolean;
  /** After a committed move: keep the list sorted, re-seat what rides the
   * cuts. `before` is the state the gesture started from. */
  onMoved?(before: S): void;
  /** After a committed move, shift companions that ride along — a grouped
   * overlay's peers keep their relative timing. Same undo step. */
  afterMove?(raw: T, delta: number): void;
}

/** The asset's beats inside a media item's trimmed range, in timeline
 * seconds. Beats live on the asset in source seconds, so every clip showing
 * the source maps its own window of them. */
function mediaBeatTimes(
  s: S,
  c: { assetId: string; start: number; in: number; out: number; speed?: number; speedCurve?: SpeedNode[]; reverse?: boolean }
): number[] {
  const beats = s.assets.find((a) => a.id === c.assetId)?.beats?.beats;
  if (!beats?.length) return [];
  const rt = retimeOf(c);
  const times: number[] = [];
  for (const b of beats) if (b >= c.in && b <= c.out) times.push(c.start + rt.tAt(b));
  return times;
}

/** The trim a media item's head edge writes when it lands on timeline second
 * `tHead`: the source edge playing there — `in`, or `out` on a reversed
 * item. */
const headTrim = <T extends Retimable>(c: T, tHead: number, start: number): Partial<T> => {
  const src = retimeOf(c).srcAt(tHead - start);
  return (c.reverse ? { out: src } : { in: src }) as Partial<T>;
};
/** The trim the tail edge writes when it lands on `tEnd`. */
const tailTrim = <T extends Retimable>(c: T, tEnd: number, start: number): Partial<T> => {
  const src = retimeOf(c).srcAt(tEnd - start);
  return (c.reverse ? { in: src } : { out: src }) as Partial<T>;
};
/** The earliest timeline second an item's head can reach: where the source's
 * own head sits — second 0, or the source's end on a reversed item. */
const headFloor = (c: Retimable & { start: number }, duration: number | undefined) =>
  Math.max(0, c.start + retimeOf(c).tAt(c.reverse ? (duration ?? c.out) : 0));
/** The longest an item can run: its trim opened to the source's far end,
 * which a reversed item reaches by opening `in` toward 0. */
const mediaMaxLen = (c: Retimable, duration: number | undefined) =>
  retimeOf(c.reverse ? { ...c, in: 0 } : { ...c, out: duration ?? c.out }).len;

function videoMaxLen(s: S, c: VideoClip): number {
  const a = s.assets.find((x) => x.id === c.assetId);
  // A still has no source length, so its clip can stretch to any duration.
  if (a?.type === "image") return Infinity;
  return mediaMaxLen(c, a?.duration);
}

const videoAdapter: LaneAdapter<VideoClip> = {
  minLen: 0.15,
  multiLane: true,
  rowsDescend: true,
  raws: (s) => s.clips,
  view: (c) => ({ id: c.id, start: c.start, len: clipLen(c), lane: c.track }),
  apply: (patches) => useEditor.getState().updateClipsTransient(patches),
  movePatch: (c, start) => ({ id: c.id, patch: { start } }),
  trimLeftPatch: (c, newStart) => ({
    id: c.id,
    patch: { start: newStart, ...headTrim(c, newStart, c.start) },
  }),
  trimRightPatch: (c, newEnd) => ({
    id: c.id,
    patch: tailTrim(c, newEnd, c.start),
  }),
  revealLeftPatch: (c, start, reveal) => ({
    id: c.id,
    patch: { start, ...headTrim(c, reveal, c.start) },
  }),
  leftFloor: (s, c) => headFloor(c, s.assets.find((x) => x.id === c.assetId)?.duration),
  maxLen: videoMaxLen,
  lanePatch: (c, lane) => ({ id: c.id, patch: { track: lane } }),
  closesGap: true,
  assetOf: (s, c) => s.assets.find((x) => x.id === c.assetId),
  beatTimes: mediaBeatTimes,
  // Clips stay sorted by start, and the transition bars re-seat onto the
  // cuts the move carried — the same settle every placement does.
  onMoved: (before) =>
    useEditor.setState((st) => {
      const clips = [...st.clips].sort((a, b) => a.start - b.start);
      return { clips, transitions: reanchorTransitions(before.clips, clips, st.transitions) };
    }),
};

const audioAdapter: LaneAdapter<AudioClip> = {
  minLen: 0.15,
  multiLane: true,
  raws: (s) => s.audioClips,
  view: (a) => ({ id: a.id, start: a.start, len: clipLen(a), lane: a.lane ?? 0 }),
  apply: (patches) => useEditor.getState().updateAudiosTransient(patches),
  movePatch: (a, start) => ({ id: a.id, patch: { start } }),
  trimLeftPatch: (a, newStart) => ({
    id: a.id,
    patch: { start: newStart, ...headTrim(a, newStart, a.start) },
  }),
  trimRightPatch: (a, newEnd) => ({
    id: a.id,
    patch: tailTrim(a, newEnd, a.start),
  }),
  revealLeftPatch: (a, start, reveal) => ({
    id: a.id,
    patch: { start, ...headTrim(a, reveal, a.start) },
  }),
  leftFloor: (s, a) => headFloor(a, s.assets.find((x) => x.id === a.assetId)?.duration),
  maxLen: (s, a) => mediaMaxLen(a, s.assets.find((x) => x.id === a.assetId)?.duration),
  lanePatch: (a, lane) => ({ id: a.id, patch: { lane: lane > 0 ? lane : undefined } }),
  assetOf: (s, a) => s.assets.find((x) => x.id === a.assetId),
  beatTimes: mediaBeatTimes,
};

const textAdapter: LaneAdapter<Overlay> = {
  minLen: 0.2,
  multiLane: true,
  raws: (s) => s.overlays,
  view: (o) => ({ id: o.id, start: o.start, len: o.end - o.start, lane: o.lane ?? 0 }),
  apply: (patches) => useEditor.getState().updateOverlaysTransient(patches),
  movePatch: (o, start) => ({ id: o.id, patch: { start, end: start + (o.end - o.start) } }),
  trimLeftPatch: (o, newStart) => ({ id: o.id, patch: { start: newStart } }),
  trimRightPatch: (o, newEnd) => ({ id: o.id, patch: { end: newEnd } }),
  leftFloor: () => 0,
  maxLen: () => Infinity,
  lanePatch: (o, lane) => ({ id: o.id, patch: { lane } }),
  afterMove: (o, delta) => moveOverlayGroup(o, delta),
};

const cueAdapter: LaneAdapter<SubtitleCue> = {
  minLen: 0.15,
  // One row per language track, but no vertical retracking: a cue belongs to
  // its language, and tracks are managed in the panel (capped at three).
  multiLane: false,
  raws: (s) => s.subtitles.cues,
  view: (c) => ({ id: c.id, start: c.start, len: c.end - c.start, lane: c.lane ?? 0 }),
  apply: (patches) => useEditor.getState().updateCuesTransient(patches),
  // Retiming detaches a cue from its word timings; an unmoved patch restores
  // the originals, so parted neighbors that flow back keep theirs.
  movePatch: (c, start) => ({
    id: c.id,
    patch: {
      start,
      end: start + (c.end - c.start),
      words: Math.abs(start - c.start) < 1e-6 ? c.words : undefined,
    },
  }),
  trimLeftPatch: (c, newStart) => ({ id: c.id, patch: { start: newStart, words: undefined } }),
  trimRightPatch: (c, newEnd) => ({ id: c.id, patch: { end: newEnd, words: undefined } }),
  leftFloor: () => 0,
  maxLen: () => Infinity,
  onMoved: () => useEditor.getState().sortCues(),
};

type LaneRaw = VideoClip | AudioClip | Overlay | SubtitleCue;
// The generic parameter is erased at the registry boundary; each gesture only
// feeds an adapter values that came out of that same adapter, so this is safe.
const ADAPTERS: Record<LaneKind, LaneAdapter<LaneRaw>> = {
  video: videoAdapter as unknown as LaneAdapter<LaneRaw>,
  audio: audioAdapter as unknown as LaneAdapter<LaneRaw>,
  overlay: textAdapter as unknown as LaneAdapter<LaneRaw>,
  cue: cueAdapter as unknown as LaneAdapter<LaneRaw>,
};

/** Logical times an edge can snap to: the timeline start, video track 0's
 * cut points and end, the playhead, every other lane item's edges across all
 * track kinds, and every beat of an asset's detected grid mapped through its
 * clips — a title can align to a music hit and vice versa. */
function snapTargets(s: S, kind: LaneKind, selfId: string, ownBeats = false): number[] {
  return snapTargetsExcluding(s, new Set([`${kind}:${selfId}`]), ownBeats);
}

/** Snap targets with a whole set of items excluded — a group drag must not
 * snap the moving set against its own edges. Keys are `structure:id`.
 *
 * `ownBeats` keeps the excluded items' beat grids as targets, which is what a
 * trim wants: neither edge moves the source under the bar, so the item's own
 * beats hold still while the edge travels and landing an edit on the music
 * means landing on one of them. A move carries the source along, so there the
 * grid travels with the item and only everything else's beats are targets. */
function snapTargetsExcluding(
  s: S,
  excluded: ReadonlySet<string>,
  ownBeats = false
): number[] {
  const pts = new Set<number>([0]);
  for (const sp of getClipSpans(s.clips, s.assets)) {
    // The joint: every pair meets at the footprint end — a transition is a
    // blend at that cut, never an overlap.
    pts.add(sp.start + sp.len);
  }
  pts.add(projectDuration(s));
  pts.add(playheadAt());
  for (const k of Object.keys(ADAPTERS) as LaneKind[]) {
    for (const raw of ADAPTERS[k].raws(s)) {
      const v = ADAPTERS[k].view(raw);
      const self = excluded.has(`${k}:${v.id}`);
      if (!self) {
        pts.add(v.start);
        pts.add(v.start + v.len);
      }
      if (!self || ownBeats) for (const t of ADAPTERS[k].beatTimes?.(s, raw) ?? []) pts.add(t);
    }
  }
  return [...pts];
}

/** The nearest snap target within `tol` seconds, or null. */
function nearestSnap(t: number, targets: number[], tol: number): number | null {
  let best: number | null = null;
  let bd = tol;
  for (const T of targets) {
    const d = Math.abs(t - T);
    if (d <= bd) {
      bd = d;
      best = T;
    }
  }
  return best;
}

/** Ease that overshoots the target then settles — the elastic snap-back feel. */
function easeOutBack(p: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

/** Damp an overshoot in px so it gives but resists, saturating near `max`. */
function rubberBand(overPx: number, max: number): number {
  return max * (1 - Math.exp(-Math.max(0, overPx) / max));
}

// A snapped edge draws its guide where the bar is actually rendered: a left
// edge at the time itself, a right edge inset by the CLIP_GAP gutter, so the
// line hugs the bar's visible right edge instead of the next item's start.
const leftGuide = (t: number, pps: number) => t * pps;
const rightGuide = (t: number, pps: number) => t * pps - CLIP_GAP;

// The in-flight elastic snap-back. A new gesture settles it instantly rather
// than abandoning it: the floor is a correctness bound (a media item's first
// sample, or the leader run), and an abandoned snap would persist a
// below-floor trim into the doc.
let snapBack: { raf: number; finish: () => void } | null = null;
function settleSnapBack() {
  if (!snapBack) return;
  cancelAnimationFrame(snapBack.raf);
  const { finish } = snapBack;
  snapBack = null;
  finish();
}

// The head of the timeline is a wall: an item resting at 0 has nowhere left
// to give, and the document can hold no time before it. So the give is drawn.
// The bar itself slides under the pointer and springs back on release, which
// puts the same resistance under the hand at the head that an item with room
// to spare already has.
let overshoot: { el: HTMLElement; px: number; raf: number } | null = null;

function paintOvershoot(el: HTMLElement | null, px: number) {
  if (!el) return;
  if (overshoot && overshoot.el !== el) clearOvershoot();
  if (px > 0.01) {
    if (overshoot) cancelAnimationFrame(overshoot.raf);
    overshoot = { el, px, raf: 0 };
    el.style.transform = `translateX(${-px}px)`;
  } else if (overshoot) {
    clearOvershoot();
  }
}

function clearOvershoot() {
  if (!overshoot) return;
  cancelAnimationFrame(overshoot.raf);
  overshoot.el.style.transform = "";
  overshoot = null;
}

/** Let a drawn overshoot spring home on the same curve the stored trims use. */
function releaseOvershoot() {
  const held = overshoot;
  if (!held) return;
  const from = held.px;
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / 240);
    if (p < 1) {
      held.el.style.transform = `translateX(${-Math.max(0, from * (1 - easeOutBack(p)))}px)`;
      held.raf = requestAnimationFrame(step);
    } else {
      held.el.style.transform = "";
      if (overshoot === held) overshoot = null;
    }
  };
  held.raf = requestAnimationFrame(step);
}

/** The live move drag, published so the Timeline can render the ghost, the
 * landing slot, and grow the band while a new row is hovered. */
export interface LaneDrag {
  kind: LaneKind;
  id: string;
  /** The display row the drag aims at: `-1` opens a new row above the band,
   * one past the last row opens one below. */
  targetRow: number;
  ghostX: number; // ghost left in px — follows the pointer
  ghostY: number; // ghost vertical offset in px from its resting row — follows the pointer
  slotStart: number; // resolved landing start, seconds
  len: number; // dragged item length, seconds
  /** The rest of a group drag's set: each member rides the pointer as its own
   * ghost, shifted by the same delta as the grabbed item. */
  members?: { kind: LaneKind; id: string; ghostX: number }[];
}

/** The drag a bar renders with: the carried item's own LaneDrag, or — when
 * the bar is another member of a group drag — a copy whose ghost carries that
 * member's offset. Null for bars outside the drag. */
export function laneDragFor(d: LaneDrag | null, kind: LaneKind, id: string): LaneDrag | null {
  if (!d) return null;
  if (d.kind === kind && d.id === id) return d;
  const m = d.members?.find((x) => x.kind === kind && x.id === id);
  return m ? { ...d, kind, id, ghostX: m.ghostX } : null;
}

/** True when a live drag moves items on this kind's lanes and this bar is
 * outside the moving set: the bar animates the shifts that part it out of
 * the way. */
export function laneDragParts(d: LaneDrag | null, kind: LaneKind, id: string): boolean {
  if (!d || laneDragFor(d, kind, id)) return false;
  return d.kind === kind || !!d.members?.some((m) => m.kind === kind);
}

export interface LaneMoveUI {
  pps: number;
  /** The band's display rows as screen boxes, top first, read live: rows
   * can mount and shift while a drag runs. */
  rows(): RowBox[];
  /** The grabbed item's current display row. */
  homeRow: number;
  /** Timeline second the item's box is rendered at, when it differs from the
   * item's start (a clip after a cross-dissolve draws inset by half the
   * overlap) — keeps click-to-seek under the pointer. */
  visStart?: number;
  /** Publish (or clear) the in-flight drag so the slot and rows track it. */
  onDrag(d: LaneDrag | null): void;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap(x: number | null): void;
}

// ── Group move ──────────────────────────────────────────────────────────────

/** One item of a multi-selection drag, resolved to its structure. */
interface GroupMember {
  kind: LaneKind;
  raw: LaneRaw;
  id: string;
  start: number;
  len: number;
  /** Structure lane: a video clip's track, everything else's lane. */
  lane: number;
}

const memberOf = (s: S, sel: NonNullable<Selection>): GroupMember | null => {
  if (sel.kind === "clip") {
    const c = s.clips.find((x) => x.id === sel.id);
    return c ? { kind: "video", raw: c, id: c.id, start: c.start, len: clipLen(c), lane: c.track } : null;
  }
  if (sel.kind === "audio") {
    const a = s.audioClips.find((x) => x.id === sel.id);
    return a ? { kind: "audio", raw: a, id: a.id, start: a.start, len: clipLen(a), lane: a.lane ?? 0 } : null;
  }
  if (sel.kind === "overlay") {
    const o = s.overlays.find((x) => x.id === sel.id);
    return o ? { kind: "overlay", raw: o, id: o.id, start: o.start, len: o.end - o.start, lane: o.lane ?? 0 } : null;
  }
  if (sel.kind === "cue") {
    const c = s.subtitles.cues.find((x) => x.id === sel.id);
    return c ? { kind: "cue", raw: c, id: c.id, start: c.start, len: c.end - c.start, lane: c.lane ?? 0 } : null;
  }
  return null;
};

/**
 * Drag a whole multi-selection as one rigid set: every member shifts by the
 * same delta, so the arrangement — a title over its clip, a sound effect on
 * its beat — survives the move intact. Unselected items on every touched lane
 * slide right out of the way (the same first-free-slot rule every placement
 * uses) and flow back as the set retreats, so the doc stays overlap-free at
 * every instant. When the whole selection is one multi-lane kind, vertical
 * drag retracks all of it together, one row past either end opening a fresh
 * track; a mixed selection rides horizontally and every item keeps its row.
 */
function startGroupMove(
  e: React.PointerEvent,
  grabbed: GroupMember,
  members: GroupMember[],
  ui: LaneMoveUI
) {
  const s = useEditor.getState();
  // The grab keeps the multi-selection and makes the grabbed item primary —
  // collapsing to one item here would end the very gesture being started.
  useEditor.setState({
    selection: { kind: laneSelectionKind(grabbed.kind), id: grabbed.id },
    selectedKey: null,
  });
  if (s.playing) s.setPlaying(false);
  const grabTime =
    (ui.visStart ?? grabbed.start) +
    (e.clientX - e.currentTarget.getBoundingClientRect().left) / ui.pps;
  s.seek(grabTime);
  if (s.readOnly) return;
  s.pushHistory();

  const memberKeys = new Set(members.map((m) => `${m.kind}:${m.id}`));
  const targets = snapTargetsExcluding(s, memberKeys);
  const tol = SNAP_PX / ui.pps;
  // The set is rigid, so the earliest member is the whole group's floor.
  const minStart = Math.min(...members.map((m) => m.start));

  // Everyone else's resting spot on the lanes the group touches, grouped by
  // structure lane. Each frame re-lays these from rest, so a retreating drag
  // lets parted neighbors flow back.
  const laneKey = (m: { kind: LaneKind; lane: number }) => `${m.kind}:${m.lane}`;
  const lanesTouched = new Set(members.map(laneKey));
  const restOf = (kind: LaneKind) =>
    ADAPTERS[kind]
      .raws(s)
      .map((raw) => ({ kind, raw, view: ADAPTERS[kind].view(raw) }))
      .filter((x) => !memberKeys.has(`${kind}:${x.view.id}`));
  const rest = (
    [...restOf("video"), ...restOf("audio"), ...restOf("overlay"), ...restOf("cue")] as {
      kind: LaneKind;
      raw: LaneRaw;
      view: LaneItem;
    }[]
  ).filter((x) => lanesTouched.has(laneKey({ kind: x.kind, lane: x.view.lane })));

  // Vertical retracking, only when the whole selection is one multi-lane kind.
  const oneKind = members.every((m) => m.kind === grabbed.kind);
  const vertical = oneKind && ADAPTERS[grabbed.kind].multiLane;
  const usedLanes = vertical
    ? laneOrder(grabbed.kind, s, [...ADAPTERS[grabbed.kind].raws(s).map((r) => ADAPTERS[grabbed.kind].view(r).lane)])
    : [];
  const rowOf = (lane: number) => usedLanes.indexOf(lane);
  // A row past either end opens a brand-new track, and a selection that holds
  // an outermost row by itself has nothing to open on that side: the row it
  // leaves collapses behind it and the fresh one renumbers straight back to
  // where the picture already was — see `startLaneMove`, which draws the same
  // line for a single item.
  const rowsHeld = new Set(members.map((m) => rowOf(m.lane)));
  const heldIds = new Set(members.map((m) => m.id));
  const others = vertical
    ? ADAPTERS[grabbed.kind]
        .raws(s)
        .map((r) => ADAPTERS[grabbed.kind].view(r))
        .filter((v) => !heldIds.has(v.id))
    : [];
  const holdsRowAlone = (row: number) =>
    rowsHeld.has(row) && !others.some((v) => rowOf(v.lane) === row);
  const edges = { top: !holdsRowAlone(0), bottom: !holdsRowAlone(usedLanes.length - 1) };
  const rowLo = vertical ? (edges.top ? -1 : 0) - Math.min(...rowsHeld) : 0;
  const rowHi = vertical
    ? usedLanes.length - (edges.bottom ? 0 : 1) - Math.max(...rowsHeld)
    : 0;
  const homeRow = vertical ? rowOf(grabbed.lane) : ui.homeRow;

  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tl-scroll]");
  const sc0 = scroller?.scrollLeft ?? 0;
  // The ghosts' vertical anchor, as in the single-item move: the grabbed
  // item's row can shift when a new row opens above it.
  const homeTop = (rows: RowBox[]) => rows[homeRow]?.top ?? 0;
  const rowTop0 = homeTop(ui.rows());

  // Everyone in the set but the grabbed item: each rides the pointer as its
  // own ghost, so the whole selection visibly moves as one.
  const riders = members.filter((m) => m.kind !== grabbed.kind || m.id !== grabbed.id);

  let live = false;
  let dt = 0;
  let rowDelta = 0;
  // Where every item sat when last applied, so a frame patches only what
  // actually moves — a fifty-item drag must not rebuild the doc per pixel.
  const at = new Map<string, number>();
  const patchTo = (
    buckets: Map<LaneKind, Patch<LaneRaw>[]>,
    kind: LaneKind,
    raw: LaneRaw,
    id: string,
    restStart: number,
    want: number
  ) => {
    const cur = at.get(`${kind}:${id}`) ?? restStart;
    if (Math.abs(want - cur) <= 1e-9) return;
    const list = buckets.get(kind) ?? [];
    list.push(ADAPTERS[kind].movePatch(raw, want));
    buckets.set(kind, list);
    at.set(`${kind}:${id}`, want);
  };
  const layout = (delta: number) => {
    const buckets = new Map<LaneKind, Patch<LaneRaw>[]>();
    for (const m of members) patchTo(buckets, m.kind, m.raw, m.id, m.start, m.start + delta);
    // Per touched lane: unselected items take the first free spot at or after
    // their resting start, clear of the moving blocks and of each other —
    // shifts only grow rightward, so the parted keep their order and spacing.
    for (const key of lanesTouched) {
      const blocks = members
        .filter((m) => laneKey(m) === key)
        .map((m) => ({ start: m.start + delta, end: m.start + delta + m.len }));
      const others = rest
        .filter((x) => laneKey({ kind: x.kind, lane: x.view.lane }) === key)
        .sort((a, b) => a.view.start - b.view.start);
      let floor = -Infinity;
      for (const o of others) {
        const start = nextFreeStart(blocks, Math.max(o.view.start, floor), o.view.len);
        floor = start + o.view.len;
        patchTo(buckets, o.kind, o.raw, o.view.id, o.view.start, start);
      }
    }
    for (const [kind, patches] of buckets) if (patches.length) ADAPTERS[kind].apply(patches);
  };

  startDrag(e, {
    onMove: (dx, dy, ev) => {
      if (!live && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      live = true;
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (ev.clientX > r.right - 36) scroller.scrollLeft += 14;
        else if (ev.clientX < r.left + 36) scroller.scrollLeft -= 14;
      }
      const effDx = dx + ((scroller?.scrollLeft ?? sc0) - sc0);
      dt = Math.max(-minStart, effDx / ui.pps);
      // Snap the grabbed item's edges; the whole set follows its delta.
      let guide: number | null = null;
      if (!snapHeldOff(ev)) {
        const start = grabbed.start + dt;
        const end = start + grabbed.len;
        let best = { d: tol, dt, px: null as number | null };
        for (const T of targets) {
          if (Math.abs(start - T) < best.d)
            best = { d: Math.abs(start - T), dt: T - grabbed.start, px: leftGuide(T, ui.pps) };
          if (Math.abs(end - T) < best.d)
            best = { d: Math.abs(end - T), dt: T - grabbed.len - grabbed.start, px: rightGuide(T, ui.pps) };
        }
        if (best.px !== null && best.dt >= -minStart) {
          dt = best.dt;
          guide = best.px;
        }
      }
      const rows = ui.rows();
      if (vertical) {
        const row = resolveRow(rows, ev.clientY, homeRow + rowDelta, edges);
        rowDelta = Math.min(rowHi, Math.max(rowLo, row - homeRow));
      }
      ui.onSnap(guide);
      layout(dt);
      // Ghosts ride the raw pointer delta, clamped so the set's earliest
      // member holds at 0 — the same rigid floor the landing uses.
      const dtGhost = Math.max(-minStart, effDx / ui.pps);
      const ghostY = dy - (homeTop(rows) - rowTop0);
      ui.onDrag({
        kind: grabbed.kind,
        id: grabbed.id,
        targetRow: homeRow + rowDelta,
        ghostX: (grabbed.start + dtGhost) * ui.pps,
        ghostY,
        slotStart: grabbed.start + dt,
        len: grabbed.len,
        members: riders.map((m) => ({
          kind: m.kind,
          id: m.id,
          ghostX: (m.start + dtGhost) * ui.pps,
        })),
      });
    },
    onUp: (_dx, _dy, moved) => {
      ui.onSnap(null);
      ui.onDrag(null);
      if (!live || !moved) {
        // A plain click on a member: the selection narrows to it, like any
        // other click that isn't additive.
        useEditor.getState().select({ kind: laneSelectionKind(grabbed.kind), id: grabbed.id });
        return;
      }
      if (rowDelta !== 0) {
        // The set is leaving its rows: parted neighbors on the vacated lanes
        // flow back to rest, the members take their new lanes, and whatever
        // already lives there parts around them — same rule, new row.
        const buckets = new Map<LaneKind, Patch<LaneRaw>[]>();
        for (const o of rest) patchTo(buckets, o.kind, o.raw, o.view.id, o.view.start, o.view.start);
        for (const [k, patches] of buckets) if (patches.length) ADAPTERS[k].apply(patches);
        commitGroupRows(grabbed.kind, members, rowDelta);
        partClearOfMembers(grabbed.kind, new Set(members.map((m) => m.id)));
      }
      for (const kind of new Set(members.map((m) => m.kind))) ADAPTERS[kind].onMoved?.(s);
    },
  });
}

/** Slide everything that is not in `ids` clear of it, lane by lane: each
 * unselected item takes the first free spot at or after its own start, never
 * before the one ahead of it. Runs after a vertical group commit so the rows
 * the set landed on hold no overlaps. */
function partClearOfMembers(kind: LaneKind, ids: ReadonlySet<string>) {
  const s = useEditor.getState();
  const ad = ADAPTERS[kind];
  const all = ad.raws(s).map((raw) => ({ raw, view: ad.view(raw) }));
  const moved = all.filter((x) => ids.has(x.view.id));
  const patches: Patch<LaneRaw>[] = [];
  for (const lane of new Set(moved.map((x) => x.view.lane))) {
    const blocks = moved
      .filter((x) => x.view.lane === lane)
      .map((x) => ({ start: x.view.start, end: x.view.start + x.view.len }));
    const others = all
      .filter((x) => !ids.has(x.view.id) && x.view.lane === lane)
      .sort((a, b) => a.view.start - b.view.start);
    let floor = -Infinity;
    for (const o of others) {
      const start = nextFreeStart(blocks, Math.max(o.view.start, floor), o.view.len);
      floor = start + o.view.len;
      if (Math.abs(start - o.view.start) > 1e-9) patches.push(ad.movePatch(o.raw, start));
    }
  }
  if (patches.length) ad.apply(patches);
}

/** Land a vertical group drag: every member's display row shifts by the same
 * amount, a row past either end becomes a brand-new lane, and lanes renumber
 * contiguous so emptied ones collapse — the group form of `commitRow`. */
function commitGroupRows(kind: LaneKind, members: GroupMember[], rowDelta: number) {
  const s = useEditor.getState();
  const ad = ADAPTERS[kind];
  if (!ad.multiLane || !ad.lanePatch) return;
  const raws = ad.raws(s);
  const views = raws.map((r) => ad.view(r));
  const used = laneOrder(kind, s, views.map((v) => v.lane));
  const memberIds = new Set(members.map((m) => m.id));
  const moved = views.map((v) =>
    memberIds.has(v.id) ? laneAtRow(kind, used, used.indexOf(v.lane) + rowDelta) : v.lane
  );
  const usedNext = [...new Set(moved)].sort((a, b) => a - b);
  const remap = new Map(usedNext.map((l, i) => [l, i]));
  ad.apply(raws.map((r, i) => ad.lanePatch!(r, remap.get(moved[i]) ?? 0)));
}

/** Grab an item: select (or cmd/shift-toggle) it, then drag to move it along
 * and across lanes with parting, snapping, and lane retracking. */
export function startLaneMove(e: React.PointerEvent, kind: LaneKind, id: string, ui: LaneMoveUI) {
  // A secondary button belongs to the clip's context menu, not to a drag: it
  // selects what it points at — so the menu, and the next keystroke, act on
  // that item — and leaves the playhead where it is. Pointing at something
  // already in a multi-selection keeps the whole selection.
  if (e.button !== 0) {
    const st = useEditor.getState();
    const sel = { kind: laneSelectionKind(kind), id };
    const held =
      (st.selection?.kind === sel.kind && st.selection.id === sel.id) ||
      st.multiSelection.some((m) => m?.kind === sel.kind && m.id === sel.id);
    if (!held) st.select(sel);
    return;
  }
  settleSnapBack();
  const s = useEditor.getState();
  if (additiveClick(e)) {
    s.toggleSelect({ kind: laneSelectionKind(kind), id });
    return;
  }
  // A grab on one member of a multi-selection drags the whole selection as a
  // rigid set. Grouped overlays ride too: unselected peers sharing a groupId
  // join the set, so a group never tears apart under a multi-drag.
  const selKind = laneSelectionKind(kind);
  if (
    s.multiSelection.length > 1 &&
    s.multiSelection.some((m) => m?.kind === selKind && m.id === id)
  ) {
    const seen = new Set<string>();
    const members: GroupMember[] = [];
    const admit = (m: GroupMember | null) => {
      if (!m) return;
      const key = `${m.kind}:${m.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      members.push(m);
    };
    for (const sel of s.multiSelection) if (sel) admit(memberOf(s, sel));
    for (const m of [...members]) {
      const gid = m.kind === "overlay" ? (m.raw as Overlay).groupId : undefined;
      if (!gid) continue;
      for (const peer of s.overlays.filter((o) => o.groupId === gid))
        admit(memberOf(s, { kind: "overlay", id: peer.id }));
    }
    const grabbed = members.find((m) => m.kind === kind && m.id === id) ?? members.find((m) => m.id === id);
    if (grabbed && members.length > 1) {
      startGroupMove(e, grabbed, members, ui);
      return;
    }
  }
  const ad = ADAPTERS[kind];
  const raw0 = ad.raws(s).find((r) => ad.view(r).id === id);
  if (!raw0) return;
  const self = ad.view(raw0);
  s.select({ kind: laneSelectionKind(kind), id });
  // Clicking anywhere on the timeline pauses and moves the playhead — bars
  // included; otherwise playback rolls right past the point just picked.
  if (s.playing) s.setPlaying(false);
  // Absolute time under the cursor at grab: it seeds the playhead, and the
  // move gesture parts neighbors around it (below) so the point you grabbed
  // stays the point you're pointing with.
  const grabTime =
    (ui.visStart ?? self.start) +
    (e.clientX - e.currentTarget.getBoundingClientRect().left) / ui.pps;
  s.seek(grabTime);
  // A read-only view: the click selects and seeks; the drag never starts.
  if (s.readOnly) return;
  s.pushHistory();

  const start0 = self.start;
  const len = self.len;
  // Everyone else's resting spot, captured once: each move re-lays the lane
  // from these, so a retreating drag lets parted neighbors flow back.
  const rest = ad
    .raws(s)
    .filter((r) => ad.view(r).id !== id)
    .map((r) => ({ raw: r, view: ad.view(r) }));
  // Where a neighbor rests while the drag is live. On a gap-closing lane the
  // lifted clip's slot heals under it: same-lane neighbors past its old spot
  // rest slid left by its length, and the parting below lays the lane out
  // from these closed spots.
  const restAt = (x: (typeof rest)[number]) =>
    ad.closesGap && x.view.lane === self.lane && x.view.start > start0 + 1e-9
      ? x.view.start - len
      : x.view.start;
  // The one spot on the healed home lane that overlaps nothing: past the end
  // of the resting run. The lifted clip parks there while it hovers other
  // tracks, so the closed gap never puts two clips on the same span.
  const parked = rest
    .filter((x) => x.view.lane === self.lane)
    .reduce((m, x) => Math.max(m, restAt(x) + x.view.len), 0);
  const usedLanes = laneOrder(kind, s, [...rest.map((x) => x.view.lane), self.lane]);
  // The edges this drag can open a new row past. From an outermost row an
  // item alone there has nothing to open on its side: the row it left
  // collapses behind it, so the fresh one renumbers straight back to the
  // picture already on screen. Single-lane kinds stay on their row.
  const alone = !rest.some((x) => x.view.lane === self.lane);
  const edges = {
    top: !(alone && ui.homeRow === 0),
    bottom: !(alone && ui.homeRow === usedLanes.length - 1),
  };
  const targets = snapTargets(s, kind, id);
  const tol = SNAP_PX / ui.pps;
  // Dragging a media-backed item can also hand its asset to a reference drop
  // zone (AI chat, the image/video creators).
  const asset = ad.assetOf?.(s, raw0);
  const refDrag = asset ? startPointerRefDrag(refFromAsset(asset)) : null;
  // Dragging against a viewport edge scrolls the timeline so off-screen times
  // stay reachable; the scroll distance folds back into the drag delta.
  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tl-scroll]");
  const sc0 = scroller?.scrollLeft ?? 0;
  // The ghost's vertical anchor: rows can mount mid-drag (a would-be new
  // row revealing itself above), shifting this item's row in the layout. The
  // ghost offset subtracts that shift so it stays glued to the pointer.
  const homeTop = (rows: RowBox[]) => rows[ui.homeRow]?.top ?? 0;
  const rowTop0 = homeTop(ui.rows());

  let live = false;
  let targetRow = ui.homeRow;
  let slotStart = start0;
  let ds = start0;

  // Patch only items whose position actually changes this frame (plus
  // restores of previously shifted ones): dragging one cue must not rebuild
  // hundreds of unmoved neighbors on every mousemove.
  //
  // On a gap-closing lane the lifted item rides along too (`selfStart`): the
  // store mirrors the previewed layout every frame — the landing slot while
  // home, the parked spot while hovering other tracks — so the doc stays
  // overlap-free at every instant a mid-drag autosave could catch it. The
  // ghost is what the user sees, so the transient self-moves never show.
  let selfAt = start0;
  const shifted = new Map<string, number>();
  const applyMoves = (
    startFor: (x: (typeof rest)[number]) => number,
    selfStart?: number
  ) => {
    const patches: Patch<LaneRaw>[] = [];
    for (const x of rest) {
      const want = startFor(x);
      const cur = shifted.get(x.view.id) ?? x.view.start;
      if (Math.abs(want - cur) > 1e-9) {
        patches.push(ad.movePatch(x.raw, want));
        if (Math.abs(want - x.view.start) > 1e-9) shifted.set(x.view.id, want);
        else shifted.delete(x.view.id);
      }
    }
    if (ad.closesGap && selfStart !== undefined && Math.abs(selfStart - selfAt) > 1e-9) {
      patches.push(ad.movePatch(raw0, selfStart));
      selfAt = selfStart;
    }
    if (patches.length) ad.apply(patches);
  };
  const restRestore = () => applyMoves((x) => x.view.start, start0);

  startDrag(e, {
    onMove: (dx, dy, ev) => {
      if (!live && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      live = true;
      refDrag?.move(ev);
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        if (ev.clientX > r.right - 36) scroller.scrollLeft += 14;
        else if (ev.clientX < r.left + 36) scroller.scrollLeft -= 14;
      }
      const effDx = dx + ((scroller?.scrollLeft ?? sc0) - sc0);
      ds = Math.max(0, start0 + effDx / ui.pps);
      const pointerTime = grabTime + effDx / ui.pps;
      const rows = ui.rows();
      const ghostY = dy - (homeTop(rows) - rowTop0);
      // The row under the pointer takes the item; past either edge of the
      // band a new row opens. Single-lane kinds stay on their own row.
      targetRow = ad.multiLane ? resolveRow(rows, ev.clientY, targetRow, edges) : ui.homeRow;
      // Which lane to part/collide on: multi-lane rows are display indexes
      // into the compacted used-lane list (a row past either end is a
      // brand-new lane with no neighbors); single-lane kinds stay on their
      // own lane — their row number is not an index into that list.
      const lane = ad.multiLane
        ? targetRow < 0
          ? -Infinity
          : targetRow < usedLanes.length
            ? usedLanes[targetRow]
            : Infinity
        : self.lane;

      // Snap whichever edge of the moving item lands nearest a logical time.
      let start = ds;
      let guide: number | null = null;
      if (!snapHeldOff(ev)) {
        const end = start + len;
        let best = { d: tol, start, px: null as number | null };
        for (const T of targets) {
          if (Math.abs(start - T) < best.d)
            best = { d: Math.abs(start - T), start: T, px: leftGuide(T, ui.pps) };
          if (Math.abs(end - T) < best.d)
            best = { d: Math.abs(end - T), start: T - len, px: rightGuide(T, ui.pps) };
        }
        if (best.px !== null) {
          start = Math.max(0, best.start);
          guide = best.px;
        }
      }
      // The aimed row's neighbors part around the cursor. Order comes from
      // the original midpoints, so a lifted item keeps its spot until the
      // pointer truly crosses a neighbor's middle; the runs themselves sit at
      // their resting spots (closed on gap-closing lanes).
      const part = partAround(
        rest.filter((x) => x.view.lane === lane),
        pointerTime,
        start,
        len,
        restAt
      );
      if (part.clamped) guide = null;
      slotStart = part.slotStart;
      ui.onSnap(guide);
      // On a gap-closing lane the lifted item rides its slot while home and
      // parks past the healed run while it aims at another row, so the doc
      // never holds two items on one span.
      applyMoves(part.at, targetRow === ui.homeRow ? slotStart : parked);
      ui.onDrag({
        kind,
        id,
        targetRow,
        ghostX: ds * ui.pps,
        ghostY,
        slotStart,
        len,
      });
    },
    onUp: (_dx, _dy, moved) => {
      ui.onSnap(null);
      ui.onDrag(null);
      if (live && refDrag?.drop()) {
        // A reference zone took the asset; undo every transient slide.
        restRestore();
        return;
      }
      if (!live || !moved) return;
      ad.apply([ad.movePatch(raw0, slotStart)]);
      ad.afterMove?.(raw0, slotStart - start0);
      commitRow(kind, id, targetRow);
      ad.onMoved?.(s);
    },
  });
}

/** The display rows a kind shows, top first — the same order the timeline
 * paints, so a row index means one thing to both. Overlay rows lead with the
 * effect rows; the video stack runs highest track first; every other kind is
 * plain lane order. */
function laneOrder(kind: LaneKind, s: S, lanes: number[]): number[] {
  if (kind === "overlay") return overlayLaneOrder(s.overlays);
  const used = [...new Set(lanes)].sort((a, b) => a - b);
  return ADAPTERS[kind].rowsDescend ? used.reverse() : used;
}

/** The lane a display row names once the drag lands there: a row in use, or
 * a brand-new lane past either end of the band — one clear of every lane in
 * use on the side the band grows that way — which the contiguous renumber
 * after the move folds back into 0..n-1. `beyond` counts rows past the end
 * for a group whose members straddle the edge. */
function laneAtRow(kind: LaneKind, used: number[], row: number): number {
  if (row >= 0 && row < used.length) return used[row];
  const lo = Math.min(0, ...used) - 1;
  const hi = Math.max(-1, ...used) + 1;
  const beyond = row < 0 ? -row - 1 : row - used.length;
  const pastTop = row < 0;
  const up = ADAPTERS[kind].rowsDescend ? pastTop : !pastTop;
  return up ? hi + beyond : lo - beyond;
}

/** Land a dragged item on a display row: a row past either end becomes a
 * brand-new lane, then lanes renumber contiguous so an emptied one
 * collapses. The move's pointer-down already checkpointed history, so the
 * whole gesture is one undo step. */
export function commitRow(kind: LaneKind, id: string, targetRow: number) {
  const s = useEditor.getState();
  const ad = ADAPTERS[kind];
  if (!ad.multiLane || !ad.lanePatch) return;
  const raws = ad.raws(s);
  const views = raws.map((r) => ad.view(r));
  const used = laneOrder(kind, s, views.map((v) => v.lane));
  const cur = views.find((v) => v.id === id);
  if (!cur || targetRow === used.indexOf(cur.lane)) return;
  const lane = laneAtRow(kind, used, targetRow);
  const moved = views.map((v) => (v.id === id ? lane : v.lane));
  const usedNext = [...new Set(moved)].sort((a, b) => a - b);
  const remap = new Map(usedNext.map((l, i) => [l, i]));
  ad.apply(raws.map((r, i) => ad.lanePatch!(r, remap.get(moved[i]) ?? 0)));
}

/**
 * Land a new item on a display row of a multi-lane band — the row under a
 * drop, or one past either edge — by the lane arithmetic a lane drag commits
 * with, so a drop and a drag open rows the same way. `add` places the item
 * on the lane the row names. A row opened past the top first moves the whole
 * band down one, and the band is renumbered from 0 once the item has landed,
 * the way a committed drag leaves it. One undo step.
 */
export function landOnRow(kind: LaneKind, row: number, add: (lane: number) => void): void {
  const s = useEditor.getState();
  const ad = ADAPTERS[kind];
  if (!ad.multiLane || !ad.lanePatch) {
    add(0);
    return;
  }
  const raws = ad.raws(s);
  const views = raws.map((r) => ad.view(r));
  const used = laneOrder(kind, s, views.map((v) => v.lane));
  let lane = laneAtRow(kind, used, row);
  s.beginHistoryBatch();
  try {
    if (lane < 0) {
      const lift = -lane;
      ad.apply(raws.map((r, i) => ad.lanePatch!(r, views[i].lane + lift)));
      lane = 0;
    }
    add(lane);
    const after = ad.raws(useEditor.getState());
    const lanes = after.map((r) => ad.view(r).lane);
    const usedNext = [...new Set(lanes)].sort((a, b) => a - b);
    if (usedNext.some((l, i) => l !== i)) {
      const remap = new Map(usedNext.map((l, i) => [l, i]));
      ad.apply(after.map((r, i) => ad.lanePatch!(r, remap.get(lanes[i]) ?? 0)));
    }
  } finally {
    s.endHistoryBatch();
  }
}

export interface LaneTrimUI {
  pps: number;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap(x: number | null): void;
}

/** Resize an item from either edge, with snapping, neighbor pushing, source
 * bounds for media, and a rubber-band + spring-back at each edge's bound (the
 * left edge's floor, the right edge's ceiling). */
export function startLaneTrim(
  e: React.PointerEvent,
  kind: LaneKind,
  id: string,
  side: "l" | "r",
  ui: LaneTrimUI
) {
  // Primary button only, same as the move grab.
  if (e.button !== 0) return;
  settleSnapBack();
  clearOvershoot();
  // The bar the handle sits on, for the drawn give at the head of the
  // timeline. Read now: the synthetic event's target is gone by the time the
  // move callbacks run.
  const bar = (e.currentTarget as HTMLElement).parentElement;
  const s = useEditor.getState();
  if (s.readOnly) return;
  const ad = ADAPTERS[kind];
  const raw0 = ad.raws(s).find((r) => ad.view(r).id === id);
  if (!raw0) return;
  const self = ad.view(raw0);
  s.select({ kind: laneSelectionKind(kind), id });
  // Grabbing an edge pauses playback so the trim isn't fighting a moving playhead.
  if (s.playing) s.setPlaying(false);
  s.pushHistory();
  // A trim leaves the source where it is, so this item's own beats are targets
  // like any other: "cut on the beat" is the whole point of the grid.
  const targets = snapTargets(s, kind, id, true);
  const tol = SNAP_PX / ui.pps;
  const sameLane = ad
    .raws(s)
    .map((r) => ({ raw: r, view: ad.view(r) }))
    .filter((x) => x.view.id !== id && x.view.lane === self.lane);
  // While track 0 is the only video track, a spine trim ripples: everything
  // past the clip's tail — clips, titles, captions, soundtrack — rides the
  // moved edge in both directions, every gap keeping its width. With overlay
  // video tracks present the engine is null (the delete gate) and the trim
  // keeps its own track's push rules.
  const ripple =
    kind === "video" && self.lane === 0
      ? (startTrimRipple(s, id, self.start + self.len) as {
          move: (shift: number, clipPatches: Patch<LaneRaw>[]) => void;
          settle: (close?: { at: number; shift: number }) => void;
        } | null)
      : null;
  // The clip layout the gesture started from, so a trim with no ripple engine
  // behind it can still map the bars onto where it left the cuts.
  const clips0 = kind === "video" && self.lane === 0 ? s.clips : null;
  /** Close the gesture: the ripple settles the document when there is one,
   * and either way the transition bars re-seat onto the cuts the trim moved.
   * A dissolve follows its cut whether or not the project has overlay tracks. */
  const settle = (close?: { at: number; shift: number }) => {
    if (ripple) {
      ripple.settle(close);
      return;
    }
    if (!clips0) return;
    const st = useEditor.getState();
    if (st.transitions.length)
      useEditor.setState({ transitions: reanchorTransitions(clips0, st.clips, st.transitions) });
  };

  if (side === "l") {
    const start0 = self.start;
    const len0 = self.len;
    const maxStart = start0 + len0 - ad.minLen;
    // Items before this one (start-ordered), at their original spots. The
    // edge grows freely into the open gap; past the neighbor it shoves the
    // run left, closing gap after gap until everything sits flush against 0 —
    // plus a media item's own floor: the edge can't reveal earlier than its
    // first sample.
    const leaders = sameLane
      .filter((x) => x.view.start < start0 - 1e-3)
      .sort((a, b) => a.view.start - b.view.start);
    const prevEnd = leaders.reduce((m, l) => Math.max(m, l.view.start + l.view.len), 0);
    const runFloor = leaders.reduce((sum, l) => sum + l.view.len, 0);
    const srcFloor = ad.leftFloor(s, raw0);
    const floor = Math.max(runFloor, srcFloor);
    const free = Math.max(prevEnd, srcFloor);
    // With the edge pinned at the floor, a media item that still has source
    // head keeps revealing: `in` walks back toward the first sample, the tail
    // grows, and the followers get pushed right — the mirror of the right
    // edge's run push.
    const reveals = !!ad.revealLeftPatch && srcFloor < floor - 1e-9;
    const followers = sameLane
      .filter((x) => x.view.start >= self.start)
      .sort((a, b) => a.view.start - b.view.start);
    const nextStart = followers.length ? followers[0].view.start : Infinity;
    const selfPatch = (start: number, reveal: number) =>
      ad.revealLeftPatch ? ad.revealLeftPatch(raw0, start, reveal) : ad.trimLeftPatch(raw0, start);
    const moved = new Map<string, number>();
    let lastDelta = 0;
    startDrag(e, {
      onMove: (dx, _dy, ev) => {
        settleSnapBack();
        const desired = Math.min(maxStart, start0 + dx / ui.pps);
        let start: number;
        let reveal: number;
        paintOvershoot(bar, 0);
        if (desired >= free) {
          // Room to the left: grow freely, snapping to logical times.
          start = desired;
          const hit = snapHeldOff(ev) ? null : nearestSnap(start, targets, tol);
          if (hit !== null && hit >= free && hit <= maxStart) {
            start = hit;
            ui.onSnap(leftGuide(hit, ui.pps));
          } else ui.onSnap(null);
          reveal = start;
        } else if (desired >= floor) {
          // Pushing: shove the leader run left, closing its gaps.
          start = desired;
          reveal = start;
          ui.onSnap(null);
        } else if (reveals && desired >= srcFloor) {
          // Pinned reveal: the edge holds at the floor while the source keeps
          // walking back and the tail grows into the followers.
          start = floor;
          reveal = desired;
          ui.onSnap(null);
        } else {
          // Out of room and out of source: drag with resistance, spring back.
          const bound = reveals ? srcFloor : floor;
          const sprung = floor - rubberBand((bound - desired) * ui.pps, RUBBER_PX) / ui.pps;
          start = Math.max(0, sprung);
          // Whatever the wall at 0 refused to give, the bar gives on screen.
          paintOvershoot(bar, (start - sprung) * ui.pps);
          reveal = Math.max(desired, srcFloor);
          ui.onSnap(null);
        }
        // Re-lay the leaders right-to-left from their resting spots: each one
        // slides only as far as the pushed edge (or the item it now abuts)
        // forces it, so a retreating drag lets the run flow back. Unmoved
        // leaders get no patch (they'd re-render for nothing).
        const patches = [selfPatch(start, reveal)];
        let limit = Math.max(start, runFloor);
        for (let i = leaders.length - 1; i >= 0; i--) {
          const l = leaders[i];
          const end = Math.min(l.view.start + l.view.len, limit);
          const ns = end - l.view.len;
          const cur = moved.get(l.view.id) ?? l.view.start;
          if (Math.abs(ns - cur) > 1e-9) {
            patches.push(ad.movePatch(l.raw, ns));
            if (Math.abs(ns - l.view.start) > 1e-9) moved.set(l.view.id, ns);
            else moved.delete(l.view.id);
          }
          limit = ns;
        }
        // The tail: fixed while the edge itself moves, growing once the
        // reveal is on. The rubber overshoot gives visually without pulling
        // the run back, so springing back needs no re-lay.
        const end = ad.revealLeftPatch
          ? Math.max(start, floor) + len0 + (start0 - reveal)
          : start0 + len0;
        if (ripple) {
          ripple.move(end - (start0 + len0), patches);
        } else {
          const delta = Math.max(0, end - nextStart);
          if (delta !== lastDelta) {
            patches.push(...followers.map((f) => ad.movePatch(f.raw, f.view.start + delta)));
            lastDelta = delta;
          }
          ad.apply(patches);
        }
      },
      onUp: () => {
        ui.onSnap(null);
        releaseOvershoot();
        const cur = ad.raws(useEditor.getState()).find((r) => ad.view(r).id === id);
        const from = cur ? ad.view(cur).start : floor;
        if (from >= floor - 1e-4) {
          // Settled within the room. A head trimmed to the right left its
          // trimmed footage as a gap; the ripple closes it, pulling the clip
          // and everything after back onto the footage that survives.
          settle(from > start0 + 1e-4 ? { at: start0, shift: start0 - from } : undefined);
          return;
        }
        // Elastic spring back to the floor. `finish` lands the floor exactly,
        // so an interrupting gesture settles rather than strands the trim.
        // The rubber engages only past the source floor, so the sprung patch
        // keeps the full reveal.
        const t0 = performance.now();
        const finish = () => {
          ad.apply([selfPatch(floor, srcFloor)]);
          settle();
        };
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / 240);
          const v = Math.max(0, from + (floor - from) * easeOutBack(p));
          ad.apply([selfPatch(p < 1 ? v : floor, srcFloor)]);
          snapBack = p < 1 ? { raf: requestAnimationFrame(step), finish } : null;
          if (p >= 1) settle();
        };
        snapBack = { raf: requestAnimationFrame(step), finish };
      },
    });
    return;
  }

  const end0 = self.start + self.len;
  const minEnd = self.start + ad.minLen;
  // The ceiling: the last sample a media item can reveal (Infinity for text
  // and cues, which have no source to run out of). The edge grows freely up
  // to it, then rubber-bands past with resistance and springs back on release
  // — mirroring the left edge's floor.
  const ceil = self.start + ad.maxLen(s, raw0);
  // Items after this one, at their original spots: extending the edge past
  // the first of them pushes the whole run right (their gaps preserved);
  // pulling back lets them return.
  const followers = sameLane
    .filter((x) => x.view.start >= self.start)
    .sort((a, b) => a.view.start - b.view.start);
  const nextStart = followers.length ? followers[0].view.start : Infinity;
  let lastDelta = 0;
  startDrag(e, {
    onMove: (dx, _dy, ev) => {
      settleSnapBack();
      const desired = Math.max(minEnd, end0 + dx / ui.pps);
      let end: number;
      if (desired <= ceil) {
        // Room to grow: snap to logical times within the ceiling.
        end = desired;
        const hit = snapHeldOff(ev) ? null : nearestSnap(end, targets, tol);
        if (hit !== null && hit > minEnd && hit <= ceil) {
          end = hit;
          ui.onSnap(rightGuide(end, ui.pps));
        } else ui.onSnap(null);
      } else {
        // Past the ceiling: drag with resistance and spring back on release.
        end = ceil + rubberBand((desired - ceil) * ui.pps, RUBBER_PX) / ui.pps;
        ui.onSnap(null);
      }
      // Followers respond only to travel up to the ceiling, so the overshoot
      // gives visually without shoving the run — and springing back needs no
      // re-lay, just as packed leaders hold at the floor on the left edge.
      if (ripple) {
        // The document rides the edge both ways, every gap keeping its width.
        ripple.move(Math.min(end, ceil) - end0, [ad.trimRightPatch(raw0, end)]);
      } else {
        const delta = Math.max(0, Math.min(end, ceil) - nextStart);
        const run =
          delta === lastDelta
            ? []
            : followers.map((f) => ad.movePatch(f.raw, f.view.start + delta));
        lastDelta = delta;
        ad.apply([ad.trimRightPatch(raw0, end), ...run]);
      }
    },
    onUp: () => {
      ui.onSnap(null);
      const cur = ad.raws(useEditor.getState()).find((r) => ad.view(r).id === id);
      if (!cur) {
        settle();
        return;
      }
      const v = ad.view(cur);
      const from = v.start + v.len;
      if (from <= ceil + 1e-4) {
        settle();
        return; // settled within the room
      }
      // Elastic spring back to the ceiling. `finish` lands it exactly, so an
      // interrupting gesture settles rather than strands an over-ceiling trim.
      const t0 = performance.now();
      const finish = () => {
        ad.apply([ad.trimRightPatch(raw0, ceil)]);
        settle();
      };
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 240);
        const e2 = from + (ceil - from) * easeOutBack(p);
        ad.apply([ad.trimRightPatch(raw0, p < 1 ? e2 : ceil)]);
        snapBack = p < 1 ? { raf: requestAnimationFrame(step), finish } : null;
        if (p >= 1) settle();
      };
      snapBack = { raf: requestAnimationFrame(step), finish };
    },
  });
}
