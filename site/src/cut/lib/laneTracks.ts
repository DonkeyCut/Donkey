"use client";

import { retimeOf } from "@donkeycut/effects-kit";

/**
 * The lane-track coordinator: the one place for how items on the timeline's
 * free-positioned tracks behave. Audio, titles, upper video layers, and
 * subtitle cues all route their pointer gestures through here, so selection,
 * moving, resizing, collision, and snapping work identically everywhere — and
 * a new track type gets every behavior by writing one small adapter.
 *
 * The shared behaviors:
 * - Grab: cmd/shift toggles the multi-selection; a plain grab selects the
 *   item and moves the playhead under the pointer.
 * - Move: the bar ghosts under the pointer while same-lane neighbors part
 *   around the landing slot; either edge snaps to logical times; on
 *   multi-lane kinds a vertical drag retracks the item, one row past the end
 *   opens a new track, and lanes stay contiguous so empty ones collapse.
 * - Resize: edges snap; growing into a neighbor pushes its whole run along;
 *   each edge rubber-bands past its source bound and springs back on release —
 *   the left past its floor (timeline start, packed leaders, or a media item's
 *   first sample), the right past its ceiling (the last sample it can reveal).
 * - Placement collision: adding/pasting slides to the next free slot on the
 *   lane — the store's `nextFreeStart` is that one primitive.
 * - Cut: the store's `splitAtPlayhead` slices whichever kind is selected.
 *
 * The video tracks keep their richer verticality (lifting between tracks,
 * insert zones, dropping onto track 0) by passing a `vertical` strategy to
 * the move gesture; everything else about them is the shared behavior.
 */

import type React from "react";
import { refFromAsset, startPointerRefDrag } from "./assetRef";
import { startDrag } from "./drag";
import { additiveClick, snapHeldOff } from "./hostKeys";
import { track0Clips, clipLen, getClipSpans, moveOverlayGroup, nextFreeStart, overlayLaneOrder, overlayLayers, projectDuration, reanchorTransitions, startTrimRipple, useEditor } from "./store";
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

// A drag lane. "clip" is track 0, "overlayClip" a layer track —
// distinct adapters, but both select as a plain video-clip selection.
// "overlay" is the title lanes: every overlay element kind rides one adapter.
export type LaneKind = "clip" | "audio" | "overlay" | "overlayClip" | "cue";

/** The Selection kind a lane maps to. Track-0 and layer video lanes both select
 * as `"clip"` — a video clip is a video clip whatever track it sits on. */
const laneSelectionKind = (kind: LaneKind): NonNullable<Selection>["kind"] =>
  kind === "overlayClip" ? "clip" : kind;

/** The doc structure behind a lane kind. Track 0 and the layer tracks are two
 * lane kinds over one clip list, so collision and identity both key on the
 * structure, never the adapter. */
type LaneStructure = "video" | "audio" | "overlay" | "cue";
const structureOf = (kind: LaneKind): LaneStructure =>
  kind === "clip" || kind === "overlayClip" ? "video" : kind;

/** Visual gutter between adjacent clips; time math stays exact. */
export const CLIP_GAP = 4;
/** Pull a dragged or resized edge to a logical time within this many px. */
export const SNAP_PX = 6;
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
  leftFloor(raw: T): number;
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
  /** After a committed move (e.g. keep cues sorted). */
  onMoved?(): void;
  /** After a committed move, shift companions that ride along — a grouped
   * overlay's peers keep their relative timing. Same undo step. */
  afterMove?(raw: T, delta: number): void;
}

/** The asset's beats inside a media item's trimmed range, in timeline
 * seconds. Beats live on the asset in source seconds, so every clip showing
 * the source maps its own window of them. */
function mediaBeatTimes(
  s: S,
  c: { assetId: string; start: number; in: number; out: number; speed?: number }
): number[] {
  const beats = s.assets.find((a) => a.id === c.assetId)?.beats?.beats;
  if (!beats?.length) return [];
  const rt = retimeOf(c);
  const times: number[] = [];
  for (const b of beats) if (b >= c.in && b <= c.out) times.push(c.start + rt.tAt(b));
  return times;
}

function videoMaxLen(s: S, c: VideoClip): number {
  const a = s.assets.find((x) => x.id === c.assetId);
  // A still has no source length, so its clip can stretch to any duration.
  if (a?.type === "image") return Infinity;
  return retimeOf({ ...c, out: a?.duration ?? c.out }).len;
}

const clipAdapter: LaneAdapter<VideoClip> = {
  minLen: 0.15,
  // Verticality is the video placement system (upper tracks and insert
  // zones), fed in as the move gesture's `vertical` strategy.
  multiLane: false,
  raws: (s) => track0Clips(s.clips),
  view: (c) => ({ id: c.id, start: c.start, len: clipLen(c), lane: 0 }),
  apply: (patches) => useEditor.getState().updateClipsTransient(patches),
  movePatch: (c, start) => ({ id: c.id, patch: { start } }),
  trimLeftPatch: (c, newStart) => ({
    id: c.id,
    patch: { start: newStart, in: retimeOf(c).srcAt(newStart - c.start) },
  }),
  trimRightPatch: (c, newEnd) => ({
    id: c.id,
    patch: { out: retimeOf(c).srcAt(newEnd - c.start) },
  }),
  revealLeftPatch: (c, start, reveal) => ({
    id: c.id,
    patch: { start, in: retimeOf(c).srcAt(reveal - c.start) },
  }),
  leftFloor: (c) => Math.max(0, c.start + retimeOf(c).tAt(0)),
  maxLen: videoMaxLen,
  closesGap: true,
  assetOf: (s, c) => s.assets.find((x) => x.id === c.assetId),
  beatTimes: mediaBeatTimes,
  onMoved: () => useEditor.getState().sortClips(),
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
    patch: { start: newStart, in: retimeOf(a).srcAt(newStart - a.start) },
  }),
  trimRightPatch: (a, newEnd) => ({
    id: a.id,
    patch: { out: retimeOf(a).srcAt(newEnd - a.start) },
  }),
  revealLeftPatch: (a, start, reveal) => ({
    id: a.id,
    patch: { start, in: retimeOf(a).srcAt(reveal - a.start) },
  }),
  leftFloor: (a) => Math.max(0, a.start + retimeOf(a).tAt(0)),
  maxLen: (s, a) =>
    retimeOf({ ...a, out: s.assets.find((x) => x.id === a.assetId)?.duration ?? a.out }).len,
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

const overlayClipAdapter: LaneAdapter<VideoClip> = {
  minLen: 0.15,
  // Verticality is the video placement system (tracks and insert zones), fed
  // in as the move gesture's `vertical` strategy.
  multiLane: false,
  raws: (s) => overlayLayers(s.clips),
  view: (c) => ({ id: c.id, start: c.start, len: clipLen(c), lane: c.track }),
  apply: (patches) => useEditor.getState().updateClipsTransient(patches),
  movePatch: (c, start) => ({ id: c.id, patch: { start } }),
  trimLeftPatch: (c, newStart) => ({
    id: c.id,
    patch: { start: newStart, in: retimeOf(c).srcAt(newStart - c.start) },
  }),
  trimRightPatch: (c, newEnd) => ({
    id: c.id,
    patch: { out: retimeOf(c).srcAt(newEnd - c.start) },
  }),
  revealLeftPatch: (c, start, reveal) => ({
    id: c.id,
    patch: { start, in: retimeOf(c).srcAt(reveal - c.start) },
  }),
  leftFloor: (c) => Math.max(0, c.start + retimeOf(c).tAt(0)),
  maxLen: videoMaxLen,
  closesGap: true,
  assetOf: (s, c) => s.assets.find((x) => x.id === c.assetId),
  beatTimes: mediaBeatTimes,
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
  clip: clipAdapter as unknown as LaneAdapter<LaneRaw>,
  audio: audioAdapter as unknown as LaneAdapter<LaneRaw>,
  overlay: textAdapter as unknown as LaneAdapter<LaneRaw>,
  overlayClip: overlayClipAdapter as unknown as LaneAdapter<LaneRaw>,
  cue: cueAdapter as unknown as LaneAdapter<LaneRaw>,
};

/** Logical times an edge can snap to: the timeline start, video track 0's
 * cut points and end, the playhead, every other lane item's edges across all
 * track kinds, and every beat of an asset's detected grid mapped through its
 * clips — a title can align to a music hit and vice versa. */
function snapTargets(s: S, kind: LaneKind, selfId: string, ownBeats = false): number[] {
  return snapTargetsExcluding(s, new Set([`${structureOf(kind)}:${selfId}`]), ownBeats);
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
      const self = excluded.has(`${structureOf(k)}:${v.id}`);
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
 * landing slot, and grow the lane stack while a new row is hovered. */
export interface LaneDrag {
  kind: LaneKind;
  id: string;
  /** Hovered display row. One past the end opens a new row below; -1 opens
   * one above the top, for a stack whose order is z-order. */
  targetRow: number;
  /** The rows this drag can land on, inclusive — the band paints exactly
   * these and nothing else. */
  minRow: number;
  maxRow: number;
  ghostX: number; // ghost left in px — follows the pointer
  ghostY: number; // ghost vertical offset in px from its resting row — follows the pointer
  slotStart: number; // resolved landing start, seconds
  len: number; // dragged item length, seconds
  /** Carried off its own lane set (an upper video layer headed elsewhere);
   * the home slot preview hides while away. */
  away?: boolean;
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

export interface LaneMoveUI<V = unknown> {
  pps: number;
  rowH: number;
  /** Display rows currently in use; targetRow may go one past to open a new track. */
  laneCount: number;
  /** Dragging above the top row opens a new one there. On for stacks where a
   * row's place is its z-order — the element rows — so the top is reachable. */
  topInsert?: boolean;
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
  /** Cross-structure verticality (upper video tracks): resolve where the
   * pointer is, preview non-home targets, and commit the drop. When absent,
   * vertical motion retracks among this kind's own lanes. */
  vertical?: {
    resolve(ev: PointerEvent): V;
    isHome(target: V): boolean;
    preview(target: V | null, start: number, len: number): void;
    commit(id: string, target: V, start: number): void;
    setActive?(active: boolean): void;
  };
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
    if (!c) return null;
    return { kind: c.track === 0 ? "clip" : "overlayClip", raw: c, id: c.id, start: c.start, len: clipLen(c), lane: c.track };
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
  ui: LaneMoveUI<unknown>
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

  const memberKeys = new Set(members.map((m) => `${structureOf(m.kind)}:${m.id}`));
  const targets = snapTargetsExcluding(s, memberKeys);
  const tol = SNAP_PX / ui.pps;
  // The set is rigid, so the earliest member is the whole group's floor.
  const minStart = Math.min(...members.map((m) => m.start));

  // Everyone else's resting spot on the lanes the group touches, grouped by
  // structure lane. Each frame re-lays these from rest, so a retreating drag
  // lets parted neighbors flow back.
  const laneKey = (m: { kind: LaneKind; lane: number }) => `${structureOf(m.kind)}:${m.lane}`;
  const lanesTouched = new Set(members.map(laneKey));
  const restOf = (kind: LaneKind) =>
    ADAPTERS[kind]
      .raws(s)
      .map((raw) => ({ kind, raw, view: ADAPTERS[kind].view(raw) }))
      .filter((x) => !memberKeys.has(`${structureOf(kind)}:${x.view.id}`));
  const rest = (
    [
      ...restOf("clip"),
      ...restOf("overlayClip"),
      ...restOf("audio"),
      ...restOf("overlay"),
      ...restOf("cue"),
    ] as { kind: LaneKind; raw: LaneRaw; view: LaneItem }[]
  ).filter((x) =>
    lanesTouched.has(
      `${structureOf(x.kind)}:${structureOf(x.kind) === "video" ? (x.raw as VideoClip).track : x.view.lane}`
    )
  );

  // Vertical retracking, only when the whole selection is one multi-lane kind.
  const oneKind = members.every((m) => m.kind === grabbed.kind);
  const vertical = oneKind && ADAPTERS[grabbed.kind].multiLane && !ui.vertical;
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
  const rowLo = vertical
    ? (ui.topInsert && !holdsRowAlone(0) ? -1 : 0) - Math.min(...rowsHeld)
    : 0;
  const rowHi = vertical
    ? ui.laneCount - (holdsRowAlone(ui.laneCount - 1) ? 1 : 0) - Math.max(...rowsHeld)
    : 0;
  const homeRow = vertical ? rowOf(grabbed.lane) : ui.homeRow;

  const scroller = (e.currentTarget as HTMLElement).closest<HTMLElement>("[data-tl-scroll]");
  const sc0 = scroller?.scrollLeft ?? 0;
  const rowEl = (e.currentTarget as HTMLElement).parentElement;
  const rowTop0 = rowEl?.getBoundingClientRect().top ?? 0;

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
    const cur = at.get(`${structureOf(kind)}:${id}`) ?? restStart;
    if (Math.abs(want - cur) <= 1e-9) return;
    const list = buckets.get(kind) ?? [];
    list.push(ADAPTERS[kind].movePatch(raw, want));
    buckets.set(kind, list);
    at.set(`${structureOf(kind)}:${id}`, want);
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
        .filter(
          (x) =>
            `${structureOf(x.kind)}:${structureOf(x.kind) === "video" ? (x.raw as VideoClip).track : x.view.lane}` === key
        )
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
      rowDelta = vertical ? Math.min(rowHi, Math.max(rowLo, Math.round(dy / ui.rowH))) : 0;
      ui.onSnap(guide);
      layout(dt);
      // Ghosts ride the raw pointer delta, clamped so the set's earliest
      // member holds at 0 — the same rigid floor the landing uses.
      const dtGhost = Math.max(-minStart, effDx / ui.pps);
      const ghostY = dy - (rowEl ? rowEl.getBoundingClientRect().top - rowTop0 : 0);
      ui.onDrag({
        kind: grabbed.kind,
        id: grabbed.id,
        targetRow: homeRow + rowDelta,
        minRow: homeRow + rowLo,
        maxRow: homeRow + rowHi,
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
      const structures = new Set(members.map((m) => structureOf(m.kind)));
      if (structures.has("video")) useEditor.getState().sortClips();
      if (structures.has("cue")) useEditor.getState().sortCues();
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
  const minUsed = Math.min(0, ...used);
  const maxUsed = Math.max(-1, ...used);
  const memberIds = new Set(members.map((m) => m.id));
  const laneFor = (row: number) =>
    row < 0 ? minUsed - 1 + (row + 1) : row < used.length ? used[row] : maxUsed + 1 + (row - used.length);
  const moved = views.map((v) =>
    memberIds.has(v.id) ? laneFor(used.indexOf(v.lane) + rowDelta) : v.lane
  );
  const usedNext = [...new Set(moved)].sort((a, b) => a - b);
  const remap = new Map(usedNext.map((l, i) => [l, i]));
  ad.apply(raws.map((r, i) => ad.lanePatch!(r, remap.get(moved[i]) ?? 0)));
}

/** Grab an item: select (or cmd/shift-toggle) it, then drag to move it along
 * and across lanes with parting, snapping, and lane retracking. */
export function startLaneMove<V = unknown>(
  e: React.PointerEvent,
  kind: LaneKind,
  id: string,
  ui: LaneMoveUI<V>
) {
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
      const key = `${structureOf(m.kind)}:${m.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      members.push(m);
    };
    for (const sel of s.multiSelection) if (sel) admit(memberOf(s, sel));
    for (const m of [...members]) {
      const gid = structureOf(m.kind) === "overlay" ? (m.raw as Overlay).groupId : undefined;
      if (!gid) continue;
      for (const peer of s.overlays.filter((o) => o.groupId === gid))
        admit(memberOf(s, { kind: "overlay", id: peer.id }));
    }
    const grabbed = members.find((m) => m.kind === kind && m.id === id) ?? members.find((m) => m.id === id);
    if (grabbed && members.length > 1) {
      startGroupMove(e, grabbed, members, ui as LaneMoveUI<unknown>);
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
  // The rows this drag can reach. A row past either end opens a brand-new
  // track, and from an outermost row an item alone there has nothing to open
  // on its side: the row it left collapses behind it, so the fresh one
  // renumbers straight back to the picture already on screen. Single-lane
  // kinds stay on the row they were grabbed from.
  const alone = !rest.some((x) => x.view.lane === self.lane);
  const minRow = ad.multiLane
    ? ui.topInsert && !(alone && ui.homeRow === 0)
      ? -1
      : 0
    : ui.homeRow;
  const maxRow = ad.multiLane
    ? ui.laneCount - (alone && ui.homeRow === ui.laneCount - 1 ? 1 : 0)
    : ui.homeRow;
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
  // track revealing itself), shifting this item's row in the layout. The
  // ghost offset subtracts that shift so it stays glued to the pointer.
  const rowEl = (e.currentTarget as HTMLElement).parentElement;
  const rowTop0 = rowEl?.getBoundingClientRect().top ?? 0;

  let live = false;
  let targetRow = ui.homeRow;
  let slotStart = start0;
  let ds = start0;
  let awayTarget: V | null = null;

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
      if (!live) ui.vertical?.setActive?.(true);
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
      const ghostY = dy - (rowEl ? rowEl.getBoundingClientRect().top - rowTop0 : 0);

      // Carried off its own lane set (an upper video layer headed to another
      // track, down to track 0, or an insert gap): neighbors flow back and
      // the placement system previews the target instead.
      if (ui.vertical) {
        const target = ui.vertical.resolve(ev);
        if (!ui.vertical.isHome(target)) {
          awayTarget = target;
          // The hole the clip left stays closed while it hovers other tracks.
          applyMoves(restAt, parked);
          ui.onSnap(null);
          ui.vertical.preview(target, ds, len);
          ui.onDrag({
            kind,
            id,
            targetRow: ui.homeRow,
            minRow,
            maxRow,
            ghostX: ds * ui.pps,
            ghostY,
            slotStart: ds,
            len,
            away: true,
          });
          return;
        }
        awayTarget = null;
        ui.vertical.preview(null, 0, 0);
      }

      // Vertical drag retracks the item, across the rows it can reach.
      targetRow = Math.min(maxRow, Math.max(minRow, ui.homeRow + Math.round(dy / ui.rowH)));
      // Which lane to part/collide on: multi-lane rows are display indexes
      // into the compacted used-lane list (a row past the end is a brand-new
      // lane with no neighbors); single-lane kinds stay on their own lane —
      // their row number is not an index into that list.
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
      // Same-lane neighbors part around the cursor: ones whose midpoint sits
      // left of the pointer keep their spot (the slot lands after them), the
      // rest slide right as a run to make room. Anchoring on the cursor rather
      // than the ghost's geometric center lets a clip take the front as soon as
      // you point past a neighbor's middle — a clip longer than the gap ahead
      // could never drag its own center that far left, so it used to snap back.
      // A cross-dissolve is contact, not intrusion: the slot may overlap the
      // neighbor before it by that neighbor's declared transition, and only
      // pushes the run after it once the overlap into its first item exceeds the
      // item's own declared transition.
      // Order comes from the original midpoints, so a lifted clip keeps its
      // spot until the pointer truly crosses a neighbor's middle; the runs
      // themselves sit at their resting spots (closed on gap-closing lanes).
      const others = rest
        .filter((x) => x.view.lane === lane)
        .sort((a, b) => a.view.start - b.view.start);
      const before = others.filter((x) => x.view.start + x.view.len / 2 <= pointerTime);
      const after = others.filter((x) => x.view.start + x.view.len / 2 > pointerTime);
      const prev = before[before.length - 1];
      const clampFloor = prev
        ? Math.max(
            0,
            ...before.slice(0, -1).map((b) => restAt(b) + b.view.len),
            restAt(prev) + prev.view.len
          )
        : 0;
      const clamped = Math.max(start, clampFloor);
      if (clamped !== start) guide = null;
      slotStart = clamped;
      const delta = after.length
        ? Math.max(0, clamped + len - restAt(after[0]))
        : 0;
      const pushed = new Set(after.map((x) => x.view.id));
      ui.onSnap(guide);
      applyMoves((x) => (pushed.has(x.view.id) ? restAt(x) + delta : restAt(x)), clamped);
      ui.onDrag({
        kind,
        id,
        targetRow,
        minRow,
        maxRow,
        ghostX: ds * ui.pps,
        ghostY,
        slotStart: clamped,
        len,
      });
    },
    onUp: (_dx, _dy, moved) => {
      ui.vertical?.setActive?.(false);
      ui.onSnap(null);
      ui.onDrag(null);
      if (live && refDrag?.drop()) {
        // A reference zone took the asset; undo every transient slide.
        restRestore();
        ui.vertical?.preview(null, 0, 0);
        return;
      }
      if (ui.vertical && awayTarget !== null && !ui.vertical.isHome(awayTarget)) {
        // The cross-track commit closes the source gap itself, from resting
        // starts — undo the live closure first or the run slides twice.
        restRestore();
        ui.vertical.commit(id, awayTarget, ds);
        return;
      }
      if (!live || !moved) return;
      ad.apply([ad.movePatch(raw0, slotStart)]);
      ad.afterMove?.(raw0, slotStart - start0);
      commitRow(kind, id, targetRow);
      ad.onMoved?.();
    },
  });
}

/** Land a dragged item on a display row: a row past the end becomes a
 * brand-new track after the current max, then lanes renumber to stay
 * contiguous so empty tracks collapse. The move's pointer-down already
 * checkpointed history, so the whole gesture is one undo step. */
/** The display rows a kind shows, top first — the same order the timeline
 * paints, so a row index means one thing to both. Overlay rows lead with the
 * effect rows; every other kind is plain lane order. */
function laneOrder(kind: LaneKind, s: S, lanes: number[]): number[] {
  if (kind === "overlay") return overlayLaneOrder(s.overlays);
  return [...new Set(lanes)].sort((a, b) => a - b);
}

function commitRow(kind: LaneKind, id: string, targetRow: number) {
  const s = useEditor.getState();
  const ad = ADAPTERS[kind];
  if (!ad.multiLane || !ad.lanePatch) return;
  const raws = ad.raws(s);
  const views = raws.map((r) => ad.view(r));
  const used = laneOrder(kind, s, views.map((v) => v.lane));
  const cur = views.find((v) => v.id === id);
  if (!cur || targetRow === used.indexOf(cur.lane)) return;
  // A row past either end opens a brand-new lane, clear of the ones in use;
  // the remap below renumbers everything back to 0..n-1.
  const lane =
    targetRow < 0
      ? Math.min(0, ...used) - 1
      : targetRow < used.length
        ? used[targetRow]
        : Math.max(-1, ...used) + 1;
  const moved = views.map((v) => (v.id === id ? lane : v.lane));
  const usedNext = [...new Set(moved)].sort((a, b) => a - b);
  const remap = new Map(usedNext.map((l, i) => [l, i]));
  ad.apply(raws.map((r, i) => ad.lanePatch!(r, remap.get(moved[i]) ?? 0)));
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
    kind === "clip"
      ? (startTrimRipple(s, id, self.start + self.len) as {
          move: (shift: number, clipPatches: Patch<LaneRaw>[]) => void;
          settle: (close?: { at: number; shift: number }) => void;
        } | null)
      : null;
  // The clip layout the gesture started from, so a trim with no ripple engine
  // behind it can still map the bars onto where it left the cuts.
  const clips0 = kind === "clip" ? s.clips : null;
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
    const srcFloor = ad.leftFloor(raw0);
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
