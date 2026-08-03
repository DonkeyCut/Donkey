"use client";

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
import { track0Clips, clipLen, getClipSpans, moveOverlayGroup, overlayLaneOrder, overlayLayers, projectDuration, useEditor } from "./store";
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
  /** Earliest timeline start the left edge can reveal to (media source floor). */
  leftFloor(raw: T): number;
  /** Longest timeline footprint the item can grow to (media source bound). */
  maxLen(s: S, raw: T): number;
  /** Write a committed lane number (multi-lane kinds only). */
  lanePatch?(raw: T, lane: number): Patch<T>;
  /** The media behind the item, so dragging it can feed reference drop zones. */
  assetOf?(s: S, raw: T): MediaAsset | undefined;
  /** After a committed move (e.g. keep cues sorted). */
  onMoved?(): void;
  /** After a committed move, shift companions that ride along — a grouped
   * overlay's peers keep their relative timing. Same undo step. */
  afterMove?(raw: T, delta: number): void;
}

const speedOf = (c: { speed?: number }) => (c.speed && c.speed > 0 ? c.speed : 1);

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
    patch: { start: newStart, in: c.in + (newStart - c.start) * speedOf(c) },
  }),
  trimRightPatch: (c, newEnd) => ({
    id: c.id,
    patch: { out: c.in + (newEnd - c.start) * speedOf(c) },
  }),
  leftFloor: (c) => Math.max(0, c.start - c.in / speedOf(c)),
  maxLen: (s, c) => {
    const a = s.assets.find((x) => x.id === c.assetId);
    // A still has no source length, so its clip can stretch to any duration.
    if (a?.type === "image") return Infinity;
    return ((a?.duration ?? c.out) - c.in) / speedOf(c);
  },
  assetOf: (s, c) => s.assets.find((x) => x.id === c.assetId),
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
    patch: { start: newStart, in: a.in + (newStart - a.start) * speedOf(a) },
  }),
  trimRightPatch: (a, newEnd) => ({
    id: a.id,
    patch: { out: a.in + (newEnd - a.start) * speedOf(a) },
  }),
  leftFloor: (a) => Math.max(0, a.start - a.in / speedOf(a)),
  maxLen: (s, a) =>
    ((s.assets.find((x) => x.id === a.assetId)?.duration ?? a.out) - a.in) / speedOf(a),
  lanePatch: (a, lane) => ({ id: a.id, patch: { lane: lane > 0 ? lane : undefined } }),
  assetOf: (s, a) => s.assets.find((x) => x.id === a.assetId),
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
    patch: { start: newStart, in: c.in + (newStart - c.start) * speedOf(c) },
  }),
  trimRightPatch: (c, newEnd) => ({
    id: c.id,
    patch: { out: c.in + (newEnd - c.start) * speedOf(c) },
  }),
  leftFloor: (c) => Math.max(0, c.start - c.in / speedOf(c)),
  maxLen: (s, c) =>
    ((s.assets.find((x) => x.id === c.assetId)?.duration ?? c.out) - c.in) / speedOf(c),
  assetOf: (s, c) => s.assets.find((x) => x.id === c.assetId),
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
 * cut points and end, the playhead, and every other lane item's edges across
 * all track kinds — a title can align to a music hit and vice versa. */
function snapTargets(s: S, kind: LaneKind, selfId: string): number[] {
  const pts = new Set<number>([0]);
  for (const sp of getClipSpans(s.clips, s.assets)) {
    // The joint: every pair meets at the footprint end — a transition is a
    // blend at that cut, never an overlap.
    pts.add(sp.start + sp.len);
  }
  pts.add(projectDuration(s));
  pts.add(s.currentTime);
  for (const k of Object.keys(ADAPTERS) as LaneKind[]) {
    for (const raw of ADAPTERS[k].raws(s)) {
      const v = ADAPTERS[k].view(raw);
      if (k === kind && v.id === selfId) continue;
      pts.add(v.start);
      pts.add(v.start + v.len);
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

/** The live move drag, published so the Timeline can render the ghost, the
 * landing slot, and grow the lane stack while a new row is hovered. */
export interface LaneDrag {
  kind: LaneKind;
  id: string;
  /** Hovered display row. One past the end opens a new row below; -1 opens
   * one above the top, for a stack whose order is z-order. */
  targetRow: number;
  ghostX: number; // ghost left in px — follows the pointer
  ghostY: number; // ghost vertical offset in px from its resting row — follows the pointer
  slotStart: number; // resolved landing start, seconds
  len: number; // dragged item length, seconds
  /** Carried off its own lane set (an upper video layer headed elsewhere);
   * the home slot preview hides while away. */
  away?: boolean;
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
  if (e.metaKey || e.shiftKey) {
    s.toggleSelect({ kind: laneSelectionKind(kind), id });
    return;
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
  const usedLanes = laneOrder(kind, s, [...rest.map((x) => x.view.lane), self.lane]);
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
  const shifted = new Map<string, number>();
  const applyMoves = (startFor: (x: (typeof rest)[number]) => number) => {
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
    if (patches.length) ad.apply(patches);
  };
  const restRestore = () => applyMoves((x) => x.view.start);

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
          restRestore();
          ui.onSnap(null);
          ui.vertical.preview(target, ds, len);
          ui.onDrag({
            kind,
            id,
            targetRow: ui.homeRow,
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

      // Vertical drag retracks the item; one row past the end opens a new one.
      targetRow = ad.multiLane
        ? Math.min(
            ui.laneCount,
            Math.max(ui.topInsert ? -1 : 0, ui.homeRow + Math.round(dy / ui.rowH))
          )
        : ui.homeRow;
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
      if (!ev.metaKey) {
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
      const others = rest
        .filter((x) => x.view.lane === lane)
        .sort((a, b) => a.view.start - b.view.start);
      const before = others.filter((x) => x.view.start + x.view.len / 2 <= pointerTime);
      const after = others.filter((x) => x.view.start + x.view.len / 2 > pointerTime);
      const prev = before[before.length - 1];
      const clampFloor = prev
        ? Math.max(
            0,
            ...before.slice(0, -1).map((b) => b.view.start + b.view.len),
            prev.view.start + prev.view.len
          )
        : 0;
      const clamped = Math.max(start, clampFloor);
      if (clamped !== start) guide = null;
      slotStart = clamped;
      const delta = after.length
        ? Math.max(0, clamped + len - after[0].view.start)
        : 0;
      const pushed = new Set(after.map((x) => x.view.id));
      ui.onSnap(guide);
      applyMoves((x) => (pushed.has(x.view.id) ? x.view.start + delta : x.view.start));
      ui.onDrag({ kind, id, targetRow, ghostX: ds * ui.pps, ghostY, slotStart: clamped, len });
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
  const targets = snapTargets(s, kind, id);
  const tol = SNAP_PX / ui.pps;
  const sameLane = ad
    .raws(s)
    .map((r) => ({ raw: r, view: ad.view(r) }))
    .filter((x) => x.view.id !== id && x.view.lane === self.lane);

  if (side === "l") {
    const start0 = self.start;
    const maxStart = start0 + self.len - ad.minLen;
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
    const floor = Math.max(runFloor, ad.leftFloor(raw0));
    const free = Math.max(prevEnd, ad.leftFloor(raw0));
    const moved = new Map<string, number>();
    startDrag(e, {
      onMove: (dx, _dy, ev) => {
        settleSnapBack();
        const desired = Math.min(maxStart, start0 + dx / ui.pps);
        let start: number;
        if (desired >= free) {
          // Room to the left: grow freely, snapping to logical times.
          start = desired;
          const hit = ev.metaKey ? null : nearestSnap(start, targets, tol);
          if (hit !== null && hit >= free && hit <= maxStart) {
            start = hit;
            ui.onSnap(leftGuide(hit, ui.pps));
          } else ui.onSnap(null);
        } else {
          // Pushing: past the floor it drags with resistance and springs back.
          start =
            desired >= floor
              ? desired
              : Math.max(
                  0,
                  floor - rubberBand((floor - desired) * ui.pps, RUBBER_PX) / ui.pps
                );
          ui.onSnap(null);
        }
        // Re-lay the leaders right-to-left from their resting spots: each one
        // slides only as far as the pushed edge (or the item it now abuts)
        // forces it, so a retreating drag lets the run flow back. Unmoved
        // leaders get no patch (they'd re-render for nothing).
        const patches = [ad.trimLeftPatch(raw0, start)];
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
        ad.apply(patches);
      },
      onUp: () => {
        ui.onSnap(null);
        const cur = ad.raws(useEditor.getState()).find((r) => ad.view(r).id === id);
        const from = cur ? ad.view(cur).start : floor;
        if (from >= floor - 1e-4) return; // settled within the room
        // Elastic spring back to the floor. `finish` lands the floor exactly,
        // so an interrupting gesture settles rather than strands the trim.
        const t0 = performance.now();
        const finish = () => ad.apply([ad.trimLeftPatch(raw0, floor)]);
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / 240);
          const v = Math.max(0, from + (floor - from) * easeOutBack(p));
          ad.apply([ad.trimLeftPatch(raw0, p < 1 ? v : floor)]);
          snapBack = p < 1 ? { raf: requestAnimationFrame(step), finish } : null;
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
        const hit = ev.metaKey ? null : nearestSnap(end, targets, tol);
        if (hit !== null && hit > minEnd && hit <= ceil) {
          end = hit;
          ui.onSnap(rightGuide(end, ui.pps));
        } else ui.onSnap(null);
      } else {
        // Past the ceiling: drag with resistance and spring back on release.
        end = ceil + rubberBand((desired - ceil) * ui.pps, RUBBER_PX) / ui.pps;
        ui.onSnap(null);
      }
      // Followers respond only to growth up to the ceiling, so the overshoot
      // gives visually without shoving the run — and springing back needs no
      // re-lay, just as packed leaders hold at the floor on the left edge.
      const delta = Math.max(0, Math.min(end, ceil) - nextStart);
      const run =
        delta === lastDelta
          ? []
          : followers.map((f) => ad.movePatch(f.raw, f.view.start + delta));
      lastDelta = delta;
      ad.apply([ad.trimRightPatch(raw0, end), ...run]);
    },
    onUp: () => {
      ui.onSnap(null);
      const cur = ad.raws(useEditor.getState()).find((r) => ad.view(r).id === id);
      if (!cur) return;
      const v = ad.view(cur);
      const from = v.start + v.len;
      if (from <= ceil + 1e-4) return; // settled within the room
      // Elastic spring back to the ceiling. `finish` lands it exactly, so an
      // interrupting gesture settles rather than strands an over-ceiling trim.
      const t0 = performance.now();
      const finish = () => ad.apply([ad.trimRightPatch(raw0, ceil)]);
      const step = (now: number) => {
        const p = Math.min(1, (now - t0) / 240);
        const e2 = from + (ceil - from) * easeOutBack(p);
        ad.apply([ad.trimRightPatch(raw0, p < 1 ? e2 : ceil)]);
        snapBack = p < 1 ? { raf: requestAnimationFrame(step), finish } : null;
      };
      snapBack = { raf: requestAnimationFrame(step), finish };
    },
  });
}
