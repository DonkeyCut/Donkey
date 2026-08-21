"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, ArrowUp, ArrowUpToLine, AudioLines, Blend, Check, Circle, Clapperboard, Copy, Diamond, Download, Droplets, EllipsisVertical, Expand, Eye, EyeOff, FolderOpen, FolderPlus, FoldHorizontal, Fullscreen, Loader2, Moon, MoreHorizontal, Pause, Play, Scissors, SkipBack, Sparkles, Sticker, Sun, Target, Trash2, Type, UnfoldHorizontal, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { SHAPE_CHIP_ICONS } from "@/cut/components/entityIcons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import {
  clearAssetDrag,
  clearElementDrag,
  draggedAssetId,
  draggedLibraryId,
  draggingAssetId,
  draggingElement,
  draggingLibrary,
  draggingTemplate,
  hasAssetDrag,
  hasElementDrag,
  hasLibraryDrag,
  hasTemplateDrag,
} from "@/cut/lib/assetDrag";
import { audioClipRefs, draggingRef, hasRefDrag, refFromAsset, type AssetRef } from "@/cut/lib/assetRef";
import { sendFrameToChat, type FrameGrabOrigin } from "@/cut/lib/chatIntake";
import { copyRefImage } from "@/cut/lib/refMedia";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import {
  addProjectTemplateToTimeline,
  addTemplateToProject,
  importLibraryAsset,
  libraryMediaUrl,
  saveAssetToLibrary,
} from "@/cut/lib/library";
import { originalSettings, type ExportDoc } from "@/cut/lib/exportClient";
import { useExports } from "@/cut/lib/exportStore";
import { isDragActive, startDrag, subscribeDragActive } from "@/cut/lib/drag";
import { CLIP_GAP, startLaneMove, startLaneTrim, type LaneDrag, type LaneKind } from "@/cut/lib/laneTracks";
import { downloadMedia, ensurePeaks, importImage, importStockMusic, importStockVideo, peekEdgeFrame, requestEdgeFrame, revealMedia, stripFailedFor, subscribeStripStatus } from "@/cut/lib/media";
import { planFilmstrip, type FilmTile } from "@/cut/lib/filmstrip";
import { track0Clips, laneGapAt, sameLane, type LaneRef, clipLen, clipSpeed, getClipSpans, overlayLaneOrder, overlayLayers, projectDuration, resolveTransitions, rippleInsert, useEditor } from "@/cut/lib/store";
import type { VideoTrackPlacement } from "@/cut/lib/store";
import { playheadAt, setSkim, skimAt, subscribePlayhead, usePlayhead, useSkim } from "@/cut/lib/playhead";
import { laneHidden, subtitleLaneCount } from "@/cut/lib/subtitles";
import { formatTime, formatTimecode } from "@/cut/lib/time";
import { EFFECT_LABELS } from "@donkeycut/effects-kit";
import { emptySubtitles, IMAGE_CLIP_SECONDS, SHAPE_LABELS, TRANSITION_DEFAULT_SECONDS, TRANSITION_MAX, TRANSITION_STYLE_LABELS, type ShapeKind } from "@/cut/lib/types";
import type { AudioClip, ClipSpan, ColorGrade, MediaAsset, Overlay, Selection, StickerOverlay, SubtitleCue, TimelineTransition, TransitionStyle, VideoClip } from "@/cut/lib/types";
import { isLottieAsset } from "@/cut/lib/lottieAssets";
import { gradeCssApprox } from "@donkeycut/effects-kit";
import { cn } from "@/lib/utils";

const TRANSITION_ICONS: Record<TransitionStyle, LucideIcon> = {
  crossfade: Blend,
  crosszoom: Expand,
  dipblack: Moon,
  dipwhite: Sun,
  blur: Droplets,
  pushleft: ArrowLeft,
  pushright: ArrowRight,
  pushup: ArrowUp,
  pushdown: ArrowDown,
  wipeleft: ArrowLeftToLine,
  wiperight: ArrowRightToLine,
  wipeup: ArrowUpToLine,
  wipedown: ArrowDownToLine,
  circleopen: Circle,
  circleclose: Target,
  splitopen: UnfoldHorizontal,
  splitclose: FoldHorizontal,
};

/** Video row height: the picture band plus the sound band under it. */
const VIDEO_H = 88;
/** How far past the top or bottom of the video stack a drag has to carry a
 * clip to open a new track. Every drop inside the stack lands on a row, which
 * opens room for it, so this reach is the one gesture that adds a track — and
 * it is long enough that drifting off a row while sliding along it never
 * does. */
const NEW_TRACK_PX = 24;
const OVERLAY_H = VIDEO_H; // every video track shares the same row height
/** Extra row height under a video row whose clips carry mask keys: room for
 * the key rail below the bars. The diamonds read as part of the clip, so the
 * row's separator line sits clear under them — a picked key's ring included —
 * and the next row keeps its usual distance below the line. */
const KEYRAIL_EXTRA = 20;
const AUDIO_H = 44;
/** The sound band along a video clip box's bottom edge. */
const WAVE_H = 24;
/** The picture band above it — the filmstrip's height. A clip with nothing to
 * play in the band (an image, a muted or silent video) drops the band and its
 * box stops at the filmstrip's edge. */
const FILM_H = VIDEO_H - 4 - WAVE_H;
/** The `mt-1.5` every row carries, so a row drag knows what one row's worth of
 * travel is. */
const ROW_GAP = 6;

/** The three bands whose rows reorder: the video stack, the element rows, and
 * the soundtrack lanes. Subtitle rows are language tracks, managed in the
 * panel, so they stay put. */
type RowBand = "video" | "overlay" | "audio";

/** A row being dragged to a new place in its own band. Rows are display
 * indices, 0 = the band's top row. The boxes are the band's rows measured in
 * screen space at the grab: the rows move while the drag runs, so hit-testing
 * against where they started is what keeps the target from flickering. */
interface RowDrag {
  band: RowBand;
  from: number;
  to: number;
  /** Pointer travel, clamped so the carried row stays inside its band. */
  dy: number;
  rows: { top: number; h: number }[];
  /** The viewport the landing outline draws across. */
  left: number;
  width: number;
}

/** Where row `r` shows while `d` is in flight: the carried row is at the
 * target, and the rows it passed close up behind it. */
function shownRow(d: RowDrag, r: number): number {
  if (r === d.from) return d.to;
  if (d.from < d.to) return r > d.from && r <= d.to ? r - 1 : r;
  return r >= d.to && r < d.from ? r + 1 : r;
}

/** The box the carried row will land in, in screen space. */
function landingBox(d: RowDrag): { top: number; h: number } {
  const held = d.rows[d.from];
  const seat = d.rows[d.to];
  return {
    top: d.to > d.from ? seat.top + seat.h - held.h : seat.top,
    h: held.h,
  };
}

/** Where a dragged video clip can land. Re-exported name for the store's
 * placement union (existing track, 0 included / newly-inserted track). */
type TrackTarget = VideoTrackPlacement;

/** Two placements point at the same drop. */
function samePlacement(a: TrackTarget | null, b: TrackTarget | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "track"
    ? a.track === (b as { track: number }).track
    : a.level === (b as { level: number }).level;
}
/** Video track 0 — the store's `clips` array — as a drop placement. */
const TRACK_ZERO: TrackTarget = { kind: "track", track: 0 };
const TEXT_H = 28;
const SUB_H = 22;
const RULER_H = 26;
const PAD_END = 320;
/** Breathing room on both sides so the playhead cap is never clipped. The left
 * one doubles as the gutter — the strip that stays put while the timeline
 * scrolls under it — so widening this widens the column controls will sit in. */
const PAD_SIDE = 20;

/** Zoom range, in timeline pixels per second of media. */
const ZOOM_MIN = 12;
const ZOOM_MAX = 800;
/** px/sec at which `dur` seconds fill a `width`-px viewport, with room spared
 * for the side padding. */
const fitZoom = (width: number, dur: number) => Math.max((width - 60) / dur, 0.01);
/** The slider's left end: zoomed all the way out, the project still fills at
 * least 70% of the viewport, so the timeline never shrinks into a corner. A
 * very short project caps at half of ZOOM_MAX to keep the slider some travel. */
const zoomFloor = (width: number, dur: number) =>
  dur > 0
    ? Math.min(Math.max((width * 0.7) / dur, 0.01), ZOOM_MAX / 2)
    : ZOOM_MIN;
/**
 * Zoom reads as a ratio — doubling px/sec feels like one step whether you start
 * at 20 or at 400 — so the slider travels in log space. A linear track would
 * spend its first sixth on every zoom anyone uses and the rest on extremes.
 */
const zoomToSlider = (pps: number, min: number) =>
  (Math.log(pps / min) / Math.log(ZOOM_MAX / min)) * 100;
const sliderToZoom = (pos: number, min: number) => min * (ZOOM_MAX / min) ** (pos / 100);

// A high-contrast selected state: a bright blue ring outside the box, a halo,
// and a raised stacking order, so a selected item reads clearly against its
// neighbours. The ring sits outside every kind of item alike, which is the
// only way it measures the same on all of them: a video clip's filmstrip
// covers its box, so an inner ring vanished under the thumbnails, while an
// audio, text or subtitle bar paints its own background and showed that same
// ring at full width on top of this one.
const SELECTED_SHADOW =
  "z-10 shadow-[0_0_0_2px_#0a84ff,0_2px_11px_rgba(10,132,255,0.6)]";

/**
 * Element bars carry their family's color: text purple, elements (shapes and
 * stickers) magenta, effects teal — the three places they come from, so a row
 * reads as what it holds before any label does. The drag highlights take the
 * carried item's color too, so a move keeps the same identity the whole way.
 *
 * Written out rather than composed, since Tailwind reads whole class names.
 */
type OverlayFamily = "text" | "element" | "effect";

/**
 * A place on the transition track a transition can sit: a cut between two
 * clips that touch, or an open edge — a clip's head or tail with nothing
 * against it, where the picture arrives from or leaves to nothing.
 *
 * `at` is the boundary itself (the cut, the head, the tail) and `len` the room
 * a transition takes there.
 */
type Anchor = { kind: "cut" | "in" | "out"; clipId: string; at: number; len: number };

/** One transition bar drawn on the row: the store object itself, the place it
 * resolved to (null while it sits inert), and how it reads. */
type XBar = {
  t: TimelineTransition;
  role: { kind: Anchor["kind"]; clipId: string } | null;
  label: string;
};

/** How far an anchor reaches while a bar is in flight, px. Inside it the drop
 * aligns to the anchor; outside it the bar lands exactly where it is. */
const XBAR_MAGNET_PX = 16;


const overlayFamily = (o: Overlay): OverlayFamily =>
  o.kind === "effect" ? "effect" : o.kind === "shape" || o.kind === "sticker" ? "element" : "text";

/** The stretch a panel element takes when dropped — `addElement`'s default
 * length — so the landing ghost matches what the drop makes. */
const ELEMENT_DROP_SECONDS = 3;

const FAMILY_STYLE: Record<
  OverlayFamily,
  { bar: string; row: string; rowIdle: string; slot: string }
> = {
  text: {
    bar: "bg-[#7B4BD1]",
    row: "border-[#7B4BD1]/70 bg-[#7B4BD1]/5",
    rowIdle: "border-[#7B4BD1]/25",
    slot: "bg-[#7B4BD1]/10 shadow-[inset_0_0_0_1.5px_rgba(123,75,209,0.5)]",
  },
  element: {
    bar: "bg-[#C43C87]",
    row: "border-[#C43C87]/70 bg-[#C43C87]/5",
    rowIdle: "border-[#C43C87]/25",
    slot: "bg-[#C43C87]/10 shadow-[inset_0_0_0_1.5px_rgba(196,60,135,0.5)]",
  },
  effect: {
    bar: "bg-[#0D8577]",
    row: "border-[#0D8577]/70 bg-[#0D8577]/5",
    rowIdle: "border-[#0D8577]/25",
    slot: "bg-[#0D8577]/10 shadow-[inset_0_0_0_1.5px_rgba(13,133,119,0.5)]",
  },
};

/** Width of the trim grab zone at each end of a bar — paired with the `w-`
 * in `trimHandle` below; anything else drawn on a bar keeps clear of it. */
const TRIM_W = 10;

const trimHandle =
  "tl-trim absolute top-0 bottom-0 z-3 w-[10px] cursor-ew-resize after:absolute after:top-1/2 after:left-[3px] after:h-[calc(100%-10px)] after:w-1 after:-translate-y-1/2 after:rounded-full after:bg-white after:opacity-0 after:shadow-[0_0_0_1px_rgba(0,0,0,0.35)] after:transition-opacity group-hover:after:opacity-90 hover:after:opacity-100";

/** On-timeline length a dropped image occupies (it has no intrinsic duration). */
const STILL_SECONDS = IMAGE_CLIP_SECONDS;

/** The resting track rail: a hairline under an occupied row so it reads as a
 * track, bleeding past the content's side padding to run edge to edge. */
const laneRail = (top: number, key?: React.Key) => (
  <div
    key={key}
    data-tl-rail
    className="pointer-events-none absolute h-px bg-border"
    style={{ top, left: -PAD_SIDE, right: -PAD_SIDE }}
  />
);

/** The resting-track pattern an empty project shows: the same hairline rails
 * the video rows draw, repeating downward. Shared by the scroll content and
 * the overscroll underlay so both paint the identical picture. */
const REST_RAILS = `repeating-linear-gradient(to bottom, transparent 0 ${VIDEO_H + 4}px, var(--border) ${VIDEO_H + 4}px ${VIDEO_H + 5}px, transparent ${VIDEO_H + 5}px ${VIDEO_H + 6}px)`;

/** The card-white ruler band with its baseline. Pinned wherever it paints —
 * the ruler stays put while the rows scroll, so its surface never follows the
 * vertical scroll either. */
function RulerBand() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 border-b border-border bg-card"
      style={{ height: RULER_H }}
    />
  );
}

/** The timeline with nothing on it: a hairline under each occupied row, and
 * the resting rails where a project has no rows yet.
 *
 * Painted twice, in the two places the tracks are not. Behind the scroller it
 * is what a rubber-band bounce reveals; in the pinned gutter it is what the
 * timeline scrolls under. Both draw from here so the surface cannot come apart
 * at either edge. Fills its parent, which is what positions it. */
function RestingSurface({
  railYs,
  empty,
  timelineH,
}: {
  railYs: number[];
  empty: boolean;
  timelineH: number;
}) {
  return (
    <>
      {railYs.map((y, i) => (
        <div key={i} className="absolute inset-x-0 h-px bg-border" style={{ top: y }} />
      ))}
      {empty && (
        <div
          className="absolute inset-x-0"
          style={{ top: RULER_H, height: timelineH, background: REST_RAILS }}
        />
      )}
    </>
  );
}

/** An asset type that lands as a video clip — footage or a still image. */
const isClipMedia = (t: string | undefined): t is "video" | "image" =>
  t === "video" || t === "image";

/** A sticker asset lands as a sticker element, never as a clip: it is a
 * cut-out to lay over the picture, so a drop on the timeline goes to the
 * element rows however it arrives. */
const stickerOf = (a: MediaAsset | undefined | null): MediaAsset | null =>
  a && a.origin === "sticker" ? a : null;

const draggedSticker = (): MediaAsset | null => {
  const id = draggingAssetId();
  return stickerOf(id ? useEditor.getState().assets.find((a) => a.id === id) : null);
};

/** The image ref being dragged (a stock tile), null for any other drag —
 * asset and library drags carry the ref MIME too but with video/audio kinds.
 * On the timeline it lands on video track 0 as a still image. */
function draggingStill(e: React.DragEvent): AssetRef | null {
  if (!hasRefDrag(e)) return null;
  const ref = draggingRef();
  return ref?.kind === "image" ? ref : null;
}

/** The stock-clip ref being dragged (a stock video tile), null for any other
 * drag — project and library videos carry their own MIMEs and are handled
 * first. On the timeline it imports into the project and lands as footage. */
function draggingStockVideo(e: React.DragEvent): AssetRef | null {
  if (!hasRefDrag(e)) return null;
  const ref = draggingRef();
  return ref?.scope === "stock" && ref.kind === "video" ? ref : null;
}

/** The stock-music ref being dragged (a sample-library card), null otherwise. On
 * the soundtrack it imports into the project and lands as an audio clip. */
function draggingStockMusic(e: React.DragEvent): AssetRef | null {
  if (!hasRefDrag(e)) return null;
  const ref = draggingRef();
  return ref?.scope === "stock" && ref.kind === "audio" ? ref : null;
}

export function Timeline() {
  const clips = useEditor((s) => s.clips);
  const audioClips = useEditor((s) => s.audioClips);
  // The composited layers (every clip off track 0), derived from the one
  // clip list — the timeline draws them as the tracks around track 0.
  const overlayClips = useMemo(() => overlayLayers(clips), [clips]);
  const overlays = useEditor((s) => s.overlays);
  const assets = useEditor((s) => s.assets);
  const pps = useEditor((s) => s.pxPerSec);
  const timelineH = useEditor((s) => s.timelineH);
  const multiSelection = useEditor((s) => s.multiSelection);
  const subtitles = useEditor((s) => s.subtitles);
  // An OS file drag carrying media lights the track area as a drop target.
  const fileDropHint = useEditor((s) => s.dropActive === "media");
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const timeAt = (clientX: number) => {
    const rect = innerRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / pps;
  };
  // Selection made elsewhere (a chat pill click) lands offscreen: scroll the
  // selected item's bar into view. In-view selections stay put.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!s.selection || s.selection === prev.selection) return;
        const scroller = scrollRef.current;
        const el = scroller?.querySelector(
          `[data-tl-sel="${s.selection.kind}:${s.selection.id}"]`
        );
        if (!scroller || !el) return;
        const r = el.getBoundingClientRect();
        const v = scroller.getBoundingClientRect();
        if (r.right < v.left) scroller.scrollLeft += r.left - v.left - 48;
        else if (r.left > v.right) scroller.scrollLeft += r.right - v.right + 48;
        if (r.top < v.top) scroller.scrollTop += r.top - v.top - 12;
        else if (r.bottom > v.bottom) scroller.scrollTop += r.bottom - v.bottom + 12;
      }),
    []
  );
  // The rail copies behind the scroller follow vertical scroll so they stay
  // glued under the live rails; overscroll can't move them, so the surface
  // runs unbroken through the bounce. (Horizontal position is moot — every
  // line is uniform across the full width.)
  const rulerUnderlayRef = useRef<HTMLDivElement>(null);
  // The left gutter paints that same surface out in front of the scroller, and
  // is glued to the content the same way — it is held out of the horizontal
  // scroll, not out of the vertical one.
  const gutterRef = useRef<HTMLDivElement>(null);
  const gutterFaceRef = useRef<HTMLDivElement>(null);
  const gutterShadowRef = useRef<HTMLDivElement>(null);
  // The track toggles ride the gutter column, glued to vertical scroll the
  // same way the gutter surface is.
  const gutterCtlRef = useRef<HTMLDivElement>(null);
  // The toolbar's editing tools and zoom fold into a menu when the bar cannot
  // hold them beside the transport. Both sides go at once — a bar with the
  // tools on the left and a menu on the right for the zoom alone would be a
  // third arrangement to reason about for no gain. The transport is what the
  // sides have to fit around, so its track is measured, not assumed.
  const barRef = useRef<HTMLDivElement>(null);
  const toolsFullRef = useRef<HTMLDivElement>(null);
  const toolsBareRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const transportRef = useRef<HTMLDivElement>(null);
  const [barLabels, setBarLabels] = useState(true);
  const [barTight, setBarTight] = useState(false);
  useEffect(() => {
    const bar = barRef.current;
    const full = toolsFullRef.current;
    const bare = toolsBareRef.current;
    const zoom = zoomRef.current;
    const transport = transportRef.current;
    if (!bar || !full || !bare || !zoom || !transport) return;
    const fitBar = () => {
      // Each side track is what is left of the bar once the transport has its
      // width, halved; the tools keep their own margin inside that.
      const side = (bar.clientWidth - transport.offsetWidth) / 2 - 10;
      // Labels first, the menu only once the icons alone have stopped fitting.
      setBarLabels(full.offsetWidth <= side);
      setBarTight(bare.offsetWidth > side || zoom.offsetWidth > side);
    };
    fitBar();
    // The bar for the window; the measuring rows for their own set changing —
    // Delete relabels with the selection count and Save template appears with
    // it — and the transport for the timecode growing an hours field.
    const ro = new ResizeObserver(fitBar);
    ro.observe(bar);
    ro.observe(full);
    ro.observe(bare);
    ro.observe(transport);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      const y = `translateY(${-el.scrollTop}px)`;
      if (rulerUnderlayRef.current) rulerUnderlayRef.current.style.transform = y;
      if (gutterRef.current) gutterRef.current.style.transform = y;
      if (gutterCtlRef.current) gutterCtlRef.current.style.transform = y;
      // Once the timeline has scrolled, the gutter has something running under
      // it — its face covers that, and the edge shadow says so. At rest both
      // stay hidden: the underlay already paints the same surface, and a clip
      // sitting at 0 keeps its selection ring whole.
      const scrolled = el.scrollLeft > 0;
      gutterFaceRef.current?.toggleAttribute("data-scrolled", scrolled);
      gutterShadowRef.current?.toggleAttribute("data-scrolled", scrolled);
    };
    sync();
    el.addEventListener("scroll", sync);
    return () => el.removeEventListener("scroll", sync);
  }, []);
  // The track rails are content-anchored, so the bounce drags them along and
  // cuts them off at the content edge just like the ruler. The underlay
  // repeats each rail as a static full-width line at the same height;
  // measuring the live rails after every render keeps the copies honest
  // against whatever rows the current layout (or an active drag) shows.
  const [railYs, setRailYs] = useState<number[]>([]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const ys = Array.from(
      el.querySelectorAll<HTMLElement>("[data-tl-rail]"),
      (r) => Math.round(r.getBoundingClientRect().top - box.top + el.scrollTop)
    );
    setRailYs((prev) =>
      prev.length === ys.length && prev.every((v, i) => v === ys[i]) ? prev : ys
    );
  });
  // Where each toggle-bearing row sits, measured the same way as the rails:
  // the rows live in the scrolled content, but the toggles are pinned in the
  // gutter, so they need the rows' content-space tops.
  const [gutterYs, setGutterYs] = useState<{
    video: { track: number; y: number; h: number }[];
    audioTop: number | null;
    textTop: number | null;
    subTop: number | null;
  }>({ video: [], audioTop: null, textTop: null, subTop: null });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const contentY = (sel: string) => {
      const r = el.querySelector<HTMLElement>(sel);
      return r ? Math.round(r.getBoundingClientRect().top - box.top + el.scrollTop) : null;
    };
    const video = Array.from(el.querySelectorAll<HTMLElement>("[data-tl-vrow]"), (r) => ({
      track: Number(r.dataset.tlVrow),
      y: Math.round(r.getBoundingClientRect().top - box.top + el.scrollTop),
      h: Math.round(r.getBoundingClientRect().height),
    }));
    const audioTop = contentY("[data-tl-arows]");
    const textTop = contentY("[data-tl-trows]");
    const subTop = contentY("[data-tl-srows]");
    setGutterYs((prev) =>
      prev.audioTop === audioTop &&
      prev.textTop === textTop &&
      prev.subTop === subTop &&
      prev.video.length === video.length &&
      prev.video.every(
        (v, i) => v.track === video[i].track && v.y === video[i].y && v.h === video[i].h
      )
        ? prev
        : { video, audioTop, textTop, subTop }
    );
  });
  // Measured width of the scroll viewport, so the ruler and tracks always draw
  // end-to-end no matter how wide the window is.
  const [viewportW, setViewportW] = useState(900);

  // Membership set so every track can highlight all selected items, not just
  // the primary one.
  const selKeys = useMemo(
    () => new Set(multiSelection.map((x) => (x ? `${x.kind}:${x.id}` : ""))),
    [multiSelection]
  );

  const spans = useMemo(() => getClipSpans(clips, assets), [clips, assets]);
  // A row whose clips carry mask keys grows by the rail band, so the diamonds
  // sit fully below the clips with the usual row gap kept under them.
  const railFor = (list: { clip: VideoClip }[]) =>
    list.some((sp) => sp.clip.mask?.kf?.length) ? KEYRAIL_EXTRA : 0;
  const rail0 = railFor(spans);
  // Per-upper-track spans: each track carries its own transitions, so its row
  // needs the same overlap-aware geometry (insets, badges) as track 0's.
  const overlayTrackSpans = useMemo(() => {
    const m = new Map<number, ClipSpan[]>();
    for (const c of overlayClips)
      if (!m.has(c.track)) m.set(c.track, getClipSpans(clips, assets, c.track));
    return m;
  }, [overlayClips, clips, assets]);
  const total = projectDuration({ clips, audioClips, overlays });
  const zoomMin = zoomFloor(viewportW, total);
  // Fill the viewport at minimum so a wide window never leaves the ruler/tracks
  // cut off; grow past it once the content is longer. While a trim/slide drag
  // is in flight, hold the width at its drag-start value so the scroll area
  // doesn't resize under the pointer; it commits on release.
  const dragging = useSyncExternalStore(subscribeDragActive, isDragActive, () => false);
  const liveContentW = Math.max(total * pps + PAD_END, viewportW - PAD_SIDE * 2, 600);
  const heldContentW = useRef(liveContentW);
  if (!dragging) heldContentW.current = liveContentW;
  const contentW = heldContentW.current;

  // Drop preview while dragging a media asset onto video track 0: where the
  // clip would land, how long it runs, and what the source looks like, so the
  // preview reads as the segment itself sliding along the row rather than an
  // empty slot.
  const [assetDrop, setAssetDrop] = useState<{
    t: number;
    len: number;
    ghost?: DropGhost;
    shifts?: { id: string; start: number }[];
  } | null>(null);
  // Kind of external media being dragged over the timeline (audio vs video).
  const [dropType, setDropType] = useState<"video" | "audio" | null>(null);
  // A video clip is being dragged (internal or external): reveals the
  // would-be new tracks past the stack's edges.
  const [videoDragging, setVideoDragging] = useState(false);
  // The pending drop preview: which track/gap, at what time, for how long —
  // and which resident clips slide right to open the room, so the row can
  // paint them parting ahead of the drop.
  const [overlayDrop, setOverlayDrop] = useState<{
    target: TrackTarget;
    t: number;
    len: number;
    shifts?: { id: string; start: number }[];
    /** External media paints its landing as the segment itself — filmstrip at
     * true length; without one the slot is the plain highlight (internal drags
     * already carry their own clip). */
    ghost?: DropGhost;
  } | null>(null);
  // Stage-x pixel a snapped title edge sits at, for the guide line (null = off).
  const [snapX, setSnapX] = useState<number | null>(null);
  const videoDragActive = videoDragging || dropType === "video";
  // The drop the pointer resolved to last, so a new track that has opened
  // under the pointer keeps its hold until the drag returns to a row.
  const lastDrop = useRef<TrackTarget | null>(null);

  // Residents sliding ahead of an in-flight drop: clip id → the start it
  // previews at. Painted as an animated left offset, so the row opens room
  // while the drop hovers and flows back the moment the drag aims elsewhere.
  const dropPartAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const sh of assetDrop?.shifts ?? []) m.set(sh.id, sh.start);
    for (const sh of overlayDrop?.shifts ?? []) m.set(sh.id, sh.start);
    return m;
  }, [assetDrop, overlayDrop]);

  // Which drop the cursor is over. Inside the video stack the answer is always
  // a row: the row under the pointer takes the clip and opens room for it, so
  // aiming anywhere over a track lands on that track. A new track comes from
  // one gesture — carrying the clip past the top or the bottom of the stack —
  // and that new row then mounts under the pointer, so it holds itself while
  // the pointer stays out there and lets go the moment it returns to a row.
  // `draggedId` is the clip being carried, when one is; every drag flavor
  // resolves through here, clips grabbed off the timeline and external media
  // alike.
  const resolveDropTrack = useCallback(
    (clientX: number, clientY: number, draggedId?: string): TrackTarget => {
    // An empty video timeline has no base yet: the first clip always lands on
    // track 0, whatever height the pointer is at. Otherwise a drop above the
    // thin empty row resolves to an overlay track, leaving track 0 empty — and
    // an empty track 0 plays black (the compositor's master lives there).
    const st = useEditor.getState();
    const answer = (t: TrackTarget) => ((lastDrop.current = t), t);
    if (st.clips.length === 0) return answer(TRACK_ZERO);
    const rows = Array.from(
      innerRef.current?.querySelectorAll<HTMLElement>("[data-tl-vrow]") ?? []
    )
      .map((el) => ({ track: Number(el.dataset.tlVrow), r: el.getBoundingClientRect() }))
      .sort((a, b) => a.r.top - b.r.top);
    if (!rows.length) return answer(TRACK_ZERO);
    const top = rows[0];
    const bottom = rows[rows.length - 1];
    const held = lastDrop.current?.kind === "insert" ? lastDrop.current.level : null;
    const topLevel = Math.max(0, ...overlayLayers(st.clips).map((c) => c.track)) + 1;
    // A clip alone on the outermost row has no new track to open on that side:
    // the row it left collapses behind it, so it would land alone on a fresh
    // row with the same picture on it. The reach that way aims at rows only;
    // the other way still reorders the stack, so it stays live.
    const dragged = draggedId ? st.clips.find((c) => c.id === draggedId) : undefined;
    const soleTrack =
      dragged && st.clips.every((c) => c.track !== dragged.track || c.id === dragged.id)
        ? dragged.track
        : null;
    // Past the stack: a new top layer above it, a new track 0 below it (the
    // spine transplants onto the drop). Reaching there takes NEW_TRACK_PX of
    // travel; holding it takes none, since by then the new track's own row
    // fills the space the pointer is in.
    if (soleTrack !== top.track && clientY < top.r.top - (held === topLevel ? 0 : NEW_TRACK_PX))
      return answer({ kind: "insert", level: topLevel });
    if (soleTrack !== bottom.track && clientY > bottom.r.bottom + (held === 0 ? 0 : NEW_TRACK_PX))
      return answer({ kind: "insert", level: 0 });
    // Inside the stack: the row the pointer is over, or the one under it when
    // the pointer sits in the gap between two rows. The row makes space for
    // the drop — nothing new opens between two tracks.
    const row = rows.find((r) => clientY <= r.r.bottom) ?? bottom;
    return answer({ kind: "track", track: row.track });
  }, []);

  // Drive the drop preview while a clip is dragged across tracks: highlight the
  // target row's landing slot, or the new track's row past the stack. A row
  // takes the drop as an insert at the pointer — its later clips ripple right —
  // so the slot previews the ripple landing the drop will actually take.
  const previewCross = useCallback(
    (target: TrackTarget | null, start = 0, len = 0, ghost?: DropGhost) => {
      // The drag let go of the placement system (it is home, or it ended): the
      // next resolve starts from the geometry alone.
      if (target === null) {
        lastDrop.current = null;
        return setOverlayDrop(null);
      }
      const landing =
        target.kind === "track"
          ? rippleInsert(
              useEditor.getState().clips.filter((c) => c.track === target.track),
              Math.max(0, start),
              len
            )
          : { start, shifts: [] };
      setOverlayDrop({ target, t: landing.start, len, shifts: landing.shifts, ghost });
    },
    []
  );

  // A drag that left the timeline or landed lets go of the placement hold too,
  // so the next one starts from the geometry alone.
  const endCrossDrag = useCallback(() => {
    lastDrop.current = null;
    setOverlayDrop(null);
  }, []);

  // Releasing a track-0 clip on any other track lifts it out onto that track
  // (or a new one); on its own track the lane coordinator commits the move.
  const onClipCrossDrop = useCallback(
    (id: string, target: TrackTarget, start: number) => {
      previewCross(null);
      if (samePlacement(target, TRACK_ZERO)) return;
      useEditor.getState().dropVideoClip(id, target, start);
    },
    [previewCross]
  );

  // Releasing an overlay clip anywhere: another track, a new inserted track, or
  // down onto track 0.
  const onOverlayCrossDrop = useCallback(
    (id: string, target: TrackTarget, start: number) => {
      previewCross(null);
      useEditor.getState().dropVideoClip(id, target, start);
    },
    [previewCross]
  );

  // The one in-flight lane-track drag (audio, title, upper layer, or cue):
  // the coordinator publishes it so each section can render the ghost, the
  // landing slot, and grow its row stack while a new row is hovered.
  const [laneDrag, setLaneDrag] = useState<LaneDrag | null>(null);

  // Right-click on any row's empty space — video, audio, or title: a small
  // popover offering to close that row's gap under the cursor. The cut is
  // row-local — only that row's later items slide left — so the menu carries
  // the gap it would cut and the row tints it red while the menu is open.
  const [gapMenu, setGapMenu] = useState<
    { x: number; y: number; lane: LaneRef; gap: { start: number; len: number } } | null
  >(null);
  useEffect(() => {
    if (!gapMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGapMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [gapMenu]);

  // Right-click on an element bar: a small popover to hide or show it — and,
  // when the click landed on a keyframe diamond, to remove that key.
  const [barMenu, setBarMenu] = useState<
    { x: number; y: number; id: string; key?: number } | null
  >(null);
  useEffect(() => {
    if (!barMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBarMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [barMenu]);

  // Right-click on a video clip: a one-item popover that grabs the frame
  // under the pointer into the chat composer. The menu carries the grab —
  // the asset, the source second under the pointer, and the spot the flight
  // starts from — and the held skimmer line stands at `t` while it is open.
  const readOnly = useEditor((s) => s.readOnly);
  const [frameMenu, setFrameMenu] = useState<
    { x: number; y: number; t: number; asset: MediaAsset; srcT: number; from: FrameGrabOrigin } | null
  >(null);
  useEffect(() => {
    if (!frameMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFrameMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [frameMenu]);
  const openFrameMenu = (
    e: React.MouseEvent,
    grab: { asset: MediaAsset; srcT: number; from: FrameGrabOrigin }
  ) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const s = useEditor.getState();
    if (s.playing) s.setPlaying(false);
    setFrameMenu({ x: e.clientX, y: e.clientY, t: timeAt(e.clientX), ...grab });
  };
  // While the menu is open, the skimmer holds at the grab time in its darker
  // held state — the preview shows the frame the line marks, and HoverLine's
  // pointer listeners stand down so crossing onto the menu can't yank it.
  // On close the skimmer resumes right under the pointer (tracked while the
  // menu was up), or clears when the pointer has left the timeline.
  const menuPointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!frameMenu) return;
    const scrollEl = scrollRef.current;
    menuPointer.current = { x: frameMenu.x, y: frameMenu.y };
    const track = (e: PointerEvent) => {
      menuPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", track);
    setSkim(frameMenu.t);
    return () => {
      window.removeEventListener("pointermove", track);
      const p = menuPointer.current;
      const r = scrollEl?.getBoundingClientRect();
      const inside =
        !!p && !!r && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
      // Resuming playback while the menu was up (Space) hands the picture
      // back to the playhead; re-arming the skimmer then would freeze every
      // DOM surface on the held frame while the canvas plays on.
      setSkim(
        inside && !useEditor.getState().playing ? Math.max(0, timeAt(p.x)) : null,
      );
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- timeAt reads live refs
  }, [frameMenu]);

  // Element rows: overlays carry a `lane`; used lanes compact to contiguous
  // display rows, so an emptied row disappears on its own. The order is the
  // store's, shared with the lane drags so a drop lands where it was aimed.
  const overlayLanes = useMemo(() => {
    const used = overlayLaneOrder(overlays);
    const rowOf = new Map(used.map((l, i) => [l, i]));
    return { used, rowOf, count: used.length };
  }, [overlays]);
  // The color an element drag paints its landing rows with: the carried item's
  // own, so the move reads as one thing from grab to drop.
  const draggedFamily = useMemo<OverlayFamily>(() => {
    const held = laneDrag?.kind === "overlay" ? overlays.find((o) => o.id === laneDrag.id) : null;
    return held ? overlayFamily(held) : "text";
  }, [laneDrag, overlays]);

  // Video tracks above track 0 (PiP / composited layers), listed highest-first
  // so the top row is the frontmost layer and track 0 sits at the bottom of
  // the stack; empty tracks vanish.
  const aboveTracks = useMemo(
    () => [...new Set(overlayClips.map((c) => c.track).filter((n) => n > 0))].sort((a, b) => b - a),
    [overlayClips]
  );
  // The z-levels a drop past the stack's edges would open a new track at: a
  // new top layer above, or a new track 0 below (the spine transplants there).
  const topInsertLevel = (aboveTracks[0] ?? 0) + 1;
  const bottomInsertLevel = 0;

  // Audio tracks mirror the title tracks: clips carry a `lane`; used lanes
  // compact to contiguous display rows, so empty tracks disappear on their own.
  // Drop preview while an audio asset is dragged over the timeline: which row
  // (one past the end = new track), at what time, for how long.
  const [audioDrop, setAudioDrop] = useState<{ row: number; t: number; len: number } | null>(null);
  const audioRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const audioLanes = useMemo(() => {
    const used = [...new Set(audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b);
    const rowOf = new Map(used.map((l, i) => [l, i]));
    return { used, rowOf, count: used.length };
  }, [audioClips]);
  // What the gutter's track-wide eye/speaker reflect and flip, tallied per
  // video track. Sound counts only clips whose source carries audio, so an
  // all-image track offers no speaker.
  const trackState = useMemo(() => {
    const m = new Map<number, { total: number; hidden: number; sound: number; muted: number }>();
    const typeById = new Map(assets.map((a) => [a.id, a.type]));
    for (const c of clips) {
      const t = m.get(c.track) ?? { total: 0, hidden: 0, sound: 0, muted: 0 };
      t.total++;
      if (c.hidden) t.hidden++;
      if (typeById.get(c.assetId) === "video") {
        t.sound++;
        if (c.muted) t.muted++;
      }
      m.set(c.track, t);
    }
    return m;
  }, [clips, assets]);
  // The same tally per soundtrack lane; `hidden` is an audio segment's mute.
  const audioLaneState = useMemo(() => {
    const m = new Map<number, { total: number; hidden: number }>();
    for (const a of audioClips) {
      const lane = a.lane ?? 0;
      const t = m.get(lane) ?? { total: 0, hidden: 0 };
      t.total++;
      if (a.hidden) t.hidden++;
      m.set(lane, t);
    }
    return m;
  }, [audioClips]);
  // And per title lane.
  const textLaneState = useMemo(() => {
    const m = new Map<number, { total: number; hidden: number }>();
    for (const o of overlays) {
      const lane = o.lane ?? 0;
      const t = m.get(lane) ?? { total: 0, hidden: 0 };
      t.total++;
      if (o.hidden) t.hidden++;
      m.set(lane, t);
    }
    return m;
  }, [overlays]);
  // Reveals the resting toggles while the pointer is over the track area;
  // a toggle whose track has anything off stays visible on its own.
  const [trackHover, setTrackHover] = useState(false);

  // A whole row on its way to a new place in its band. The gutter is the
  // handle: a press there grabs the row it sits on, and the drag stays inside
  // that band — a row is only ever above or below its own kind, so there is
  // nowhere else for it to go.
  const [rowDrag, setRowDrag] = useState<RowDrag | null>(null);
  // The band's rows in screen space, top row first. The video stack measures
  // its own row elements (their heights vary with the mask key rail); the
  // stacked bands are uniform, so their rows come off the band's top edge.
  const rowBoxes = useCallback(
    (band: RowBand): { top: number; h: number }[] => {
      if (band === "video")
        return Array.from(
          innerRef.current?.querySelectorAll<HTMLElement>("[data-tl-vrow]") ?? [],
          (el) => {
            const r = el.getBoundingClientRect();
            return { top: r.top, h: r.height };
          }
        );
      const el = band === "overlay" ? overlayRef.current : audioRef.current;
      if (!el) return [];
      const h = band === "overlay" ? TEXT_H : AUDIO_H;
      const n = band === "overlay" ? overlayLanes.count : audioLanes.count;
      const top = el.getBoundingClientRect().top;
      return Array.from({ length: n }, (_, r) => ({ top: top + r * h, h }));
    },
    [overlayLanes.count, audioLanes.count]
  );
  // Grab a row by its gutter cell and carry it to a new place in the band.
  const gripRow = (band: RowBand, row: number) => (e: React.PointerEvent) => {
    const rows = rowBoxes(band);
    if (e.button !== 0 || rows.length < 2 || row >= rows.length) return;
    const held = rows[row];
    const first = rows[0];
    const last = rows[rows.length - 1];
    // The carried row travels between the band's own edges and no further.
    const floor = first.top - held.top;
    const ceil = last.top + last.h - (held.top + held.h);
    let to = row;
    setRowDrag({ band, from: row, to, dy: 0, rows, left: 0, width: 0 });
    const view = scrollRef.current?.getBoundingClientRect();
    const left = view?.left ?? 0;
    const width = view?.width ?? 0;
    startDrag(e, {
      cursor: () => "grabbing",
      onMove: (_dx, dy) => {
        const travel = Math.max(floor, Math.min(ceil, dy));
        const mid = held.top + held.h / 2 + travel;
        to = rows.length - 1;
        for (let i = 0; i < rows.length; i++)
          if (mid < rows[i].top + rows[i].h) {
            to = i;
            break;
          }
        setRowDrag({ band, from: row, to, dy: travel, rows, left, width });
      },
      onUp: () => {
        setRowDrag(null);
        if (to === row) return;
        const s = useEditor.getState();
        // The video stack draws top-down but numbers bottom-up, so its rows
        // reach the store flipped.
        if (band === "video") s.moveVideoTrack(rows.length - 1 - row, rows.length - 1 - to);
        else if (band === "overlay") s.moveOverlayLane(row, to);
        else s.moveAudioLane(row, to);
      },
    });
  };
  /** A stacked band's row top while a row drag runs: the carried row rides the
   * pointer, the rest sit at the place they are closing up into. */
  const stackedRowTop = (band: "overlay" | "audio", row: number, h: number) =>
    rowDrag?.band !== band
      ? row * h
      : row === rowDrag.from
        ? row * h + rowDrag.dy
        : shownRow(rowDrag, row) * h;
  /** The same for the video stack, where rows are laid out in flow and shift
   * by a transform instead. */
  const videoRowShift = (row: number) => {
    if (rowDrag?.band !== "video") return 0;
    const step = rowDrag.rows[rowDrag.from].h + ROW_GAP;
    if (row === rowDrag.from) return rowDrag.dy;
    if (rowDrag.from < rowDrag.to) return row > rowDrag.from && row <= rowDrag.to ? -step : 0;
    return row >= rowDrag.to && row < rowDrag.from ? step : 0;
  };

  // Chat mention token per audio clip ("@s1"), keyed by clip id — the same
  // handles the chat resolves against, so the token shown on hover is exactly
  // what pulls this sound into a message.
  const audioMentions = useMemo(() => {
    const map = new Map<string, string>();
    for (const ref of audioClipRefs(audioClips, assets)) {
      if (ref.handle) map.set(ref.id, `@${ref.handle}`);
    }
    return map;
  }, [audioClips, assets]);

  // The home track of an in-flight upper-layer drag, so that row can render
  // the landing slot while the clip stays on its own track.
  const draggedOverlayTrack =
    laneDrag?.kind === "overlayClip" && !laneDrag.away
      ? overlayClips.find((c) => c.id === laneDrag.id)?.track ?? null
      : null;

  // The audio row under a screen y, one past the last row = a new track.
  // Before any audio exists there are no rows, so everything resolves to 0.
  const audioRowAt = useCallback(
    (clientY: number): number => {
      const el = audioRef.current;
      if (!el) return 0;
      const top = el.getBoundingClientRect().top;
      return Math.min(audioLanes.count, Math.max(0, Math.floor((clientY - top) / AUDIO_H)));
    },
    [audioLanes.count]
  );

  // The element row under the pointer, or undefined for a point outside the
  // band — a drop there takes the element's home row.
  const overlayRowAt = useCallback(
    (clientY: number): number | undefined => {
      const el = overlayRef.current;
      if (!el || overlayLanes.count === 0) return undefined;
      const r = el.getBoundingClientRect();
      if (clientY < r.top || clientY > r.bottom) return undefined;
      return Math.min(overlayLanes.count - 1, Math.max(0, Math.floor((clientY - r.top) / TEXT_H)));
    },
    [overlayLanes]
  );
  const overlayLaneAt = (clientY: number): number | undefined => {
    const row = overlayRowAt(clientY);
    return row === undefined ? undefined : overlayLanes.used[row];
  };
  // Every place on every video track a transition can sit: the cuts, where one
  // clip hands over to the next, and the open edges — a clip's head with
  // nothing before it, its tail with nothing after — where it arrives from or
  // leaves to nothing. Each boundary offers exactly one: two clips that touch
  // make a cut, and anything else is an edge. `len` is the room a transition
  // takes there, so a drop can show its footprint before it lands.
  const anchors = useMemo(() => {
    const out: Anchor[] = [];
    const collect = (list: ClipSpan[]) =>
      list.forEach((sp, i) => {
        const prev = list[i - 1];
        const next = list[i + 1];
        const end = sp.start + sp.len;
        // The same touch tolerance the blend goes live with, so an anchor is
        // a cut exactly when a transition dropped there would play.
        const openHead = !prev || prev.start + prev.len < sp.start - 0.02;
        const touchesNext = next && next.start <= end + 0.02;
        if (openHead) {
          out.push({
            kind: "in",
            clipId: sp.clip.id,
            at: sp.start,
            len: sp.clip.animIn?.seconds || TRANSITION_DEFAULT_SECONDS,
          });
        }
        if (touchesNext) {
          out.push({
            kind: "cut",
            clipId: sp.clip.id,
            at: end,
            len: sp.clip.transition || TRANSITION_DEFAULT_SECONDS,
          });
        } else {
          out.push({
            kind: "out",
            clipId: sp.clip.id,
            at: end,
            len: sp.clip.animOut?.seconds || TRANSITION_DEFAULT_SECONDS,
          });
        }
      });
    collect(spans);
    overlayTrackSpans.forEach(collect);
    return out;
  }, [spans, overlayTrackSpans]);
  // The boundary a drop lands on: the closest one within the same magnet reach
  // a dragged bar snaps by. Past that there is no boundary in play and the bar
  // parks where it was dropped.
  const nearestAnchor = (t: number) => {
    const best = anchors.reduce<Anchor | null>(
      (found, a) => (!found || Math.abs(a.at - t) < Math.abs(found.at - t) ? a : found),
      null
    );
    return best && Math.abs(best.at - t) <= XBAR_MAGNET_PX / pps ? best : null;
  };

  // Every transition bar in the doc, live or parked. A bar is its own object
  // on the row: the clips it happens to line up with decide whether it plays,
  // and moving or deleting clips leaves it exactly where it is.
  const bars = useEditor((s) => s.transitions);
  const barRoles = useMemo(() => resolveTransitions(clips, bars), [clips, bars]);
  const transitions = useMemo<XBar[]>(
    () =>
      bars
        .map((t) => {
          // A bar can play several same-instant boundaries; the rank-first
          // one names it on the row.
          const role = barRoles.get(t.id)?.[0] ?? null;
          const base = TRANSITION_STYLE_LABELS[t.style];
          const label =
            role?.kind === "in" ? `${base} in` : role?.kind === "out" ? `${base} out` : base;
          return { t, role, label };
        })
        .sort((a, b) => a.t.start - b.t.start),
    [bars, barRoles]
  );

  /** Where a bar of `len` seconds sits when it lands on this anchor: an
   * entrance starts at the clip's head, everything else ends on its edge. */
  const anchorBarStart = (a: Anchor, len: number) => (a.kind === "in" ? a.at : a.at - len);

  /** The bar already playing this anchor's boundary, if any — through any of
   * its roles, so a bar serving several same-instant boundaries is the
   * incumbent at each of them. */
  const barAt = (a: Anchor) =>
    bars.find((t) =>
      (barRoles.get(t.id) ?? []).some((r) => r.kind === a.kind && r.clipId === a.clipId)
    ) ?? null;

  /** Land a new bar from the panel: it takes the nearest anchor when one is
   * around, replacing whatever played there, and sits free anywhere else. */
  const dropTransitionAt = (time: number, style: TransitionStyle) => {
    const st = useEditor.getState();
    if (st.readOnly) return;
    const a = nearestAnchor(time);
    const len = a?.len ?? TRANSITION_DEFAULT_SECONDS;
    st.beginHistoryBatch();
    const incumbent = a ? barAt(a) : null;
    if (incumbent) st.removeTransition(incumbent.id);
    const id = st.addTransition({
      start: a ? anchorBarStart(a, len) : time,
      seconds: len,
      style,
    });
    st.endHistoryBatch();
    st.select({ kind: "transition", id });
  };

  // Drag a bar anywhere along the row. An anchor within reach pulls the drop
  // onto itself and lights the room it takes; released anywhere else the bar
  // stays exactly there — parked, playing nothing until a cut or a clip edge
  // lines up with it. A press that never moved selects the bar.
  const moveTransition = (e: React.PointerEvent, x: XBar) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = useEditor.getState();
    if (s.readOnly) return;
    // ⌘/⇧-click folds the bar into the multi-selection, like any lane bar.
    const additive = e.metaKey || e.shiftKey;
    let landing: { start: number; anchor: Anchor | null } | null = null;
    startDrag(e, {
      onMove: (dx) => {
        const free = Math.max(-x.t.seconds + 0.1, x.t.start + dx / pps);
        const near = anchors.reduce<{ a: Anchor; gap: number } | null>((best, a) => {
          const gap = Math.abs(anchorBarStart(a, x.t.seconds) - free);
          return !best || gap < best.gap ? { a, gap } : best;
        }, null);
        const snapped = near && near.gap <= XBAR_MAGNET_PX / pps ? near.a : null;
        landing = snapped
          ? { start: anchorBarStart(snapped, x.t.seconds), anchor: snapped }
          : { start: free, anchor: null };
        setSnapX(snapped ? snapped.at * pps : null);
        setJointDrop(snapped ? { ...snapped, len: x.t.seconds } : null);
        setTransitionDrag({ ...x, t: { ...x.t, start: landing.start } });
      },
      onUp: (_dx, _dy, moved) => {
        setSnapX(null);
        setJointDrop(null);
        setTransitionDrag(null);
        const st = useEditor.getState();
        if (!moved || !landing) {
          if (additive) return st.toggleSelect({ kind: "transition", id: x.t.id });
          return st.select({ kind: "transition", id: x.t.id });
        }
        st.beginHistoryBatch();
        const incumbent = landing.anchor ? barAt(landing.anchor) : null;
        if (incumbent && incumbent.id !== x.t.id) st.removeTransition(incumbent.id);
        st.updateTransition(x.t.id, { start: landing.start });
        st.endHistoryBatch();
      },
    });
  };

  // Drag the loose edge to retime. A playing bar keeps the boundary end still —
  // an entrance grows forward from its start, everything else backward from
  // its end — so retiming never un-aligns it.
  const trimTransition = (e: React.PointerEvent, x: XBar) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st0 = useEditor.getState();
    if (st0.readOnly) return;
    const growsForward = x.role?.kind === "in";
    const fixed = growsForward ? x.t.start : x.t.start + x.t.seconds;
    st0.beginHistoryBatch();
    startDrag(e, {
      onMove: (dx) => {
        const loose = (growsForward ? x.t.start + x.t.seconds : x.t.start) + dx / pps;
        const seconds = Math.max(0.1, Math.min(TRANSITION_MAX, Math.abs(loose - fixed)));
        useEditor.getState().updateTransitionTransient(x.t.id, {
          seconds,
          start: growsForward ? fixed : fixed - seconds,
        });
      },
      onUp: () => useEditor.getState().endHistoryBatch(),
    });
  };

  // The landing preview for a shape, sticker or effect dragged out of a
  // panel, drawn the way a bar drag is: the slot outline on the target row
  // where the drop lands, and the bar itself carried at the pointer (`y` is
  // the bar's top in band pixels).
  const [elementDrop, setElementDrop] = useState<{ row: number; t: number; y: number } | null>(
    null
  );
  // The place a dragged transition would land on, marked with the footprint it
  // would take while it is in flight.
  const [jointDrop, setJointDrop] = useState<Anchor | null>(null);
  // A transition tile from the panel is over the timeline: the row lights
  // every place a drop could play, the same as a bar drag does.
  const [xTileDrag, setXTileDrag] = useState(false);
  // A transition bar mid-drag, drawn where the pointer has it.
  const [transitionDrag, setTransitionDrag] = useState<XBar | null>(null);
  // A drag past the top edge opens a row there, pushing the stack down by one
  // for as long as it is aimed that way.
  const topRowShift =
    laneDrag?.kind === "overlay" && laneDrag.targetRow < 0 ? TEXT_H : 0;

  // Where a dropped asset should land. An empty timeline has no arrangement to
  // read a position against, so the drop starts the film at 0 no matter where
  // the cursor released.
  const dropTimeAt = (clientX: number) => (total <= 0 ? 0 : Math.max(0, timeAt(clientX)));

  // Scrub with auto-scroll when the pointer nears the viewport edges.
  //
  // Both boxes are measured once, at the press. Reading a rect forces the
  // browser to lay the page out, and a drag that measured per event paid for
  // two layouts before it could work out what time the pointer was over.
  const scrub = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    if (s.playing) s.setPlaying(false);
    const el = scrollRef.current;
    const innerLeft = innerRef.current?.getBoundingClientRect().left ?? 0;
    const view = el?.getBoundingClientRect() ?? null;
    // The inner box travels with the scroller, so an auto-scroll shifts what
    // a given screen x means; tracking the shift keeps the measurement true
    // without re-reading the layout.
    const scroll0 = el?.scrollLeft ?? 0;
    const at = (clientX: number) =>
      Math.max(0, (clientX - innerLeft + ((el?.scrollLeft ?? 0) - scroll0)) / pps);
    useEditor.getState().seek(at(e.clientX));
    startDrag(e, {
      onMove: (_dx, _dy, ev) => {
        if (el && view) {
          if (ev.clientX > view.right - 36) el.scrollLeft += 14;
          else if (ev.clientX < view.left + 36) el.scrollLeft -= 14;
        }
        useEditor.getState().seek(at(ev.clientX));
      },
    });
  };

  // A press on empty track space: a click deselects and moves the playhead;
  // a drag sweeps a rubber-band that selects every bar it touches — the same
  // blue band the projects home uses. ⇧/⌘ keeps the prior selection under it.
  const [marquee, setMarquee] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const deselectIfSelf = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    const st = useEditor.getState();
    if (st.playing) st.setPlaying(false);
    st.seek(Math.max(0, timeAt(e.clientX)));
    const additive = e.shiftKey || e.metaKey;
    const base = additive
      ? st.multiSelection.filter((m): m is NonNullable<Selection> => !!m)
      : [];
    const startX = e.clientX;
    const startY = e.clientY;
    let sweeping = false;
    startDrag(e, {
      onMove: (dx, dy, ev) => {
        if (!sweeping && Math.hypot(dx, dy) < 4) return;
        sweeping = true;
        const r = {
          left: Math.min(startX, ev.clientX),
          top: Math.min(startY, ev.clientY),
          width: Math.abs(ev.clientX - startX),
          height: Math.abs(ev.clientY - startY),
        };
        setMarquee(r);
        const hit = [...base];
        const seen = new Set(hit.map((m) => `${m.kind}:${m.id}`));
        scrollRef.current?.querySelectorAll<HTMLElement>("[data-tl-sel]").forEach((el) => {
          const b = el.getBoundingClientRect();
          const overlaps =
            b.left < r.left + r.width &&
            b.right > r.left &&
            b.top < r.top + r.height &&
            b.bottom > r.top;
          if (!overlaps) return;
          const tag = el.dataset.tlSel!;
          const cut = tag.indexOf(":");
          const kind = tag.slice(0, cut) as NonNullable<Selection>["kind"];
          const id = tag.slice(cut + 1);
          if (seen.has(tag)) return;
          seen.add(tag);
          hit.push({ kind, id });
        });
        useEditor.getState().setMultiSelection(hit);
      },
      onUp: (_dx, _dy, moved) => {
        setMarquee(null);
        if (!moved && !additive) useEditor.getState().select(null);
      },
    });
  };

  // Zoom that keeps a chosen time pinned under a chosen viewport x.
  const pendingAnchor = useRef<{ t: number; px: number } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = pendingAnchor.current;
    if (el && a) {
      el.scrollLeft = Math.max(0, PAD_SIDE + a.t * pps - a.px);
      pendingAnchor.current = null;
    }
  }, [pps]);

  const zoomTo = useCallback((next: number, anchorT?: number, anchorPx?: number) => {
    const el = scrollRef.current;
    const cur = useEditor.getState();
    const floor = el ? zoomFloor(el.clientWidth, projectDuration(cur)) : ZOOM_MIN;
    const clamped = Math.max(floor, Math.min(ZOOM_MAX, next));
    if (Math.abs(clamped - cur.pxPerSec) < 0.01) return;
    if (el) {
      const t = anchorT ?? playheadAt();
      const px = anchorPx ?? PAD_SIDE + t * cur.pxPerSec - el.scrollLeft;
      pendingAnchor.current = { t, px };
    }
    cur.setPxPerSec(clamped);
  }, []);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    const dur = projectDuration(useEditor.getState());
    if (!el || dur <= 0) return;
    zoomTo(fitZoom(el.clientWidth, dur), 0, PAD_SIDE);
  }, [zoomTo]);

  // The editing tools, as the toolbar button and its menu row both invoke them.
  const split = useCallback(() => {
    useEditor.getState().splitAtPlayhead(skimAt() ?? undefined);
  }, []);
  const addText = useCallback(() => useEditor.getState().addOverlay(), []);
  const deleteSelection = useCallback(() => useEditor.getState().deleteSelection(), []);

  // Trackpad pinch / cmd+wheel zooms at the cursor; vertical wheel pans.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const cur = useEditor.getState().pxPerSec;
        const t = (el.scrollLeft + px - PAD_SIDE) / cur;
        zoomTo(cur * Math.exp(-e.deltaY * 0.012), t, px);
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        // When the tracks overflow vertically, let the wheel scroll them;
        // otherwise map vertical wheel to horizontal panning (the timeline is
        // mostly wide).
        if (el.scrollHeight <= el.clientHeight) {
          e.preventDefault();
          el.scrollLeft += e.deltaY;
        }
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomTo]);

  // Track the viewport width so `contentW` can fill it end-to-end.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportW(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Timeline-scoped keys: = / - zoom around the playhead, Home/End jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable ||
        document.querySelector('[data-slot="dialog-content"]')
      )
        return;
      const s = useEditor.getState();
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomTo(s.pxPerSec * 1.3);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomTo(s.pxPerSec / 1.3);
      } else if (e.key === "Home") {
        e.preventDefault();
        s.seek(0);
      } else if (e.key === "End") {
        e.preventDefault();
        s.seek(projectDuration(s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomTo]);

  // Drop an asset onto the timeline: every kind lands free-form at time `t`
  // (sliding to its lane's next free slot); audio targets the hovered audio
  // row, one past the last row opening a new track; clip media past the video
  // stack's edges opens a new video track.
  const placeAssetAt = (
    assetId: string,
    type: "video" | "audio" | "image",
    t: number,
    audioRow = 0,
    place: TrackTarget = TRACK_ZERO,
    /** The element row the pointer came down on, when it was over the band. */
    elementLane?: number
  ) => {
    const s = useEditor.getState();
    const sticker = stickerOf(s.assets.find((a) => a.id === assetId));
    if (sticker) {
      s.addSticker({
        assetId,
        ...(isLottieAsset(sticker) ? { lottie: true } : {}),
        at: t,
        ...(elementLane !== undefined ? { lane: elementLane } : {}),
      });
      return;
    }
    if (isClipMedia(type)) {
      // A track drop lands at the pointer, rippling later clips right, so a
      // drop into a leading gap or between clips lands there.
      s.addVideoFromAsset(assetId, place, t);
    } else {
      const used = [...new Set(s.audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b);
      const lane =
        audioRow < used.length ? used[audioRow] : (used[used.length - 1] ?? -1) + 1;
      s.addAudioFromAsset(assetId, t, { lane });
    }
  };

  // The video being dragged — project media, a library clip, or an image ref
  // (which lands as a still) — with the ghost its landing segment paints.
  const draggedVideo = (e: React.DragEvent): { duration: number; ghost: DropGhost } | null => {
    if (hasLibraryDrag(e)) {
      const lib = draggingLibrary();
      if (!lib || !isClipMedia(lib.type)) return null;
      return {
        duration: lib.type === "image" ? STILL_SECONDS : lib.duration,
        ghost: {
          url: libraryMediaUrl(lib.fileName, lib.residency),
          kind: lib.type,
          aspect: lib.width && lib.height ? lib.width / lib.height : undefined,
        },
      };
    }
    const id = draggingAssetId();
    if (id) {
      const asset = useEditor.getState().assets.find((a) => a.id === id);
      if (!asset || stickerOf(asset) || !isClipMedia(asset.type)) return null;
      return {
        duration: asset.type === "image" ? STILL_SECONDS : asset.duration,
        ghost:
          asset.type === "image"
            ? { url: asset.url, kind: "image" }
            : {
                url: asset.url,
                kind: "video",
                aspect:
                  asset.width && asset.height ? asset.width / asset.height : undefined,
                thumbs: asset.thumbs,
                thumbStep: asset.thumbStep,
                poster: asset.thumbs?.[0],
              },
      };
    }
    const stockVideo = draggingStockVideo(e);
    if (stockVideo) {
      return {
        duration: stockVideo.duration ?? 0,
        ghost: {
          url: stockVideo.url,
          kind: "video",
          aspect:
            stockVideo.width && stockVideo.height
              ? stockVideo.width / stockVideo.height
              : undefined,
          poster: stockVideo.thumb,
        },
      };
    }
    const still = draggingStill(e);
    return still
      ? { duration: STILL_SECONDS, ghost: { url: still.url, kind: "image" } }
      : null;
  };

  // Drop targets for the upper tracks and between-track seams: dragging a
  // video onto a lane adds it there; near a row's edge it aims at the seam and
  // opens a fresh track at that z-level. The pointer resolves through
  // `resolveDropTrack` — the same resolver internal clip drags use — so every
  // media flavor lands by one rule.
  const overlayDropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      const vid = draggedVideo(e);
      if (!vid) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setAssetDrop(null);
      setDropType("video"); // keep the insertion zones lit however the drag entered
      previewCross(
        resolveDropTrack(e.clientX, e.clientY),
        Math.max(0, timeAt(e.clientX)),
        vid.duration,
        vid.ghost
      );
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) endCrossDrag();
    },
    onDrop: (e: React.DragEvent) => {
      // A sticker crossing a video row is still headed for the element rows;
      // leave it to the timeline's own drop rather than swallowing it here.
      if (draggedSticker()) return;
      e.preventDefault();
      e.stopPropagation();
      const place = resolveDropTrack(e.clientX, e.clientY);
      const t = Math.max(0, timeAt(e.clientX));
      endCrossDrag();
      setDropType(null);
      const lib = draggingLibrary();
      const libId = draggedLibraryId(e);
      const still = draggingStill(e);
      const stockVideo = draggingStockVideo(e);
      const projectId = useEditor.getState().projectId;
      clearAssetDrag();
      if (libId && lib && isClipMedia(lib.type) && projectId) {
        void importLibraryAsset(projectId, lib)
          .then((asset) => useEditor.getState().addVideoFromAsset(asset.id, place, t))
          .catch(() => {});
        return;
      }
      const id = draggedAssetId(e);
      const asset = id ? useEditor.getState().assets.find((a) => a.id === id) : null;
      if (id && !stickerOf(asset) && isClipMedia(asset?.type)) {
        useEditor.getState().addVideoFromAsset(id, place, t);
        return;
      }
      if (stockVideo && projectId) {
        void importStockVideo(projectId, {
          url: stockVideo.url,
          name: stockVideo.name,
          duration: stockVideo.duration,
          width: stockVideo.width,
          height: stockVideo.height,
        })
          .then((vid) => useEditor.getState().addVideoFromAsset(vid.id, place, t))
          .catch(() => {});
        return;
      }
      if (still && projectId) {
        void importImage(projectId, still)
          .then((img) => useEditor.getState().addVideoFromAsset(img.id, place, t))
          .catch(() => {});
      }
    },
  };

  // Drag the panel's top border to resize; the border itself stays as-is,
  // only an invisible grab strip sits on top of it.
  const resize = (e: React.PointerEvent) => {
    const h0 = useEditor.getState().timelineH;
    startDrag(e, {
      onMove: (_dx, dy) => {
        useEditor.getState().setTimelineH(h0 - dy);
      },
    });
  };

  // The dragged media as a floating segment: its filmstrip fills it at true
  // length and it rides above the row's clips (z-20), so the drag reads as a
  // placed segment sliding to its landing spot.
  const dropSegment = (t: number, len: number, h: number, ghost?: DropGhost) => (
    <div
      className="tl-asset-drop-slot pointer-events-none absolute top-0.5 z-20 overflow-hidden rounded-lg bg-black opacity-90 shadow-2xl ring-[1.5px] ring-[#0a84ff]/70 transition-[left] duration-100 ease-out"
      style={{ left: t * pps, width: Math.max(10, len * pps - CLIP_GAP), height: h }}
    >
      {ghost && (
        <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: h - WAVE_H }}>
          <DropGhostFilm ghost={ghost} w={Math.max(10, len * pps - CLIP_GAP)} h={h - WAVE_H} pps={pps} />
        </div>
      )}
      <span className="absolute top-1 left-1 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] tabular-nums text-white">
        {len.toFixed(1)}s
      </span>
    </div>
  );

  // The landing preview on a video row while the drag targets it. External
  // media paints the segment itself; an internal drag paints the plain slot —
  // the same chrome as the lane slots — since the dragged clip is its own ghost.
  const trackSlot = (place: TrackTarget, h: number) =>
    samePlacement(overlayDrop?.target ?? null, place) ? (
      overlayDrop!.ghost ? (
        dropSegment(overlayDrop!.t, overlayDrop!.len, h, overlayDrop!.ghost)
      ) : (
        <div
          className="pointer-events-none absolute top-0.5 rounded-lg bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)] transition-[left] duration-150 ease-out"
          style={{
            left: overlayDrop!.t * pps,
            width: Math.max(10, overlayDrop!.len * pps - CLIP_GAP),
            height: h,
          }}
        />
      )
    ) : null;

  // Only empty space gets the menu: a right-click on an item sits on a
  // footprint, so the gap lookup misses and the event falls through to the
  // browser.
  const openGapMenu = (lane: LaneRef) => (e: React.MouseEvent) => {
    const gap = laneGapAt(useEditor.getState(), lane, timeAt(e.clientX));
    if (!gap) return;
    e.preventDefault();
    setGapMenu({ x: e.clientX, y: e.clientY, lane, gap });
  };

  // Audio and title rows stack inside one container, so the row comes from
  // where the pointer landed and the display row maps back to the lane the
  // items actually carry.
  const openStackedGapMenu =
    (kind: "audio" | "overlay", rowH: number, used: number[]) => (e: React.MouseEvent) => {
      const top = e.currentTarget.getBoundingClientRect().top;
      const index = used[Math.floor((e.clientY - top) / rowH)];
      if (index === undefined) return;
      openGapMenu({ kind, index })(e);
    };

  // The span the open gap menu would cut, tinted red on its own row.
  const gapHighlight = (lane: LaneRef, h: number, top = 0) =>
    gapMenu && sameLane(gapMenu.lane, lane) ? (
      <div
        className="pointer-events-none absolute z-10 rounded-lg bg-red-500/15"
        style={{
          left: gapMenu.gap.start * pps,
          width: Math.max(2, gapMenu.gap.len * pps - CLIP_GAP),
          height: h,
          top: top + 2,
        }}
      />
    ) : null;

  // The would-be new video track, one row past the stack's edge — the same
  // grown-row experience as the audio and title lanes. It mounts only while
  // the drag is out there, and it grows away from the stack (the top one
  // carries the rows below it down with the pointer's own ghost), so the row
  // the drag came from stays where it was. Dropping here opens a brand-new
  // track at z-level `level`.
  const newTrackRow = (level: number) => {
    const place: TrackTarget = { kind: "insert", level };
    if (!videoDragActive || !samePlacement(overlayDrop?.target ?? null, place)) return null;
    return (
      <div className="relative mt-1.5" style={{ height: OVERLAY_H }}>
        {laneRail(OVERLAY_H - 2)}
        {trackSlot(place, OVERLAY_H - 4)}
      </div>
    );
  };


  return (
    <footer
      className="relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border bg-card select-none"
      style={{ height: timelineH }}
      // The floating object ghost (`setObjectDragImage`) hands over to this
      // surface's own landing previews while a drag is over it.
      data-segment-drop
      onDragOver={(e) => {
        // A template materializes as a whole arrangement, so it accepts the
        // drop without a single-clip landing preview.
        if (hasTemplateDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setAssetDrop(null);
          setOverlayDrop(null);
          setAudioDrop(null);
          setDropType(null);
          return;
        }
        const isLib = hasLibraryDrag(e);
        const still = draggingStill(e);
        const stockVideo = draggingStockVideo(e);
        const stockMusic = draggingStockMusic(e);
        const element = hasElementDrag(e) ? draggingElement() : null;
        if (!hasAssetDrag(e) && !isLib && !still && !stockVideo && !stockMusic && !element)
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        // An element — a sticker, or a shape or effect from a panel — lands on
        // the element rows, so none of the clip previews apply to it.
        if (element || draggedSticker()) {
          // The band paints the bar being carried; a "move" cursor keeps the
          // copy badge off it.
          e.dataTransfer.dropEffect = "move";
          setAssetDrop(null);
          setOverlayDrop(null);
          setAudioDrop(null);
          setDropType(null);
          // An empty band has no rows to hit; the drag opens the first one,
          // where the drop will land.
          const hit = overlayRowAt(e.clientY);
          const row =
            !element || element.kind !== "transition"
              ? hit ?? (overlayLanes.count === 0 ? 0 : null)
              : null;
          // The pointer's own time, not `dropTimeAt`: an empty timeline pins
          // clip drops to 0, but an element rides wherever it is held.
          const bandTop = overlayRef.current?.getBoundingClientRect().top;
          setElementDrop(
            row !== null
              ? {
                  row,
                  t: Math.max(0, timeAt(e.clientX)),
                  y:
                    bandTop !== undefined
                      ? e.clientY - bandTop - (TEXT_H - 6) / 2
                      : row * TEXT_H + 2,
                }
              : null
          );
          setXTileDrag(element?.kind === "transition");
          setJointDrop(
            element?.kind === "transition"
              ? nearestAnchor(Math.max(0, timeAt(e.clientX)))
              : null
          );
          return;
        }
        setElementDrop(null);
        setJointDrop(null);
        setXTileDrag(false);
        // Preview where a video would land; audio drops free-form. Library and
        // stock drags carry their own shape since they aren't in the project yet.
        let type: "video" | "audio" | "image" | undefined;
        let duration = 0;
        if (isLib) {
          const lib = draggingLibrary();
          type = lib && lib.type !== "font" ? lib.type : undefined;
          duration = lib?.duration ?? 0;
        } else if (stockMusic) {
          type = "audio";
          duration = stockMusic.duration ?? 0;
        } else if (stockVideo) {
          type = "video";
          duration = stockVideo.duration ?? 0;
        } else if (still) {
          type = "video";
          duration = STILL_SECONDS;
        } else {
          const id = draggingAssetId();
          const asset = id ? useEditor.getState().assets.find((a) => a.id === id) : null;
          type = asset && asset.type !== "font" ? asset.type : undefined;
          duration = asset?.type === "image" ? STILL_SECONDS : asset?.duration ?? 0;
        }
        // What the ghost paints: the source's frames, from wherever it lives.
        const ghost = draggedVideo(e)?.ghost;
        // A still rides the video tracks: reveal their guides and new-track rows.
        setDropType(isClipMedia(type) ? "video" : type ?? null);
        if (type === "audio") {
          // Preview which audio row the sound would land on.
          setAudioDrop({
            row: audioRowAt(e.clientY),
            t: dropTimeAt(e.clientX),
            len: duration,
          });
          setAssetDrop(null);
          return;
        }
        setAudioDrop(null);
        if (!isClipMedia(type) || !duration) {
          setAssetDrop(null);
          return;
        }
        // Past the stack's edges the drop opens a new track: preview it in
        // the would-be new row instead of track 0.
        const place = resolveDropTrack(e.clientX, e.clientY);
        if (place.kind === "insert") {
          setAssetDrop(null);
          setOverlayDrop({ target: place, t: dropTimeAt(e.clientX), len: duration, ghost });
          return;
        }
        setOverlayDrop(null);
        // Preview the true landing spot: a drop at the pointer inserts here,
        // rippling later clips right, so the ghost sits where the segment will
        // actually land — a box under the pointer that lands minutes away lies.
        const cur = useEditor.getState();
        const { start, shifts } = rippleInsert(
          track0Clips(cur.clips),
          dropTimeAt(e.clientX),
          duration
        );
        setAssetDrop({ t: start, len: duration, ghost, shifts });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setAssetDrop(null);
          endCrossDrag();
          setAudioDrop(null);
          setDropType(null);
          setElementDrop(null);
          setJointDrop(null);
          setXTileDrag(false);
        }
      }}
      onDrop={(e) => {
        // Resolve the hovered rows before the previews (and their rows) clear.
        const audioRow = audioRowAt(e.clientY);
        const elementLane = overlayLaneAt(e.clientY);
        setElementDrop(null);
        setJointDrop(null);
        setXTileDrag(false);
        const videoPlace = resolveDropTrack(e.clientX, e.clientY);
        setAssetDrop(null);
        endCrossDrag();
        setAudioDrop(null);
        setDropType(null);
        const t = dropTimeAt(e.clientX);

        // A library asset must be copied into the project before it can land.
        const lib = draggingLibrary();
        const libId = draggedLibraryId(e);
        const still = draggingStill(e);
        const stockVideo = draggingStockVideo(e);
        const stockMusic = draggingStockMusic(e);
        const tpl = draggingTemplate();
        const element = hasElementDrag(e) ? draggingElement() : null;
        const projectId = useEditor.getState().projectId;
        clearAssetDrag();
        clearElementDrag();
        // Elements land at the pointer's own time, not `dropTimeAt`, which
        // pins everything to 0 on an empty timeline — a clip starts the film
        // there, but an element lands where it was dropped.
        const atElement = Math.max(0, timeAt(e.clientX));
        if (element) {
          e.preventDefault();
          const aim = {
            at: atElement,
            ...(elementLane !== undefined ? { lane: elementLane } : {}),
          };
          if (element.kind === "shape") useEditor.getState().addShape(element.shape, aim);
          else if (element.kind === "effect") useEditor.getState().addEffect(element.effect, aim);
          else dropTransitionAt(t, element.style);
          return;
        }
        if (tpl && projectId) {
          e.preventDefault();
          if (tpl.scope === "project") addProjectTemplateToTimeline(projectId, tpl.template, t);
          else void addTemplateToProject(projectId, tpl.template, t).catch(() => {});
          return;
        }
        if (libId && lib && projectId) {
          e.preventDefault();
          void importLibraryAsset(projectId, lib)
            .then((asset) => {
              if (asset.type !== "font")
                placeAssetAt(
                  asset.id,
                  asset.type,
                  stickerOf(asset) ? atElement : t,
                  audioRow,
                  videoPlace
                );
            })
            .catch(() => {});
          return;
        }

        const id = draggedAssetId(e);
        if (id) {
          e.preventDefault();
          const asset = useEditor.getState().assets.find((a) => a.id === id);
          if (asset && asset.type !== "font")
            placeAssetAt(
              id,
              asset.type,
              stickerOf(asset) ? atElement : t,
              audioRow,
              videoPlace,
              elementLane
            );
          return;
        }

        // A stock-music sample imports as an audio asset and lands on the
        // hovered soundtrack lane.
        if (stockMusic && projectId) {
          e.preventDefault();
          void importStockMusic(projectId, {
            url: stockMusic.url,
            name: stockMusic.name,
            duration: stockMusic.duration,
          })
            .then((asset) => placeAssetAt(asset.id, "audio", t, audioRow))
            .catch(() => {});
          return;
        }

        // A stock clip imports as footage, an image ref as a still, then each
        // lands in the resolved video slot.
        if (stockVideo && projectId) {
          e.preventDefault();
          void importStockVideo(projectId, {
            url: stockVideo.url,
            name: stockVideo.name,
            duration: stockVideo.duration,
            width: stockVideo.width,
            height: stockVideo.height,
          })
            .then((asset) => placeAssetAt(asset.id, "video", t, 0, videoPlace))
            .catch(() => {});
          return;
        }
        if (still && projectId) {
          e.preventDefault();
          void importImage(projectId, still)
            .then((asset) => placeAssetAt(asset.id, "image", t, 0, videoPlace))
            .catch(() => {});
        }
      }}
    >
      <div
        className="tl-resize absolute inset-x-0 top-0 z-30 h-1.5 cursor-row-resize"
        title="Drag to resize the timeline"
        onPointerDown={resize}
      />
      {/* Three tracks with the transport in the middle, so playback sits centred
          on the timeline and holds its place whatever flanks it. The editing
          tools and the zoom both fold into one menu on the right when the bar
          runs out of room: which of them is on screen may change with the
          window, but the play controls never do. */}
      <div
        ref={barRef}
        className="relative grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-border"
      >
        {/* Clipped, so a tool can never reach the transport however the
            measurement below lands: the overlap stops being something to get
            right and becomes something that cannot be drawn. */}
        <div className="col-start-1 row-start-1 ml-2.5 flex min-w-0 items-center gap-0.5 overflow-hidden">
          {!barTight && (
            <TimelineTools
              labels={barLabels}
              split={split}
              addText={addText}
              deleteSelection={deleteSelection}
              selectionCount={multiSelection.length}
            />
          )}
        </div>

        {/* The two widths the fit is decided against, laid out and never shown.
            Measuring the row on screen instead would ask it how wide it is in
            the state it is already in, which cannot say whether the labels it
            just dropped would fit again — these always can. */}
        <div aria-hidden className="invisible pointer-events-none absolute flex items-center gap-0.5">
          <div ref={toolsFullRef} className="flex items-center gap-0.5">
            <TimelineTools
              labels
              split={split}
              addText={addText}
              deleteSelection={deleteSelection}
              selectionCount={multiSelection.length}
            />
          </div>
          <div ref={toolsBareRef} className="flex items-center gap-0.5">
            <TimelineTools
              labels={false}
              split={split}
              addText={addText}
              deleteSelection={deleteSelection}
              selectionCount={multiSelection.length}
            />
          </div>
        </div>

        <div ref={transportRef} className="col-start-2 row-start-1 flex items-center">
          <Transport total={total} />
        </div>

        <div className="col-start-3 row-start-1 mr-2.5 flex min-w-0 items-center justify-end gap-2 overflow-hidden">
          <div
            ref={zoomRef}
            className={cn(
              "flex items-center gap-2",
              barTight && "invisible absolute right-0 pointer-events-none"
            )}
          >
            <Slider
              className="data-horizontal:w-28"
              min={0}
              max={100}
              step={0.1}
              value={zoomToSlider(pps, zoomMin)}
              aria-label="Zoom"
              onValueChange={(v) => zoomTo(sliderToZoom(Number(v), zoomMin))}
            />
            <Button variant="ghost" size="sm" title="Fit timeline to window" onClick={fit}>
              Fit
            </Button>
          </div>
          {barTight && (
            <TimelineToolsMenu
              pps={pps}
              zoomMin={zoomMin}
              zoomTo={zoomTo}
              fit={fit}
              split={split}
              addText={addText}
              deleteSelection={deleteSelection}
              selectionCount={multiSelection.length}
            />
          )}
        </div>
      </div>

      {/* Rubber-band overscroll translates the scroller's content and
          background wholesale, so the wrapper behind it paints the resting
          picture the bounce reveals: the card-white ruler band (with its
          baseline) over the track gray. The scroller stays transparent — the
          underlay IS the timeline's surface. */}
      <div
        className="relative min-h-0 flex-1 bg-muted"
        onPointerEnter={() => setTrackHover(true)}
        onPointerLeave={() => setTrackHover(false)}
      >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div ref={rulerUnderlayRef} className="absolute inset-x-0 top-0">
          <RestingSurface railYs={railYs} empty={total <= 0} timelineH={timelineH} />
        </div>
      </div>
      <RulerBand />
      {marquee && (
        <div
          className="pointer-events-none fixed z-50 rounded-[3px] border-2 border-[#0a84ff]"
          style={marquee}
        />
      )}
      {/* Where the carried row will sit once it lands. The rows have already
          closed up around the slot; the outline says it is the one. */}
      {rowDrag && rowDrag.to !== rowDrag.from && (
        <div
          className="pointer-events-none fixed z-50 rounded-md border border-dashed border-[#0a84ff]/70 bg-[#0a84ff]/5"
          style={{
            top: landingBox(rowDrag).top,
            height: landingBox(rowDrag).h,
            left: rowDrag.left,
            width: rowDrag.width,
          }}
        />
      )}
      <div
        ref={scrollRef}
        data-tl-scroll
        className="tl-scroll relative h-full overflow-auto overscroll-y-none"
      >
        {/* The side padding paints as timeline surface, so it scrubs like it:
            a press in the left strip reads as a negative time and seek clamps
            it to 0. */}
        <div
          className="relative flex min-h-full min-w-full flex-col"
          style={{ width: contentW + PAD_SIDE * 2 }}
          onPointerDown={deselectIfSelf}
        >
          <div
            ref={innerRef}
            className="tl-content relative flex-1 pb-2"
            style={{ width: contentW, marginLeft: PAD_SIDE }}
            onPointerDown={deselectIfSelf}
          >
          {/* An empty project reads as a stack of resting tracks: the same
              hairline rails the video rows draw, repeating to the bottom. */}
          {total <= 0 && (
            <div
              className="pointer-events-none absolute bottom-0"
              style={{
                top: RULER_H,
                left: -PAD_SIDE,
                right: -PAD_SIDE,
                background: REST_RAILS,
              }}
            />
          )}
          {/* Pinned over the vertical scroll: the rows slide under the band,
              the way the timeline runs under the gutter. The band paints its
              own surface pad to pad, and the playhead cap rides in it so the
              time being pointed at can always be grabbed. */}
          <div className="sticky top-0 z-50" style={{ height: RULER_H }}>
            <div
              className="absolute top-0 border-b border-border bg-card"
              style={{ height: RULER_H, left: -PAD_SIDE, width: contentW + PAD_SIDE * 2 }}
            />
            <Ruler pps={pps} width={contentW} onScrub={scrub} />
            <PlayheadCap pps={pps} onScrub={scrub} />
          </div>

          {/* Elements ride above the clip stack, the way they sit over the
              picture. New effects open the top row; a drag moves any of them
              to any row. */}
          {(overlays.length > 0 || elementDrop !== null) && (
            <div
              ref={overlayRef}
              data-tl-trows=""
              className="relative mt-1.5"
              style={{
                height:
                  Math.max(
                    overlayLanes.count,
                    // An in-flight element drag shows its whole landing area —
                    // only the rows it can actually reach.
                    laneDrag?.kind === "overlay" ? laneDrag.maxRow + 1 : 0,
                    // A panel drag over an empty band opens the first row for
                    // its landing preview.
                    elementDrop !== null ? elementDrop.row + 1 : 0
                  ) *
                    TEXT_H +
                  topRowShift,
              }}
              onPointerDown={deselectIfSelf}
              onContextMenu={openStackedGapMenu("overlay", TEXT_H, overlayLanes.used)}
            >
              {Array.from({ length: overlayLanes.count }, (_, r) =>
                laneRail((r + 1) * TEXT_H - 4 + topRowShift, r)
              )}
              {overlayLanes.used.map((lane, r) => (
                <Fragment key={`tgap-${lane}`}>
                  {gapHighlight(
                    { kind: "overlay", index: lane },
                    TEXT_H - 6,
                    stackedRowTop("overlay", r, TEXT_H) + topRowShift
                  )}
                </Fragment>
              ))}
              {elementDrop !== null &&
                (() => {
                  const el = draggingElement();
                  const family = el?.kind === "effect" ? "effect" : "element";
                  const sticker = el ? null : draggedSticker();
                  const chip =
                    el?.kind === "shape" ? (
                      <>
                        {(() => {
                          const Icon = SHAPE_CHIP_ICONS[el.shape];
                          return <Icon className="mr-1 size-2.5 shrink-0" />;
                        })()}
                        {SHAPE_LABELS[el.shape]}
                      </>
                    ) : el?.kind === "effect" ? (
                      <>
                        <Sparkles className="mr-1 size-2.5 shrink-0" />
                        {EFFECT_LABELS[el.effect]}
                      </>
                    ) : (
                      <>
                        {sticker && !isLottieAsset(sticker) ? (
                          // eslint-disable-next-line @next/next/no-img-element -- project media URL
                          <img
                            src={sticker.url}
                            alt=""
                            className="mr-1 size-4 shrink-0 object-contain"
                          />
                        ) : (
                          <Sticker className="mr-1 size-2.5 shrink-0" />
                        )}
                        Sticker
                      </>
                    );
                  return (
                    <>
                      <div
                        className={cn(
                          "pointer-events-none absolute inset-x-0 rounded-md border border-dashed",
                          FAMILY_STYLE[family].row
                        )}
                        style={{ top: elementDrop.row * TEXT_H + 2, height: TEXT_H - 6 }}
                      />
                      {/* The slot the drop takes on its row... */}
                      <div
                        className={cn(
                          "pointer-events-none absolute rounded-md",
                          FAMILY_STYLE[family].slot
                        )}
                        style={{
                          top: elementDrop.row * TEXT_H + 2,
                          height: TEXT_H - 6,
                          left: elementDrop.t * pps,
                          width: Math.max(14, ELEMENT_DROP_SECONDS * pps - CLIP_GAP),
                        }}
                      />
                      {/* ...and the bar itself carried at the pointer, the
                          way a bar drag's ghost rides. */}
                      <div
                        className={cn(
                          "pointer-events-none absolute z-20 flex items-center overflow-hidden rounded-md opacity-80 shadow-2xl",
                          FAMILY_STYLE[family].bar
                        )}
                        style={{
                          top: elementDrop.y,
                          height: TEXT_H - 6,
                          left: elementDrop.t * pps,
                          width: Math.max(14, ELEMENT_DROP_SECONDS * pps - CLIP_GAP),
                        }}
                      >
                        <span className="pointer-events-none flex min-w-0 items-center truncate px-2 text-[10.5px] font-medium text-white">
                          {chip}
                        </span>
                      </div>
                    </>
                  );
                })()}
              {/* The new row above, revealed once the drag heads past the top
                  edge — showing it any earlier would push every row down
                  under a freshly grabbed bar. */}
              {topRowShift > 0 && (
                <div
                  className={cn(
                    "pointer-events-none absolute inset-x-0 rounded-md border border-dashed",
                    FAMILY_STYLE[draggedFamily].row
                  )}
                  style={{ top: 2, height: TEXT_H - 6 }}
                />
              )}
              {laneDrag?.kind === "overlay" &&
                Array.from({ length: laneDrag.maxRow + 1 }, (_, r) => (
                  <div
                    key={r}
                    className={cn(
                      "pointer-events-none absolute inset-x-0 rounded-md border border-dashed transition-colors",
                      r === laneDrag.targetRow
                        ? FAMILY_STYLE[draggedFamily].row
                        : FAMILY_STYLE[draggedFamily].rowIdle
                    )}
                    style={{ top: r * TEXT_H + 2 + topRowShift, height: TEXT_H - 6 }}
                  />
                ))}
              {laneDrag?.kind === "overlay" && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={TEXT_H}
                  barH={TEXT_H - 6}
                  shift={topRowShift}
                  className={cn("rounded-md", FAMILY_STYLE[draggedFamily].slot)}
                />
              )}
              {overlays.map((o) => {
                const homeRow = overlayLanes.rowOf.get(o.lane ?? 0) ?? 0;
                const drag = laneDrag?.kind === "overlay" && laneDrag.id === o.id ? laneDrag : null;
                return (
                  <TextBar
                    key={o.id}
                    overlay={o}
                    pps={pps}
                    top={stackedRowTop("overlay", homeRow, TEXT_H) + topRowShift}
                    homeRow={homeRow}
                    rowMove={
                      rowDrag?.band === "overlay"
                        ? homeRow === rowDrag.from
                          ? "lift"
                          : "part"
                        : null
                    }
                    laneCount={overlayLanes.count}
                    selected={selKeys.has(`overlay:${o.id}`)}
                    drag={drag}
                    parting={laneDrag?.kind === "overlay" && laneDrag.id !== o.id}
                    onDrag={setLaneDrag}
                    onSnap={setSnapX}
                    onMenu={setBarMenu}
                  />
                );
              })}
            </div>
          )}

          {/* Transitions: free bars on their own row. Each plays the cut or
              clip edge it lines up with, and sits parked anywhere else. */}
          {(transitions.length > 0 || jointDrop !== null || xTileDrag) && (
            <div
              data-tl-xrows=""
              className="relative mt-1.5"
              style={{ height: TEXT_H }}
              onPointerDown={deselectIfSelf}
            >
              {laneRail(TEXT_H - 4, "xrail")}
              {(transitionDrag !== null || xTileDrag) &&
                // While a transition is in flight, every place it could play
                // lights up in the timeline's usual drop-zone dress: one slot
                // per cut and open edge, each the size the bar would take
                // there.
                anchors.map((a) => {
                  const len = transitionDrag ? transitionDrag.t.seconds : a.len;
                  return (
                    <div
                      key={`xzone-${a.kind}-${a.clipId}`}
                      className="pointer-events-none absolute rounded-md bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)]"
                      style={{
                        left: anchorBarStart(a, len) * pps,
                        top: 2,
                        width: Math.max(14, len * pps - CLIP_GAP),
                        height: TEXT_H - 6,
                      }}
                    />
                  );
                })}
              {jointDrop && (
                // The zone the drop is aimed at burns brighter than the rest.
                <div
                  className="pointer-events-none absolute rounded-md bg-[#0a84ff]/25 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.85)]"
                  style={{
                    left: anchorBarStart(jointDrop, jointDrop.len) * pps,
                    top: 2,
                    width: Math.max(14, jointDrop.len * pps - CLIP_GAP),
                    height: TEXT_H - 6,
                  }}
                />
              )}
              {transitions.map((live) => {
                const x = transitionDrag?.t.id === live.t.id ? transitionDrag : live;
                const Icon = TRANSITION_ICONS[x.t.style];
                const playing = !!x.role;
                return (
                  <div
                    key={x.t.id}
                    role="button"
                    tabIndex={0}
                    title={`${x.label} ${x.t.seconds.toFixed(1)}s — drag it anywhere along the row; it plays where it lines up with a cut or a clip edge`}
                    className={cn(
                      "tl-xfade-bar group absolute flex cursor-grab items-center gap-1 overflow-hidden rounded-md px-1.5 text-[10.5px] font-medium text-white shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]",
                      // A parked bar reads muted: it is on the row but playing
                      // nothing until a boundary lines up with it.
                      playing ? "bg-[#2B6FD4]" : "bg-muted-foreground/50",
                      selKeys.has(`transition:${x.t.id}`) && SELECTED_SHADOW,
                      // Mid-drag it rides over the zone it would land on, so
                      // the marked room stays readable underneath.
                      x === transitionDrag && "opacity-75"
                    )}
                    style={{
                      left: x.t.start * pps,
                      top: 2,
                      width: Math.max(14, x.t.seconds * pps - CLIP_GAP),
                      height: TEXT_H - 6,
                    }}
                    data-tl-sel={`transition:${x.t.id}`}
                    onPointerDown={(e) => moveTransition(e, x)}
                  >
                    <Icon className="size-2.5 shrink-0" />
                    <span className="truncate">{x.label}</span>
                    {/* Retiming pulls the loose end: an entrance runs forward
                        from the clip's head, everything else backward from the
                        boundary it sits on. */}
                    <span
                      title="Drag to retime"
                      className={cn(
                        trimHandle,
                        x.role?.kind === "in" ? "tl-trim-r right-0" : "tl-trim-l left-0"
                      )}
                      onPointerDown={(e) => trimTransition(e, x)}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* A drag carried above the stack opens a new top layer: the row
              grows in here and folds away when the drag comes back down. */}
          {newTrackRow(topInsertLevel)}
          {aboveTracks.map((track, row) => {
            const railH = railFor(overlayTrackSpans.get(track) ?? []);
            const lifted = rowDrag?.band === "video" && rowDrag.from === row;
            return (
            <div
              key={`ov-${track}`}
              className={cn(
                "relative mt-1.5",
                rowDrag?.band === "video" && !lifted && "transition-transform duration-150 ease-out",
                lifted && "pointer-events-none z-20 opacity-90 drop-shadow-2xl"
              )}
              style={{
                height: OVERLAY_H + railH,
                transform: videoRowShift(row) ? `translateY(${videoRowShift(row)}px)` : undefined,
              }}
              data-tl-vrow={track}
              onPointerDown={deselectIfSelf}
              onContextMenu={openGapMenu({ kind: "video", index: track })}
              {...overlayDropHandlers}
            >
              {laneRail(OVERLAY_H - 2 + railH)}
              {gapHighlight({ kind: "video", index: track }, OVERLAY_H - 4)}
              {draggedOverlayTrack === track && laneDrag && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={OVERLAY_H}
                  barH={OVERLAY_H - 4}
                  className="rounded-lg bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)]"
                />
              )}
              {(overlayTrackSpans.get(track) ?? []).map((span) => (
                <ClipView
                  key={span.clip.id}
                  span={span}
                  pps={pps}
                  selected={selKeys.has(`clip:${span.clip.id}`)}
                  drag={
                    laneDrag?.kind === "overlayClip" && laneDrag.id === span.clip.id
                      ? laneDrag
                      : null
                  }
                  parting={
                    (laneDrag?.kind === "overlayClip" && laneDrag.id !== span.clip.id) ||
                    videoDragActive
                  }
                  partAt={dropPartAt.get(span.clip.id)}
                  onDrag={setLaneDrag}
                  onSnap={setSnapX}
                  resolveTarget={resolveDropTrack}
                  onCrossMove={previewCross}
                  onCrossDrop={onOverlayCrossDrop}
                  onDragActive={setVideoDragging}
                  onFrameMenu={openFrameMenu}
                />
              ))}
              {trackSlot({ kind: "track", track }, OVERLAY_H - 4)}
            </div>
            );
          })}

          {/* An empty track 0 disappears like any other empty track. It
              renders while it has clips, while the whole project is empty
              (the first drop target), for the length of an external media
              drag, or once a drag targets it. An empty one that no row shows
              is reached by carrying the clip under the stack: the new-track
              row below opens track 0 again. */}
          {(spans.length > 0 ||
            total <= 0 ||
            dropType === "video" ||
            samePlacement(overlayDrop?.target ?? null, TRACK_ZERO)) && (
          <div
            className={cn(
              "relative mt-1.5",
              rowDrag?.band === "video" &&
                (rowDrag.from === aboveTracks.length
                  ? "pointer-events-none z-20 opacity-90 drop-shadow-2xl"
                  : "transition-transform duration-150 ease-out")
            )}
            style={{
              height: VIDEO_H + rail0,
              transform: videoRowShift(aboveTracks.length)
                ? `translateY(${videoRowShift(aboveTracks.length)}px)`
                : undefined,
            }}
            data-tl-vrow={0}
            onPointerDown={deselectIfSelf}
            onContextMenu={openGapMenu({ kind: "video", index: 0 })}
          >
            {spans.length > 0 && laneRail(VIDEO_H - 2 + rail0)}
            {gapHighlight({ kind: "video", index: 0 }, VIDEO_H - 4)}
            {trackSlot(TRACK_ZERO, VIDEO_H - 4)}
            {laneDrag?.kind === "clip" && !laneDrag.away && (
              <LaneSlot
                drag={laneDrag}
                pps={pps}
                rowH={VIDEO_H}
                barH={VIDEO_H - 4}
                className="rounded-lg bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4),inset_0_2px_10px_rgba(10,60,140,0.08)]"
              />
            )}
            {assetDrop &&
              dropSegment(assetDrop.t, assetDrop.len, VIDEO_H - 4, assetDrop.ghost)}
            {spans.map((span, i) => (
              <ClipView
                key={span.clip.id}
                span={span}
                mention={`@c${i + 1}`}
                pps={pps}
                selected={selKeys.has(`clip:${span.clip.id}`)}
                drag={laneDrag?.kind === "clip" && laneDrag.id === span.clip.id ? laneDrag : null}
                parting={
                  (laneDrag?.kind === "clip" && laneDrag.id !== span.clip.id) || videoDragActive
                }
                partAt={dropPartAt.get(span.clip.id)}
                onDrag={setLaneDrag}
                onSnap={setSnapX}
                resolveTarget={resolveDropTrack}
                onCrossMove={previewCross}
                onCrossDrop={onClipCrossDrop}
                onDragActive={setVideoDragging}
                onFrameMenu={openFrameMenu}
              />
            ))}
          </div>
          )}

          {/* A drag carried under the stack grows it downward — nothing above
              moves. Dropping here opens a new track 0: the whole stack
              renumbers up and the spine (ripple, transitions) transplants onto
              the drop. */}
          {newTrackRow(bottomInsertLevel)}

          {(audioClips.length > 0 || audioDrop !== null) && (
            <div
              ref={audioRef}
              data-tl-arows=""
              className="relative mt-1.5"
              style={{
                height:
                  Math.max(
                    audioLanes.count,
                    // An in-flight audio drag shows its whole landing area —
                    // only the rows it can actually reach.
                    laneDrag?.kind === "audio" ? laneDrag.maxRow + 1 : 0,
                    (audioDrop?.row ?? -1) + 1
                  ) * AUDIO_H,
              }}
              onPointerDown={deselectIfSelf}
              onContextMenu={openStackedGapMenu("audio", AUDIO_H, audioLanes.used)}
            >
              {Array.from({ length: audioLanes.count }, (_, r) =>
                laneRail((r + 1) * AUDIO_H - 2, r)
              )}
              {audioLanes.used.map((lane, r) => (
                <Fragment key={`agap-${lane}`}>
                  {gapHighlight(
                    { kind: "audio", index: lane },
                    AUDIO_H - 4,
                    stackedRowTop("audio", r, AUDIO_H)
                  )}
                </Fragment>
              ))}
              {laneDrag?.kind === "audio" &&
                Array.from({ length: laneDrag.maxRow + 1 }, (_, r) => (
                  <div
                    key={r}
                    className={cn(
                      "pointer-events-none absolute inset-x-0 rounded-[7px] border border-dashed transition-colors",
                      r === laneDrag.targetRow
                        ? "border-emerald-500/70 bg-emerald-500/5"
                        : "border-emerald-500/25"
                    )}
                    style={{ top: r * AUDIO_H + 2, height: AUDIO_H - 4 }}
                  />
                ))}
              {audioDrop && (
                <div
                  className="tl-audio-drop-slot pointer-events-none absolute rounded-[7px] border-[1.5px] border-dashed border-emerald-500/80 bg-emerald-500/10 transition-[left] duration-150 ease-out"
                  style={{
                    left: audioDrop.t * pps,
                    top: audioDrop.row * AUDIO_H + 2,
                    width: Math.max(10, audioDrop.len * pps - CLIP_GAP),
                    height: AUDIO_H - 4,
                  }}
                />
              )}
              {laneDrag?.kind === "audio" && !laneDrag.away && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={AUDIO_H}
                  barH={AUDIO_H - 4}
                  className="rounded-[7px] bg-emerald-500/10 shadow-[inset_0_0_0_1.5px_rgba(16,185,129,0.5)]"
                />
              )}
              {audioClips.map((a) => {
                const homeRow = audioLanes.rowOf.get(a.lane ?? 0) ?? 0;
                const drag = laneDrag?.kind === "audio" && laneDrag.id === a.id ? laneDrag : null;
                return (
                  <AudioView
                    key={a.id}
                    clip={a}
                    asset={assets.find((x) => x.id === a.assetId)}
                    mention={audioMentions.get(a.id)}
                    pps={pps}
                    top={stackedRowTop("audio", homeRow, AUDIO_H)}
                    homeRow={homeRow}
                    rowMove={
                      rowDrag?.band === "audio"
                        ? homeRow === rowDrag.from
                          ? "lift"
                          : "part"
                        : null
                    }
                    laneCount={audioLanes.count}
                    selected={selKeys.has(`audio:${a.id}`)}
                    drag={drag}
                    parting={laneDrag?.kind === "audio" && laneDrag.id !== a.id}
                    onDrag={setLaneDrag}
                    onSnap={setSnapX}
                  />
                );
              })}
            </div>
          )}

          {subtitles.showOnTimeline && subtitles.cues.length > 0 && (
            <div
              data-tl-srows=""
              className="tl-sub-track relative mt-1.5"
              style={{ height: subtitleLaneCount(subtitles) * SUB_H }}
              onPointerDown={deselectIfSelf}
            >
              {/* Cue lanes are fixed language tracks that may be empty; only
                  the occupied ones read as rows. */}
              {[...new Set(subtitles.cues.map((c) => c.lane ?? 0))].map((lane) =>
                laneRail((lane + 1) * SUB_H - 3, lane)
              )}
              {laneDrag?.kind === "cue" && (
                // A cue belongs to its language track, so that one row is the
                // whole landing area while the ghost floats free.
                <div
                  className="pointer-events-none absolute inset-x-0 rounded-[5px] border border-dashed border-amber-500/50"
                  style={{ top: laneDrag.targetRow * SUB_H + 1, height: SUB_H - 4 }}
                />
              )}
              {laneDrag?.kind === "cue" && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={SUB_H}
                  barH={SUB_H - 4}
                  className="rounded-[5px] bg-amber-400/15 shadow-[inset_0_0_0_1.5px_rgba(245,158,11,0.55)]"
                />
              )}
              {subtitles.cues.map((c) => (
                <SubBar
                  key={c.id}
                  cue={c}
                  dimmed={laneHidden(subtitles, c.lane ?? 0)}
                  pps={pps}
                  top={(c.lane ?? 0) * SUB_H}
                  homeRow={c.lane ?? 0}
                  selected={selKeys.has(`cue:${c.id}`)}
                  drag={laneDrag?.kind === "cue" && laneDrag.id === c.id ? laneDrag : null}
                  parting={laneDrag?.kind === "cue" && laneDrag.id !== c.id}
                  onDrag={setLaneDrag}
                  onSnap={setSnapX}
                />
              ))}
            </div>
          )}

            {snapX !== null && (
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-[#ff2d55]"
                style={{ left: snapX }}
              />
            )}
            <HoverLine
              scrollRef={scrollRef}
              innerRef={innerRef}
              pps={pps}
              hold={frameMenu !== null}
            />
            <Playhead pps={pps} scrollRef={scrollRef} onScrub={scrub} />
          </div>
        </div>
      </div>
      {/* The gutter: the strip of surface at the left edge, held out of the
          scroll so the timeline runs under it instead of carrying it away.
          It is the width of the content's left pad, so at rest it sits over
          empty surface and the timeline looks no different — but the column
          is now a fixed place on screen, which is what per-track controls
          need. It paints the resting surface (rails following vertical
          scroll, the ruler band pinned like the live one) and passes
          presses through to the scrubbing surface beneath; controls will take
          their own pointer events when they land. Its face shows only once
          the timeline has scrolled: at rest the underlay behind the scroller
          paints the same pixels, and staying clear lets a clip at 0 keep the
          left side of its selection ring. */}
      <div
        ref={gutterFaceRef}
        className="pointer-events-none absolute inset-y-0 left-0 z-40 overflow-hidden bg-muted opacity-0 transition-opacity duration-150 data-scrolled:opacity-100"
        style={{ width: PAD_SIDE }}
      >
        <div ref={gutterRef} className="absolute inset-0">
          <RestingSurface railYs={railYs} empty={total <= 0} timelineH={timelineH} />
        </div>
        <RulerBand />
      </div>
      {/* Cast off the gutter's right edge alone, once the timeline has scrolled
          — that shadow is the whole tell that clips are running underneath
          rather than stopping there. A blurred box-shadow on the gutter would
          spill over its top and bottom too, so the edge draws its own strip:
          the same height as the gutter, starting where it ends. */}
      <div
        ref={gutterShadowRef}
        className="pointer-events-none absolute inset-y-0 z-40 w-2 bg-gradient-to-r from-black/20 to-transparent opacity-0 transition-opacity duration-150 data-scrolled:opacity-100"
        style={{ left: PAD_SIDE }}
      />
      {/* Track-wide toggles in the gutter column: an eye (and a speaker, when
          the track carries sound) per video track, a speaker per soundtrack
          lane. Resting toggles show while the pointer is over the track area;
          one whose track has anything off stays visible so the strip reads as
          the enabled/disabled readout. */}
      <div
        // Clipped below the ruler band, so a toggle scrolled to the top slides
        // under the band instead of riding up over it and the toolbar.
        className="pointer-events-none absolute bottom-0 left-0 z-50 overflow-hidden"
        style={{ width: PAD_SIDE, top: RULER_H }}
      >
        <div ref={gutterCtlRef} className="absolute inset-x-0 bottom-0" style={{ top: -RULER_H }}>
          {/* Each row's gutter cell is the handle for the row itself: press and
              carry it to another place in its own band. Drawn before the
              toggles so an eye or a speaker still takes its own press. */}
          {gutterYs.video.map(({ track, y, h }, row) => (
            <RowGrip
              key={`vgrip-${track}`}
              top={y}
              height={h}
              barH={VIDEO_H - 4}
              enabled={gutterYs.video.length > 1}
              onGrab={gripRow("video", row)}
            />
          ))}
          {gutterYs.textTop !== null &&
            overlayLanes.used.map((lane, r) => (
              <RowGrip
                key={`tgrip-${lane}`}
                top={gutterYs.textTop! + stackedRowTop("overlay", r, TEXT_H)}
                height={TEXT_H}
                barH={TEXT_H - 6}
                enabled={overlayLanes.count > 1}
                onGrab={gripRow("overlay", r)}
              />
            ))}
          {gutterYs.audioTop !== null &&
            audioLanes.used.map((lane, r) => (
              <RowGrip
                key={`agrip-${lane}`}
                top={gutterYs.audioTop! + stackedRowTop("audio", r, AUDIO_H)}
                height={AUDIO_H}
                barH={AUDIO_H - 4}
                enabled={audioLanes.count > 1}
                onGrab={gripRow("audio", r)}
              />
            ))}
          {gutterYs.video.map(({ track, y }, row) => {
            const t = trackState.get(track);
            if (!t) return null;
            const rows: React.ReactNode[] = [
              <GutterToggle
                key={`v-${track}-hide`}
                kind="hide"
                off={t.hidden === t.total}
                partial={t.hidden > 0}
                reveal={trackHover}
                top={y + (t.sound > 0 ? VIDEO_H / 2 - 22 : VIDEO_H / 2 - 8)}
                onGrab={gripRow("video", row)}
                onToggle={() =>
                  useEditor.getState().setTrackHidden(track, t.hidden !== t.total)
                }
              />,
            ];
            if (t.sound > 0)
              rows.push(
                <GutterToggle
                  key={`v-${track}-mute`}
                  kind="mute"
                  off={t.muted === t.sound}
                  partial={t.muted > 0}
                  reveal={trackHover}
                  top={y + VIDEO_H / 2 + 6}
                  onGrab={gripRow("video", row)}
                  onToggle={() =>
                    useEditor.getState().setTrackMuted(track, t.muted !== t.sound)
                  }
                />
              );
            return rows;
          })}
          {gutterYs.audioTop !== null &&
            audioLanes.used.map((lane, r) => {
              const t = audioLaneState.get(lane);
              if (!t) return null;
              return (
                <GutterToggle
                  key={`a-${lane}`}
                  kind="mute"
                  off={t.hidden === t.total}
                  partial={t.hidden > 0}
                  reveal={trackHover}
                  top={gutterYs.audioTop! + stackedRowTop("audio", r, AUDIO_H) + AUDIO_H / 2 - 8}
                  onGrab={gripRow("audio", r)}
                  onToggle={() =>
                    useEditor.getState().setAudioLaneHidden(lane, t.hidden !== t.total)
                  }
                />
              );
            })}
          {gutterYs.textTop !== null &&
            overlayLanes.used.map((lane, r) => {
              const t = textLaneState.get(lane);
              if (!t) return null;
              return (
                <GutterToggle
                  key={`t-${lane}`}
                  kind="hide"
                  off={t.hidden === t.total}
                  partial={t.hidden > 0}
                  reveal={trackHover}
                  top={gutterYs.textTop! + stackedRowTop("overlay", r, TEXT_H) + TEXT_H / 2 - 8}
                  onGrab={gripRow("overlay", r)}
                  onToggle={() =>
                    useEditor.getState().setTextLaneHidden(lane, t.hidden !== t.total)
                  }
                />
              );
            })}
          {gutterYs.subTop !== null &&
            Array.from({ length: subtitleLaneCount(subtitles) }, (_, lane) => {
              const off = laneHidden(subtitles, lane);
              return (
                <GutterToggle
                  key={`s-${lane}`}
                  kind="hide"
                  off={off}
                  partial={false}
                  reveal={trackHover}
                  top={gutterYs.subTop! + lane * SUB_H + SUB_H / 2 - 8}
                  onToggle={() => {
                    const s = useEditor.getState();
                    s.pushHistory();
                    s.setSubtitleTrackMeta(lane, { hidden: off ? undefined : true });
                  }}
                />
              );
            })}
        </div>
      </div>
      </div>
      {/* Subtle valid-target hint while an OS media drag is over the window:
          a tint and inset ring over the track area, under the toolbar. */}
      {fileDropHint && (
        <div className="pointer-events-none absolute inset-x-0 top-11 bottom-0 z-40 bg-[#0a84ff]/5 ring-2 ring-[#0a84ff]/30 ring-inset" />
      )}
      {gapMenu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setGapMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setGapMenu(null);
          }}
        >
          <div
            className="absolute min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            style={{ left: gapMenu.x, top: gapMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                useEditor.getState().removeLaneGap(gapMenu.lane, gapMenu.gap.start);
                setGapMenu(null);
              }}
            >
              <Scissors className="size-3.5 text-muted-foreground" /> Remove empty space
            </button>
          </div>
        </div>
      )}
      {barMenu &&
        (() => {
          const o = overlays.find((x) => x.id === barMenu.id);
          if (!o) return null;
          const item =
            "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground";
          return (
            <div
              className="fixed inset-0 z-50"
              onPointerDown={() => setBarMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setBarMenu(null);
              }}
            >
              <div
                className="absolute min-w-44 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
                style={{ left: barMenu.x, top: barMenu.y }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {barMenu.key !== undefined && (
                  <button
                    className={item}
                    onClick={() => {
                      const s = useEditor.getState();
                      s.pushHistory();
                      s.removeOverlayKey(barMenu.id, barMenu.key!);
                      setBarMenu(null);
                    }}
                  >
                    <Diamond className="size-3.5 text-muted-foreground" /> Remove keyframe
                  </button>
                )}
                <button
                  className={item}
                  onClick={() => {
                    useEditor.getState().updateOverlay(barMenu.id, { hidden: !o.hidden });
                    setBarMenu(null);
                  }}
                >
                  {o.hidden ? (
                    <>
                      <Eye className="size-3.5 text-muted-foreground" /> Show
                    </>
                  ) : (
                    <>
                      <EyeOff className="size-3.5 text-muted-foreground" /> Hide
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })()}
      {frameMenu && (
        <div
          className="fixed inset-0 z-50"
          onPointerDown={() => setFrameMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setFrameMenu(null);
          }}
        >
          {/* A snug bubble beside the held marker line, speech-balloon style:
              its tapered tip sits on the side edge facing the line, apex
              touching it at the grab point. The bubble hangs to the line's
              right and flips left when the window edge is close. */}
          {(() => {
            const flip = frameMenu.x + 240 > window.innerWidth;
            return (
              <div
                className={cn("absolute -translate-y-1/2", flip ? "pr-[6px]" : "pl-[6px]")}
                style={{
                  top: frameMenu.y,
                  ...(flip
                    ? { right: window.innerWidth - frameMenu.x }
                    : { left: frameMenu.x }),
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      void sendFrameToChat(
                        { ...refFromAsset(frameMenu.asset), t: frameMenu.srcT },
                        frameMenu.from
                      );
                      setFrameMenu(null);
                    }}
                  >
                    <Fullscreen className="size-3.5 text-muted-foreground" /> Capture frame
                  </button>
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm whitespace-nowrap hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      void copyRefImage({
                        ...refFromAsset(frameMenu.asset),
                        t: frameMenu.srcT,
                      }).catch(() => {});
                      setFrameMenu(null);
                    }}
                  >
                    <Copy className="size-3.5 text-muted-foreground" /> Copy frame
                  </button>
                </div>
                {/* Drawn after the bubble so the diamond's inner half covers
                    its border along the notch, leaving one seamless outline. */}
                <div
                  className={cn(
                    "pointer-events-none absolute top-1/2 size-2.5 -translate-y-1/2 rotate-45 bg-popover",
                    flip
                      ? "right-[2px] rounded-tr-[2px] border-t border-r"
                      : "left-[2px] rounded-bl-[2px] border-b border-l"
                  )}
                />
              </div>
            );
          })()}
        </div>
      )}
    </footer>
  );
}

/**
 * The skimmer: a line that follows the mouse over the timeline. It marks
 * where Split (⌘B / S) will cut; clicking still moves the playhead itself.
 */
function HoverLine({
  scrollRef,
  innerRef,
  pps,
  hold,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  innerRef: React.RefObject<HTMLDivElement | null>;
  pps: number;
  /** The frame-grab menu owns the skim: the skimmer neither moves nor clears
   * it, and the line darkens — the marker is the skimmer, held. */
  hold: boolean;
}) {
  const skimTime = useSkim();
  useEffect(() => () => setSkim(null), []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || hold) return;
    // The inner box only moves when the timeline scrolls or zooms, so its left
    // edge is read once per gesture instead of once per pointer event — the
    // read forces a layout, and a scrub issues hundreds of them.
    let left = 0;
    let measured = false;
    const remeasure = () => {
      measured = false;
    };
    const move = (e: PointerEvent) => {
      const inner = innerRef.current;
      // The skimmer is a paused affordance: while the cut is playing the
      // picture belongs to the playhead, wherever the pointer happens to rest.
      if (!inner || e.buttons || useEditor.getState().playing) return setSkim(null);
      if (!measured) {
        left = inner.getBoundingClientRect().left;
        measured = true;
      }
      const t = (e.clientX - left) / useEditor.getState().pxPerSec;
      setSkim(Math.max(0, t));
    };
    const leave = () => {
      remeasure();
      setSkim(null);
    };
    el.addEventListener("scroll", remeasure, { passive: true });
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("scroll", remeasure);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, [scrollRef, innerRef, hold]);
  if (skimTime === null) return null;
  return (
    <div
      className={cn(
        "tl-hover-line pointer-events-none absolute top-0 bottom-0 z-30 w-px will-change-transform",
        hold ? "bg-foreground/70" : "bg-foreground/30"
      )}
      style={{ transform: `translateX(${skimTime * pps}px)` }}
    />
  );
}

/**
 * Saves the current multi-selection as a by-reference template in this
 * project's Media — the source media plus the edit that arranges it, never a
 * flattened video. Re-adding it re-materializes editable clips, overlays, and
 * captions; the Media panel can push it to the shared Library.
 */
/** The timeline's editing tools. Dropping `labels` leaves the icons on their
 * own — the step between a full toolbar and folding the lot into the menu. */
function TimelineTools({
  labels,
  split,
  addText,
  deleteSelection,
  selectionCount,
}: {
  labels: boolean;
  split: () => void;
  addText: () => void;
  deleteSelection: () => void;
  selectionCount: number;
}) {
  const size = labels ? "sm" : "icon-sm";
  return (
    <>
      <Button
        variant="ghost"
        size={size}
        title="Split at pointer, or at playhead (⌘B or S)"
        onClick={split}
      >
        <Scissors />
        {labels && <span>Split</span>}
      </Button>
      <Button variant="ghost" size={size} title="Text (T)" onClick={addText}>
        <Type />
        {labels && <span>Text</span>}
      </Button>
      <Button
        variant="ghost"
        size={size}
        title="Delete (⌫)"
        disabled={selectionCount === 0}
        onClick={deleteSelection}
      >
        <Trash2 />
        {labels && <span>{selectionCount > 1 ? `Delete ${selectionCount}` : "Delete"}</span>}
      </Button>
      <SaveSelectionButton labels={labels} />
    </>
  );
}

/** Everything the toolbar drops when it runs out of room, listed. The zoom is
 * a row rather than an item — it is a control to work, not a command to pick,
 * so it keeps the slider and the menu stays open around it. */
function TimelineToolsMenu({
  pps,
  zoomMin,
  zoomTo,
  fit,
  split,
  addText,
  deleteSelection,
  selectionCount,
}: {
  pps: number;
  zoomMin: number;
  zoomTo: (next: number, anchorT?: number, anchorPx?: number) => void;
  fit: () => void;
  split: () => void;
  addText: () => void;
  deleteSelection: () => void;
  selectionCount: number;
}) {
  const save = useSaveSelection();
  // Held open, because the zoom row is not a pick: dragging the slider has to
  // leave the menu standing, while Fit beside it closes as any command would.
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Timeline tools" title="Timeline tools" />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={split}>
          <Scissors /> Split
        </DropdownMenuItem>
        <DropdownMenuItem onClick={addText}>
          <Type /> Text
        </DropdownMenuItem>
        <DropdownMenuItem disabled={selectionCount === 0} onClick={deleteSelection}>
          <Trash2 /> {selectionCount > 1 ? `Delete ${selectionCount}` : "Delete"}
        </DropdownMenuItem>
        {save.available && (
          <DropdownMenuItem disabled={save.state === "saving"} onClick={save.save}>
            {save.state === "done" ? <Check /> : <FolderPlus />}
            {save.state === "done" ? "Saved" : "Save template"}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {/* The zoom as it reads in the toolbar: the slider with Fit beside it. */}
        <div className="flex items-center gap-2 px-1.5 py-1">
          <div
            className="min-w-0 flex-1"
            // A press on the slider is a drag, not a pick — it must not reach
            // the menu, which would take it as a choice and close.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <Slider
              min={0}
              max={100}
              step={0.1}
              value={zoomToSlider(pps, zoomMin)}
              aria-label="Zoom"
              onValueChange={(v) => zoomTo(sliderToZoom(Number(v), zoomMin))}
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            title="Fit timeline to window"
            onClick={() => {
              fit();
              setOpen(false);
            }}
          >
            Fit
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Saving the selection as a template: the state behind both the toolbar
 * button and the menu row that replaces it. */
function useSaveSelection() {
  const multiSelection = useEditor((s) => s.multiSelection);
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  const save = () => {
    const s = useEditor.getState();
    const input = s.selectionTemplate();
    if (!input) return;
    s.addTemplate(input);
    setState("done");
    setTimeout(() => setState("idle"), 1800);
  };
  return { available: multiSelection.length > 0, state, save };
}

function SaveSelectionButton({ labels = true }: { labels?: boolean }) {
  const { available, state, save } = useSaveSelection();
  if (!available) return null;
  return (
    <Button
      variant="ghost"
      size={labels ? "sm" : "icon-sm"}
      title="Save the selection as a reusable template (kept by reference)"
      disabled={state === "saving"}
      onClick={save}
    >
      {state === "saving" ? (
        <Loader2 className="animate-spin" />
      ) : state === "done" ? (
        <Check />
      ) : (
        <FolderPlus />
      )}
      {labels && <span>{state === "done" ? "Saved" : "Save template"}</span>}
    </Button>
  );
}

/** The running time, on its own so the transport's buttons stay off the clock. */
function Timecode() {
  return <span className="tc-now">{formatTimecode(usePlayhead())}</span>;
}

/** Playback transport, centered in the timeline toolbar. */
function Transport({ total }: { total: number }) {
  const playing = useEditor((s) => s.playing);
  const hasClips = total > 0;

  const toggle = () => {
    const s = useEditor.getState();
    if (!s.playing && playheadAt() >= total - 0.01) s.seek(0);
    s.setPlaying(!s.playing);
  };

  return (
    // In flow, in the toolbar's centre track: centred by the grid rather than
    // by being lifted out of it, so the tools beside it are laid out around
    // playback instead of underneath it.
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back to start"
        disabled={!hasClips}
        onClick={() => useEditor.getState().seek(0)}
      >
        <SkipBack className="fill-current" />
      </Button>
      <button
        className="grid size-8 place-items-center rounded-full bg-foreground text-background transition-transform hover:opacity-90 active:scale-95 disabled:opacity-40"
        title="Play/Pause (Space)"
        disabled={!hasClips}
        onClick={toggle}
      >
        {playing ? (
          <Pause className="size-4 fill-current stroke-none" />
        ) : (
          <Play className="ml-0.5 size-4 fill-current stroke-none" />
        )}
      </button>
      <div className="flex min-w-30 items-baseline gap-1.5 font-mono text-xs tabular-nums">
        <Timecode />
        <span className="text-muted-foreground">/</span>
        <span className="text-muted-foreground">{formatTimecode(total)}</span>
      </div>
    </div>
  );
}


function Ruler({
  pps,
  width,
  onScrub,
}: {
  pps: number;
  width: number;
  onScrub: (e: React.PointerEvent) => void;
}) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60];
  const step = steps.find((s) => s * pps >= 64) ?? 120;
  const count = Math.ceil(width / (step * pps));
  const ticks = Array.from({ length: count }, (_, i) => i * step);
  return (
    <div className="relative cursor-ew-resize" style={{ height: RULER_H }} onPointerDown={onScrub}>
      {ticks.map((t) => (
        <div
          key={t}
          className="absolute top-0 bottom-0 border-l border-foreground/15 pl-1.5"
          style={{ left: t * pps }}
        >
          <span className="font-mono text-[9.5px] leading-6 text-muted-foreground select-none">
            {formatTime(t)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Playhead({
  pps,
  scrollRef,
  onScrub,
}: {
  pps: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScrub: (e: React.PointerEvent) => void;
}) {
  const playing = useEditor((s) => s.playing);
  const ref = useRef<HTMLDivElement>(null);

  // Follow the playhead while playing, but yield to the user: any manual
  // scroll pauses following, which resumes after 5s of scroll idle. The
  // follow's own writes are told apart from user scrolls by matching the
  // scroll-event echo against the value it just wrote.
  const manualUntil = useRef(0);
  const followWrote = useRef<number | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (followWrote.current !== null && Math.abs(el.scrollLeft - followWrote.current) < 1) {
        followWrote.current = null;
        return;
      }
      followWrote.current = null;
      manualUntil.current = performance.now() + 5000;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef]);

  // The marker is one transform. Rendering a component sixty times a second to
  // write one style property costs a reconcile per frame and moves the same
  // pixel, so the subscription writes it directly and the scroll-follow rides
  // along in the same callback.
  useEffect(() => {
    const move = () => {
      const el = ref.current;
      if (!el) return;
      const x = playheadAt() * pps;
      el.style.transform = `translateX(${x}px)`;
      const scroller = scrollRef.current;
      if (!scroller || !playing) return;
      if (performance.now() < manualUntil.current) return;
      const sx = x + PAD_SIDE; // playhead position in scroll coordinates
      if (sx < scroller.scrollLeft + 24 || sx > scroller.scrollLeft + scroller.clientWidth - 80) {
        scroller.scrollLeft = Math.max(0, sx - 80);
        followWrote.current = scroller.scrollLeft; // read back: the browser clamps
      }
    };
    move();
    return subscribePlayhead(move);
  }, [pps, playing, scrollRef]);

  return (
    <div
      ref={ref}
      // Over the gutter as well as the clips: at 0 the playhead stands on the
      // gutter's own edge. The clips pass under the gutter; the time it is
      // showing does not. The grab cap lives in the pinned ruler.
      // will-change: the line moves sixty times a second; its own compositor
      // layer keeps each move off the tracks layer's paint, where a machine
      // that falls behind leaves ghost lines at old positions.
      className="pointer-events-none absolute top-0 bottom-0 left-0 z-50 w-[1.5px] bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.6)] will-change-transform"
    />
  );
}

/** The playhead's grab cap, riding the pinned ruler band — the side padding
 * is there so it is never clipped at 0. */
function PlayheadCap({
  pps,
  onScrub,
}: {
  pps: number;
  onScrub: (e: React.PointerEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const move = () => {
      if (ref.current) ref.current.style.transform = `translateX(${playheadAt() * pps}px)`;
    };
    move();
    return subscribePlayhead(move);
  }, [pps]);
  return (
    <div
      ref={ref}
      className="tl-playhead-cap absolute top-0 left-[-7px] h-5 w-4 cursor-ew-resize will-change-transform"
      onPointerDown={onScrub}
    >
      <div className="mx-auto h-3 w-2.5 rounded-t-[3px] bg-[#0a84ff] [clip-path:polygon(0_0,100%_0,100%_58%,50%_100%,0_58%)]" />
    </div>
  );
}


/**
 * One video clip's box, on track 0 or on an upper track. Every video track
 * draws the same bar — filmstrip, chips, keys, trim grips — and the row it
 * sits on decides the two things that differ: the spine carries the chat
 * mention and the detach-audio action, and the lane gestures are keyed to it.
 * Full-frame upper clips (`scale === 1`) read as a stacked composite; smaller
 * ones are picture-in-picture. Hidden clips gray out.
 */
function ClipView({
  span,
  mention,
  pps,
  selected,
  drag,
  parting,
  partAt,
  onDrag,
  onSnap,
  resolveTarget,
  onCrossMove,
  onCrossDrop,
  onDragActive,
  onFrameMenu,
}: {
  span: ClipSpan;
  /** The clip's chat mention token ("@c2"), shown on hover so the user can
   * point the assistant at this exact segment. Track 0 only — the spine is
   * what the assistant addresses. */
  mention?: string;
  pps: number;
  selected: boolean;
  /** This clip's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another clip on this row is dragging: animate this one's parting shifts. */
  parting: boolean;
  /** The start this clip previews at while a hovering drop parts its row. */
  partAt?: number;
  onDrag: (d: LaneDrag | null) => void;
  onSnap: (x: number | null) => void;
  /** Which drop the given screen point is over: a video row, or a new track
   * past the stack's edge. The carried clip's id decides whether a new track
   * is on offer at all. */
  resolveTarget: (clientX: number, clientY: number, draggedId?: string) => TrackTarget;
  /** Preview a cross-track drop (null clears it). */
  onCrossMove: (target: TrackTarget | null, start?: number, len?: number) => void;
  /** Commit a cross-track drop of this clip at `start`. */
  onCrossDrop: (id: string, target: TrackTarget, start: number) => void;
  /** Toggle the between-track insertion zones while this clip is dragging. */
  onDragActive: (active: boolean) => void;
  /** Right-click: offer the frame under the pointer to the chat composer. */
  onFrameMenu: (
    e: React.MouseEvent,
    grab: { asset: MediaAsset; srcT: number; from: FrameGrabOrigin }
  ) => void;
}) {
  const { clip, asset } = span;
  // The row the clip lives on names its lane; the two gesture kinds write
  // through different store actions.
  const lane: LaneKind = clip.track === 0 ? "clip" : "overlayClip";
  const spine = lane === "clip";
  const loading = useEditor((s) => s.loadingMedia.has(asset.fileName));
  const speed = clipSpeed(clip);
  // Every box is its clip's whole footprint. Clips never overlap — a
  // transition is a render-time blend at the cut, drawn as the bar above the
  // tracks — so a box's width is the clip's own length, whatever joins it.
  const w = Math.max(10, span.len * pps);
  const filmIn = clip.in;
  const filmOut = filmIn + span.len * speed;

  const startFrame = useEdgeFrame(asset, filmIn, `${clip.id}:in`);
  const endFrame = useEdgeFrame(asset, filmOut, `${clip.id}:out`);
  const stripFailed = useSyncExternalStore(
    subscribeStripStatus,
    () => stripFailedFor(asset.id),
    () => false
  );
  const boxRef = useRef<HTMLDivElement>(null);
  // The clip's own sound, drawn in the box's band under the picture. Muting —
  // detach included — takes the sound off the clip, so the band drops and the
  // box stops at the filmstrip (a detached copy draws on the soundtrack row).
  const hasWave = asset.type === "video" && !clip.muted && !!asset.peaks?.length;
  // Bumped as tile captures land, so the memo re-plans and picks them up.
  const [filmGen, onTileFrame] = useReducer((x: number) => x + 1, 0);
  const filmstrip = useMemo(
    () =>
      filmstripFrames(asset, filmIn, w, pps, speed, FILM_H, 26, {
        start: startFrame,
        end: endFrame,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [asset, filmIn, w, pps, speed, startFrame, endFrame, filmGen]
  );
  useTileFrames(boxRef, clip.id, asset, filmstrip, filmIn, w, pps, speed, onTileFrame);

  // The move gesture is the shared lane behavior (parting, snapping); its
  // verticality is the video placement system — the other tracks and the new
  // tracks past the stack — resolved from the rows' geometry.
  const ui = {
    pps,
    rowH: VIDEO_H,
    laneCount: 0,
    homeRow: 0,
    visStart: span.start,
    onDrag,
    onSnap,
    vertical: {
      resolve: (ev: PointerEvent) => resolveTarget(ev.clientX, ev.clientY, clip.id),
      isHome: (t: TrackTarget) => samePlacement(t, { kind: "track", track: clip.track }),
      preview: (t: TrackTarget | null, start: number, len: number) =>
        t ? onCrossMove(t, start, len) : onCrossMove(null),
      commit: (id: string, t: TrackTarget, start: number) => onCrossDrop(id, t, start),
      setActive: onDragActive,
    },
  };

  return (
    <>
    <div
      className={cn(
        "tl-clip group absolute top-0.5 cursor-grab overflow-hidden rounded-lg bg-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
        selected && SELECTED_SHADOW,
        clip.hidden && "opacity-40 grayscale",
        drag
          ? "tl-clip-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : (partAt ?? span.start) * pps,
        top: drag ? 2 + drag.ghostY : undefined,
        width: Math.max(10, w - CLIP_GAP),
        height: hasWave ? VIDEO_H - 4 : FILM_H,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      ref={boxRef}
      data-tl-sel={`clip:${clip.id}`}
      onPointerDown={(e) => startLaneMove(e, lane, clip.id, ui)}
      onContextMenu={(e) => {
        if (asset.type !== "video") return;
        const rect = e.currentTarget.getBoundingClientRect();
        onFrameMenu(e, {
          asset,
          srcT: filmIn + ((e.clientX - rect.left) / pps) * speed,
          from: { x: e.clientX, top: rect.top, height: rect.height },
        });
      }}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: FILM_H }}>
        <Filmstrip frames={filmstrip} grade={clip.grade} failed={stripFailed} />
      </div>
      {hasWave && (
        <div
          className="tl-clip-wave pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-b from-[#59c09d] to-[#43b18d]"
          style={{ height: WAVE_H }}
        >
          <WaveformCanvas asset={asset} from={filmIn} to={filmOut} w={w} h={WAVE_H - 4} className="inset-x-0 inset-y-0.5" />
        </div>
      )}
      {selected && (
        // A blue wash over the whole clip so a multi-selection reads at a
        // glance, not just from the thin border.
        <div className="pointer-events-none absolute inset-0 z-[1] bg-[#0a84ff]/25" />
      )}
      {mention &&
        (drag ? (
          <span className="tl-dur-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] tabular-nums text-white">
            {(Math.round(span.len * 10) / 10).toFixed(1)}s
          </span>
        ) : loading ? null : (
          <span className="tl-mention-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
            {mention}
          </span>
        ))}
      {loading && <LoadingChip />}
      {asset.type === "video" && !loading && (
        <MuteChip
          muted={clip.muted}
          className="bottom-1 left-1"
          onToggle={() => useEditor.getState().updateClip(clip.id, { muted: !clip.muted })}
        />
      )}
      {(clip.speed ?? 1) !== 1 && (
        <span
          className="tl-speed-chip absolute right-[30px] bottom-1 z-2 rounded-[5px] bg-black/70 px-1 py-px font-mono text-[9.5px] tabular-nums text-white"
          title={`${clip.speed}× speed`}
        >
          {+(clip.speed ?? 1).toFixed(2)}×
        </span>
      )}
      {!loading && (
        <HideChip
          hidden={!!clip.hidden}
          className="bottom-1 right-2"
          onToggle={() => useEditor.getState().updateClip(clip.id, { hidden: !clip.hidden })}
        />
      )}
      {!loading && (
        <ClipMenu asset={asset} clip={clip}>
          {spine && asset.type === "video" ? (
            <DropdownMenuItem
              disabled={clip.muted}
              onClick={() => {
                const s = useEditor.getState();
                s.select({ kind: "clip", id: clip.id });
                s.detachAudio();
                void ensurePeaks(asset);
              }}
            >
              <AudioLines /> Detach audio
            </DropdownMenuItem>
          ) : null}
        </ClipMenu>
      )}
      {/* Keys sit on the bar where they fall — pose and mask tracks both —
          so the animation is visible without opening the inspector. */}
      {(clip.kf ?? []).map((k) => (
        <KeyMarker
          key={k.t}
          item={{ id: clip.id, start: span.start, end: span.start + span.len }}
          kind="clip"
          t={k.t}
          pps={pps}
          width={w}
        />
      ))}
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, lane, clip.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, lane, clip.id, "r", ui)}
      />
    </div>
    <ClipMaskKeyStrip clip={clip} start={span.start} len={span.len} pps={pps} w={w} hidden={!!drag} />
    </>
  );
}

/** The clip's mask keys, on a thin rail under its box: a hairline spanning
 * the clip's width with a diamond on it per key. The bar itself clips its
 * children (rounded corners), so the rail is a sibling that follows the
 * clip's own left edge. It hides while the clip rides a drag ghost and comes
 * back where the clip lands. */
function ClipMaskKeyStrip({
  clip,
  start,
  len,
  pps,
  w,
  hidden,
}: {
  clip: VideoClip;
  start: number;
  len: number;
  pps: number;
  w: number;
  hidden: boolean;
}) {
  if (hidden || !clip.mask?.kf?.length) return null;
  return (
    <div
      className="pointer-events-none absolute z-5"
      style={{
        left: start * pps,
        // A hair below the bar's bottom edge, deep enough that the diamonds —
        // the picked one's ring included — never touch the clip's box.
        top: VIDEO_H - 1,
        width: Math.max(10, w - CLIP_GAP),
        height: 16,
      }}
    >
      <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-[#ff9f0a]/45" />
      {clip.mask.kf.map((k) => (
        <KeyMarker
          key={`m${k.t}`}
          item={{ id: clip.id, start, end: start + len }}
          kind="clip"
          track="mask"
          t={k.t}
          pps={pps}
          width={w}
        />
      ))}
    </div>
  );
}

/** Render just this timeline item through the normal export pipeline: a
 * one-clip cut at the project aspect, trimmed and paced like the segment on
 * the timeline, landing in the project's exports folder and the dock like any
 * full export. */
function exportSegment(asset: MediaAsset, clip: VideoClip | AudioClip) {
  const s = useEditor.getState();
  if (!s.projectId) return;
  // AudioClip has no `track`; a hidden segment still renders when exported alone.
  const doc: ExportDoc =
    "track" in clip
      ? {
          aspect: s.aspect,
          assets: [asset],
          clips: [{ ...clip, start: 0, track: 0, hidden: undefined }],
          audioClips: [],
          overlays: [],
          subtitles: emptySubtitles(),
        }
      : {
          aspect: s.aspect,
          assets: [asset],
          clips: [],
          audioClips: [{ ...clip, start: 0, hidden: undefined }],
          overlays: [],
          subtitles: emptySubtitles(),
        };
  const settings = originalSettings(s.aspect, doc.clips, doc.assets);
  void useExports.getState().start(s.projectId, doc, settings, s.projectName);
}

/** The "⋮" menu on a timeline item. Every item gets the same filing pair —
 * move its asset into the Media panel (drop the `origin` tag) or copy it into
 * the shared library — plus a solo export, and slots item-specific actions
 * above them via `children`. */
function ClipMenu({
  asset,
  clip,
  children,
}: {
  asset: MediaAsset;
  clip: VideoClip | AudioClip;
  children?: ReactNode;
}) {
  const caps = useCutCaps();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label="Clip options"
            className="tl-clip-menu absolute top-1 right-2 z-4 grid size-[18px] place-items-center rounded-[5px] bg-black/55 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/75"
            onPointerDown={(e) => e.stopPropagation()}
          />
        }
      >
        <EllipsisVertical className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {children}
        {children != null && <DropdownMenuSeparator />}
        <DropdownMenuItem
          onClick={() =>
            // Clearing the origin files it into Media; a chat-owned asset also
            // sheds its thread so deleting the chat won't touch it.
            useEditor.getState().updateAsset(asset.id, { origin: undefined, chatId: undefined })
          }
        >
          <Clapperboard /> Add to Media
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            const projectId = useEditor.getState().projectId;
            if (!projectId) return;
            void saveAssetToLibrary(projectId, asset).catch(() => {
              // Library write failed; nothing to roll back.
            });
          }}
        >
          <FolderPlus /> Add to Library
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportSegment(asset, clip)}>
          <ArrowDownToLine /> Export segment
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!!asset.upload}
          onClick={() => {
            // The source file whole, as it was imported — the trimmed version
            // is what "Export segment" renders.
            const projectId = useEditor.getState().projectId;
            if (projectId) downloadMedia(projectId, asset);
          }}
        >
          <Download /> Download
        </DropdownMenuItem>
        {caps.revealInFinder && (
          <DropdownMenuItem
            onClick={() => {
              const projectId = useEditor.getState().projectId;
              if (!projectId) return;
              void revealMedia(projectId, asset.fileName).catch(() => {});
            }}
          >
            <FolderOpen /> Show in Finder
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the drag ghost knows about the media under the cursor — enough to
 * tile the segment at the source's aspect before the asset exists in the
 * project. */
type DropGhost = {
  /** Playable source: a project media URL, a stock file, a library route. */
  url: string;
  kind: "video" | "image";
  /** Source width/height ratio when known; 16:9 stands in until a frame says. */
  aspect?: number;
  /** Pre-sampled filmstrip (project assets) — true frames with no reads. */
  thumbs?: string[];
  thumbStep?: number;
  /** One known frame (a poster) to repeat while true frames are read. */
  poster?: string;
};

/** The ghost segment's filmstrip. An image tiles itself at its natural aspect.
 * A video with a filmstrip samples it exactly like a placed clip. Anything
 * else paints every tile with the best frame in hand — the poster at first —
 * and swaps each tile to the true frame at its source time as the edge-frame
 * reader captures them, so a fresh drag sharpens into a real strip within a
 * beat. Tile times depend on the source alone, not the drop position, so the
 * strip never re-reads while the segment slides along the row. */
function DropGhostFilm({
  ghost,
  w,
  h,
  pps,
}: {
  ghost: DropGhost;
  w: number;
  h: number;
  pps: number;
}) {
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const aspect = ghost.aspect ?? 16 / 9;
  const natural = Math.max(24, Math.round(h * aspect));
  const count = Math.max(1, Math.min(120, Math.ceil(w / natural)));
  const imgW = Math.max(natural, w / count);
  const needsReads = ghost.kind === "video" && !ghost.thumbs?.length;
  useEffect(() => {
    if (!needsReads) return;
    let live = true;
    for (let k = 0; k < count; k++) {
      const t = (k * imgW + imgW / 2) / pps;
      if (peekEdgeFrame(ghost.url, t)) continue;
      void requestEdgeFrame(`drop-ghost:${k}`, ghost.url, t).then((src) => {
        if (live && src) bump();
      });
    }
    return () => {
      live = false;
    };
  }, [needsReads, ghost.url, count, imgW, pps]);
  if (ghost.kind === "image") {
    // The browser tiles the image at its own aspect — no measuring needed.
    return (
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `url("${ghost.url}")`,
          backgroundSize: "auto 100%",
          backgroundRepeat: "repeat-x",
        }}
      />
    );
  }
  const tiles: { src: string | null; left: number }[] = [];
  let known: string | null = ghost.poster ?? null;
  for (let k = 0; k < count; k++) {
    const t = (k * imgW + imgW / 2) / pps;
    let src: string | null = null;
    if (ghost.thumbs?.length && ghost.thumbStep) {
      src =
        ghost.thumbs[
          Math.min(ghost.thumbs.length - 1, Math.max(0, Math.floor(t / ghost.thumbStep)))
        ];
    } else {
      src = peekEdgeFrame(ghost.url, t);
    }
    if (src) known = src;
    tiles.push({ src: src ?? known, left: k * imgW });
  }
  return (
    <div className="pointer-events-none absolute inset-0">
      {tiles.map(
        (tile, k) =>
          tile.src && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={k}
              src={tile.src}
              alt=""
              draggable={false}
              className="absolute top-0 h-full object-cover"
              style={{ left: tile.left, width: imgW }}
            />
          )
      )}
    </div>
  );
}

/** Sample a clip's filmstrip tiles across its drawn width. Tiles sit on a
 * source-time grid: the strip holds still while a trimmed edge sweeps across
 * it, hiding frames under the handle (the box's overflow clips the partial
 * tiles at each end). Tiles keep the asset's aspect until the box would blow
 * the tile cap; past that they widen by whole grid cells, still on the grid.
 * The first and last tiles pin to the segment's exact boundary frames once
 * captured; middle tiles show the nearest pre-sampled thumb until the zoom
 * outruns the strip's sampling, when each carries a true frame at its own
 * moment as its capture lands (see `planFilmstrip`). */
function filmstripFrames(
  asset: MediaAsset | undefined,
  filmIn: number,
  w: number,
  pps: number,
  speed: number,
  tileH: number,
  minTileW: number,
  edges?: { start: string | null; end: string | null }
): FilmTile[] {
  if (!asset?.thumbs?.length || !asset.thumbStep) return [];
  const frames = planFilmstrip({
    thumbs: asset.thumbs,
    thumbStep: asset.thumbStep,
    duration: asset.duration,
    aspect: (asset.width ?? 16) / Math.max(1, asset.height ?? 9),
    filmIn,
    w,
    pps,
    speed,
    tileH,
    minTileW,
    cuts: asset.sceneCuts,
    exactFrame: asset.type === "video" ? (t) => peekEdgeFrame(asset.url, t) : undefined,
  });
  if (edges?.start) frames[0] = { ...frames[0], src: edges.start };
  if (edges?.end && frames.length > 1) {
    frames[frames.length - 1] = { ...frames[frames.length - 1], src: edges.end };
  }
  return frames;
}

/** How far past the scroller's view a tile still gets its true frame, so a
 * small scroll shows captured tiles at once. */
const TILE_CAPTURE_MARGIN = 240;

/** Capture the true frames a zoomed strip's tiles ask for. The plan names a
 * capture time on each tile the pre-sampled strip is too coarse for; this
 * effect requests the ones inside the scroller's view (plus a margin) through
 * the edge reader's background lane and re-renders as they land. Scroll fills
 * in newly visible tiles; a zoom or trim re-aims the same per-tile slots, so
 * superseded captures fall away on their own. */
function useTileFrames(
  boxRef: React.RefObject<HTMLDivElement | null>,
  clipId: string,
  asset: MediaAsset | undefined,
  tiles: FilmTile[],
  filmIn: number,
  w: number,
  pps: number,
  speed: number,
  onFrame: () => void
) {
  // The landed-frame re-render hands this hook a fresh `tiles` array with the
  // same geometry; the ref keeps that from re-running the capture effect,
  // while scroll and the effect body always read the newest plan.
  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  });
  const wanted = tiles.some((t) => t.wantT !== null);
  useEffect(() => {
    const box = boxRef.current;
    const url = asset?.type === "video" ? asset.url : null;
    if (!box || !url || !wanted) return;
    const scroller = box.closest("[data-tl-scroll]") as HTMLElement | null;
    let live = true;
    let scheduled = false;
    let bumping = false;
    // One request per capture time per plan: a failed read stays quiet until
    // a zoom or trim re-plans, and a scroll walk re-asks for nothing.
    const asked = new Set<string>();
    const landed = () => {
      if (bumping) return;
      bumping = true;
      requestAnimationFrame(() => {
        bumping = false;
        if (live) onFrame();
      });
    };
    const request = () => {
      scheduled = false;
      if (!live) return;
      let lo = 0;
      let hi = w;
      if (scroller) {
        const boxR = box.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        lo = view.left - boxR.left - TILE_CAPTURE_MARGIN;
        hi = view.right - boxR.left + TILE_CAPTURE_MARGIN;
      }
      tilesRef.current.forEach((t, i) => {
        if (t.wantT === null || t.exact) return;
        if (t.left + t.width < lo || t.left > hi) return;
        const key = `${i}:${t.wantT.toFixed(2)}`;
        if (asked.has(key)) return;
        asked.add(key);
        void requestEdgeFrame(`${clipId}:tile:${i}`, url, t.wantT, undefined, {
          background: true,
        }).then((src) => {
          if (live && src) landed();
        });
      });
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(request);
    };
    schedule();
    scroller?.addEventListener("scroll", schedule, { passive: true });
    return () => {
      live = false;
      scroller?.removeEventListener("scroll", schedule);
    };
    // Geometry names the plan; `tiles` itself rides the ref above.
  }, [boxRef, clipId, asset, wanted, filmIn, w, pps, speed, onFrame]);
}

/** The exact source frame at a clip edge. Returns null (the nearest sampled
 * thumb shows instead) until the capture lands; a changed edge time falls back
 * immediately so a trim drag never shows a stale exact frame. */
function useEdgeFrame(asset: MediaAsset | undefined, time: number, slot: string) {
  const url = asset?.type === "video" ? asset.url : null;
  const id = url ? `${url}#${time.toFixed(2)}` : "";
  const cached = url ? peekEdgeFrame(url, time) : null;
  const [frame, setFrame] = useState<{ id: string; src: string } | null>(null);
  useEffect(() => {
    if (!url || cached) return;
    let live = true;
    void requestEdgeFrame(slot, url, time).then((src) => {
      if (live && src) setFrame({ id, src });
    });
    return () => {
      live = false;
    };
  }, [url, time, slot, id, cached]);
  return cached ?? (frame?.id === id ? frame.src : null);
}

/** A clip box's thumbnail strip, washed with the clip's color grade: the same
 * CSS filter the preview uses plus the warm tint as a multiply blend, so the
 * strip tracks the grade with no thumbnail regeneration (thumbs live on the
 * shared asset; the wash is per clip). `isolate` keeps the blend inside the
 * strip. */
function Filmstrip({
  frames,
  grade,
  failed,
}: {
  frames: { src: string; left: number; width: number }[];
  grade?: ColorGrade;
  /** The strip's last generation attempt failed: hold a still placeholder.
   * An endless pulse reads as loading forever, and animating a clip-width
   * element burns paint time for the life of the timeline. */
  failed?: boolean;
}) {
  // The filmstrip is a 40px always-on surface: the grade renders as a CSS
  // approximation (exact for the scalar sliders and the preset's scalars;
  // curves/wheels/hue bands show in the preview and exports).
  const { filter, tint } = gradeCssApprox(grade);
  // No thumbs yet — the media is still streaming into the browser store. A
  // pulsing skeleton fills the box until the strip can draw real frames.
  if (!frames.length) {
    if (failed) {
      return (
        <div className="tl-filmstrip-failed pointer-events-none absolute inset-0 bg-accent" />
      );
    }
    // The clip box under the strip is black; a backdrop in the page color
    // keeps the pulse between accent and background, the stock skeleton look.
    return (
      <div className="tl-filmstrip-skeleton pointer-events-none absolute inset-0 bg-background">
        <Skeleton className="size-full rounded-none" />
      </div>
    );
  }
  return (
    <div
      className="tl-filmstrip pointer-events-none absolute inset-0 isolate"
      style={{ filter: filter || undefined }}
    >
      {frames.map((f, k) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={k}
          src={f.src}
          alt=""
          draggable={false}
          className="absolute top-0 h-full object-cover"
          style={{ left: f.left, width: f.width }}
        />
      ))}
      {tint && (
        <div className="absolute inset-0" style={{ backgroundColor: tint, mixBlendMode: "multiply" }} />
      )}
    </div>
  );
}

/** A track-wide toggle pinned in the gutter column. Rests invisible until the
 * pointer is over the track area; while anything on its track is off it stays
 * visible on its own, the off glyph fading to say "some segments" versus the
 * full-strength "whole track". A click always turns the whole track off, and
 * the next click turns every segment back on — individually disabled segments
 * included. */
/** One row's gutter cell, and the handle for the whole row: pressing it picks
 * the row up and carries it to another place in its own band. A band with a
 * single row has no reorder in it, so the cell stays out of the way and the
 * gutter scrubs there as it always did. */
function RowGrip({
  top,
  height,
  barH,
  enabled,
  onGrab,
}: {
  top: number;
  height: number;
  /** The band's bar height, so the hover surface lines up with the bars on
   * the row instead of the row box they sit inside. */
  barH: number;
  enabled: boolean;
  onGrab: (e: React.PointerEvent) => void;
}) {
  if (!enabled) return null;
  return (
    <div
      title="Drag to reorder the row"
      className="group pointer-events-auto absolute inset-x-0 cursor-grab"
      style={{ top, height }}
      onPointerDown={onGrab}
    >
      <span
        className="pointer-events-none absolute inset-x-0 bg-foreground/10 opacity-0 transition-opacity group-hover:opacity-100"
        style={{ top: 2, height: barH }}
      />
    </div>
  );
}

function GutterToggle({
  kind,
  off,
  partial,
  reveal,
  top,
  onToggle,
  onGrab,
}: {
  kind: "hide" | "mute";
  off: boolean;
  partial: boolean;
  reveal: boolean;
  top: number;
  onToggle: () => void;
  /** Grab the row this toggle rides. A press that travels is a row drag; one
   * that does not is a click on the toggle and nothing more. */
  onGrab?: (e: React.PointerEvent) => void;
}) {
  const active = off || partial;
  const title =
    kind === "hide"
      ? off
        ? "Show track"
        : "Hide track"
      : off
        ? "Unmute track"
        : "Mute track";
  const Icon = kind === "hide" ? (active ? EyeOff : Eye) : active ? VolumeX : Volume2;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      className={cn(
        "tl-track-toggle pointer-events-auto absolute left-[3px] grid size-4 place-items-center transition-opacity",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        active
          ? partial && !off
            ? "opacity-60 hover:opacity-100"
            : "opacity-100"
          : reveal
            ? "opacity-100"
            : "pointer-events-none opacity-0"
      )}
      style={{ top }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!onGrab || e.button !== 0) return;
        const x = e.clientX;
        const y = e.clientY;
        const drop = () => {
          window.removeEventListener("pointermove", travel);
          window.removeEventListener("pointerup", drop);
          window.removeEventListener("pointercancel", drop);
        };
        // Once the press has travelled it belongs to the row, so the gesture
        // hands over from the press's own point and the click never lands.
        const travel = (ev: PointerEvent) => {
          if (Math.abs(ev.clientX - x) <= 3 && Math.abs(ev.clientY - y) <= 3) return;
          drop();
          onGrab(e);
        };
        window.addEventListener("pointermove", travel);
        window.addEventListener("pointerup", drop);
        window.addEventListener("pointercancel", drop);
      }}
      onClick={onToggle}
    >
      <Icon className="size-3" />
    </button>
  );
}

function HideChip({
  hidden,
  onToggle,
  className,
  small,
}: {
  hidden: boolean;
  onToggle: () => void;
  className?: string;
  /** The element bars are low; the chip steps down to fit them. */
  small?: boolean;
}) {
  return (
    <button
      type="button"
      title={hidden ? "Enable clip" : "Disable clip"}
      aria-label={hidden ? "Enable clip" : "Disable clip"}
      className={cn(
        "tl-hide-chip absolute z-4 grid place-items-center rounded-[5px] bg-black/55 text-white transition-opacity hover:bg-black/75",
        small ? "size-[13px]" : "size-[18px]",
        hidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        className
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
    >
      {hidden ? (
        <EyeOff className={small ? "size-2" : "size-3"} />
      ) : (
        <Eye className={small ? "size-2" : "size-3"} />
      )}
    </button>
  );
}

/** Corner chip for a timeline item whose media is still streaming into the
 * browser store. It sits where the hover controls live — the controls stay
 * off until the bytes land and the item scrubs, plays, and edits instantly. */
function LoadingChip() {
  return (
    <span className="tl-loading-chip pointer-events-none absolute bottom-1 left-1 z-4 grid size-[18px] place-items-center rounded-[5px] bg-black/55 text-white">
      <Loader2 className="size-3 animate-spin" />
    </span>
  );
}

/** Hover chip that toggles a clip's own audio. Stays visible while the clip is
 * muted so unmuting is one click. */
function MuteChip({
  muted,
  onToggle,
  className,
}: {
  muted: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={muted ? "Unmute clip" : "Mute clip"}
      aria-label={muted ? "Unmute clip" : "Mute clip"}
      className={cn(
        "tl-mute-chip absolute z-4 grid size-[18px] place-items-center rounded-[5px] bg-black/55 text-white transition-opacity hover:bg-black/75",
        muted ? "opacity-100 bg-black/70" : "opacity-0 group-hover:opacity-100",
        className
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
    >
      {muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
    </button>
  );
}

/** Waveform bars for the slice of `asset` between source times `from` and
 * `to`, stretched across a `w`px bar. Each bar folds the max of every peak
 * bucket it covers, so a zoomed-out strip keeps its transients. */
function WaveformCanvas({
  asset,
  from,
  to,
  w,
  h,
  className,
}: {
  asset: MediaAsset;
  from: number;
  to: number;
  w: number;
  h: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peaks = asset.peaks;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks?.length) return;
    // Cap the backing store below browser canvas limits; the element is
    // CSS-stretched to the bar, so past the cap bars widen instead of the
    // tail going bare (a canvas keeps its intrinsic width under inset-x-0).
    const width = Math.min(16384, Math.round(w));
    canvas.width = width;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    const n = peaks.length;
    const bars = Math.max(1, Math.floor(width / 3));
    const start = (from / asset.duration) * n;
    const perBar = (((to - from) / asset.duration) * n) / bars;
    for (let i = 0; i < bars; i++) {
      const a = Math.max(0, Math.min(n - 1, Math.floor(start + i * perBar)));
      const b = Math.max(a + 1, Math.ceil(start + (i + 1) * perBar));
      let p = 0;
      for (let j = a; j < b && j < n; j++) if (peaks[j] > p) p = peaks[j];
      const bh = Math.max(1.5, p * (h - 2));
      ctx.fillRect(i * 3, (h - bh) / 2, 2, bh);
    }
  }, [asset.duration, peaks, from, to, w, h]);
  if (!peaks?.length) return null;
  return <canvas ref={canvasRef} className={cn("pointer-events-none absolute w-full", className)} />;
}

function AudioView({
  clip,
  asset,
  mention,
  pps,
  top,
  homeRow,
  laneCount,
  selected,
  drag,
  parting,
  rowMove,
  onDrag,
  onSnap,
}: {
  clip: AudioClip;
  asset: MediaAsset | undefined;
  /** The clip's chat mention token ("@s1"), shown on hover so the user can
   * point the assistant at this exact sound. Absent when its asset is gone. */
  mention: string | undefined;
  pps: number;
  /** Home-row top in px; while carried the ghost adds the pointer's offset. */
  top: number;
  homeRow: number;
  laneCount: number;
  selected: boolean;
  /** This bar's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another sound is dragging: animate this bar's shifts as it parts. */
  parting: boolean;
  /** A row drag is running in this band: "lift" is the row being carried,
   * "part" a row sliding into the place it closes up into. */
  rowMove: "lift" | "part" | null;
  /** Publish (or clear) the in-flight drag so the slot and rows track it. */
  onDrag: (d: LaneDrag | null) => void;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap: (x: number | null) => void;
}) {
  const loading = useEditor((s) => (asset ? s.loadingMedia.has(asset.fileName) : false));
  const len = clipLen(clip);
  const w = Math.max(10, len * pps);

  if (!asset) return null;

  const ui = { pps, rowH: AUDIO_H, laneCount, homeRow, onDrag, onSnap };

  return (
    <div
      className={cn(
        "tl-audio-clip group absolute cursor-grab overflow-hidden rounded-[7px] bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]",
        selected && SELECTED_SHADOW,
        clip.hidden && "opacity-40 grayscale",
        drag
          ? "tl-audio-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out",
        rowMove === "lift"
          ? "pointer-events-none opacity-80 shadow-2xl"
          : rowMove === "part" && "transition-[top] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : clip.start * pps,
        top: top + 2 + (drag ? drag.ghostY : 0),
        width: Math.max(10, w - CLIP_GAP),
        height: AUDIO_H - 4,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag || rowMove === "lift" ? 20 : undefined,
      }}
      data-tl-sel={`audio:${clip.id}`}
      onPointerDown={(e) => startLaneMove(e, "audio", clip.id, ui)}
    >
      <WaveformCanvas asset={asset} from={clip.in} to={clip.out} w={w} h={AUDIO_H - 8} className="inset-x-0 inset-y-1" />
      {(clip.fadeIn ?? 0) > 0 && (
        <div
          className="tl-fade-in pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/45 to-transparent"
          style={{ width: Math.min(w, (clip.fadeIn ?? 0) * pps) }}
        />
      )}
      {(clip.fadeOut ?? 0) > 0 && (
        <div
          className="tl-fade-out pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/45 to-transparent"
          style={{ width: Math.min(w, (clip.fadeOut ?? 0) * pps) }}
        />
      )}
      <span
        className={cn(
          "pointer-events-none absolute top-[3px] left-2 text-[9.5px] whitespace-nowrap text-white/90 transition-opacity [text-shadow:0_1px_2px_rgba(0,0,0,0.35)]",
          // On hover the mention chip takes the corner, so step the name aside.
          mention && !drag && "group-hover:opacity-0"
        )}
      >
        {asset.name}
      </span>
      {mention && !drag && !loading && (
        <span className="tl-mention-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {mention}
        </span>
      )}
      {loading && <LoadingChip />}
      {!loading && <ClipMenu asset={asset} clip={clip} />}
      {!loading && (
        <MuteChip
          muted={!!clip.hidden}
          className="bottom-1 left-1"
          onToggle={() => useEditor.getState().updateAudio(clip.id, { hidden: !clip.hidden })}
        />
      )}
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "audio", clip.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "audio", clip.id, "r", ui)}
      />
    </div>
  );
}

/** The keyframe diamond's grab square — wider than the diamond itself, since
 * a 6px target is not one. Paired with the `size-` on the marker below. */
const KEY_HIT = 14;

/**
 * One keyframe on an item's bar — an element's or a video clip's, on its
 * pose track (white diamond) or its mask's (amber): a diamond where the key
 * falls, dragged left and right to retime it. The grab is kept off the bar
 * underneath, so moving a key never moves the item it belongs to. `kind`
 * and `track` pick which store actions the gestures write.
 */
function KeyMarker({
  item,
  kind,
  track = "pose",
  t,
  pps,
  width,
  onMenu,
}: {
  item: { id: string; start: number; end: number };
  kind: "overlay" | "clip";
  track?: "pose" | "mask";
  t: number;
  pps: number;
  width: number;
  /** The bar's right-click menu; a key click carries its time, so the menu
   * offers to remove it. Absent (clip bars), the bar's own menu handles the
   * click and Delete removes the picked key. */
  onMenu?: (m: { x: number; y: number; id: string; key?: number }) => void;
}) {
  const picked = useEditor(
    (s) =>
      !!s.selectedKey &&
      s.selectedKey.kind === kind &&
      s.selectedKey.track === track &&
      s.selectedKey.id === item.id &&
      s.selectedKey.t === t
  );
  // Park clear of the trim handles: a key dragged to the very end would
  // otherwise sit under one and stop being grabbable. Those last few pixels
  // cost some positional accuracy, which the bar's own edge already conveys.
  const inset = Math.min(TRIM_W + KEY_HIT / 2, Math.max(3, (width - 8) / 2));
  return (
    <span
      // Above the hover chips (z-4): a key parked at the bar's end must stay
      // grabbable — retiming lives only here, while hide/mute also live in
      // the inspector.
      className="tl-key pointer-events-auto absolute top-1/2 z-5 grid size-3.5 cursor-ew-resize place-items-center"
      style={{
        left: Math.min(width - inset, Math.max(inset, t * pps)),
        transform: "translate(-50%, -50%)",
      }}
      title="Drag to retime, Delete to remove"
      onContextMenu={
        onMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu({ x: e.clientX, y: e.clientY, id: item.id, key: t });
            }
          : undefined
      }
      onPointerDown={(e) => {
        const s = useEditor.getState();
        const select =
          kind === "overlay"
            ? track === "mask"
              ? s.selectOverlayMaskKey
              : s.selectOverlayKey
            : track === "mask"
              ? s.selectClipMaskKey
              : s.selectClipKey;
        const move =
          kind === "overlay"
            ? track === "mask"
              ? s.moveOverlayMaskKey
              : s.moveOverlayKey
            : track === "mask"
              ? s.moveClipMaskKey
              : s.moveClipKey;
        select(item.id, t);
        let live = t;
        // The undo step opens on the first movement, so a click that only
        // seeks does not leave one behind.
        let checkpointed = false;
        startDrag(e, {
          onMove: (dx) => {
            if (!checkpointed) {
              checkpointed = true;
              s.pushHistory();
            }
            const next = Math.max(0, t + dx / pps);
            move(item.id, live, next, { transient: true });
            live = Math.max(0, Math.min(next, Math.max(0.1, item.end - item.start)));
          },
          // A click that never moved reads as "show me this key": the playhead
          // goes there, and the inspector's rows follow it.
          onUp: (_dx, _dy, moved) => {
            if (!moved) s.seek(item.start + live);
          },
        });
      }}
    >
      <span
        className={cn(
          "pointer-events-none rotate-45 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] transition-[width,height]",
          track === "mask" ? "bg-[#ff9f0a]" : "bg-white",
          picked ? "size-[9px] ring-[1.5px] ring-[#0a84ff]" : "size-[6px]"
        )}
      />
    </span>
  );
}

/** The sticker itself, small, at the head of its bar — a row of stickers reads
 * as which stickers they are. A Lottie has no still to show, so it keeps the
 * glyph. */
function StickerThumb({ overlay: o }: { overlay: StickerOverlay }) {
  const asset = useEditor((s) => (o.assetId ? s.assets.find((a) => a.id === o.assetId) : undefined));
  if (!asset || o.lottie) return <Sticker className="mr-1 size-2.5 shrink-0" />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- project media URL
    <img
      src={asset.url}
      alt=""
      loading="lazy"
      className="mr-1 size-4 shrink-0 object-contain"
    />
  );
}

function TextBar({
  overlay: o,
  pps,
  top,
  homeRow,
  laneCount,
  selected,
  drag,
  parting,
  rowMove,
  onDrag,
  onSnap,
  onMenu,
}: {
  overlay: Overlay;
  pps: number;
  top: number;
  homeRow: number;
  laneCount: number;
  selected: boolean;
  /** A row drag is running in this band: "lift" is the row being carried,
   * "part" a row sliding into the place it closes up into. */
  rowMove: "lift" | "part" | null;
  /** This bar's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another title is dragging: animate this bar's shifts as it parts. */
  parting: boolean;
  /** Publish (or clear) the in-flight drag so the slot and lanes track it. */
  onDrag: (d: LaneDrag | null) => void;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap: (x: number | null) => void;
  /** Open the bar's right-click menu; `key` set when it landed on a keyframe. */
  onMenu: (m: { x: number; y: number; id: string; key?: number }) => void;
}) {
  const w = Math.max(8, (o.end - o.start) * pps);
  // Element rows are a z-order, so the top of the stack is a place a drag
  // can reach: past the top edge opens a row there.
  const ui = { pps, rowH: TEXT_H, laneCount, homeRow, topInsert: true, onDrag, onSnap };
  // Per-kind chip content: a title shows its text, a shape its name behind a
  // shape glyph, a sticker its glyph and name.
  const ShapeIcon = SHAPE_CHIP_ICONS[o.kind === "shape" ? o.shape : "rect"];
  const chip =
    o.kind === "shape" ? (
      <>
        <ShapeIcon className="mr-1 size-2.5 shrink-0" />
        {SHAPE_LABELS[o.shape]}
      </>
    ) : o.kind === "sticker" ? (
      <>
        <StickerThumb overlay={o} />
        Sticker
      </>
    ) : o.kind === "effect" ? (
      <>
        <Sparkles className="mr-1 size-2.5 shrink-0" />
        {EFFECT_LABELS[o.effect]}
      </>
    ) : (
      o.text.replace(/\n/g, " ")
    );

  return (
    <div
      className={cn(
        "tl-text-bar group absolute flex cursor-grab items-center overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]",
        FAMILY_STYLE[overlayFamily(o)].bar,
        o.hidden && "opacity-40 grayscale",
        selected && SELECTED_SHADOW,
        drag
          ? "tl-text-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out",
        rowMove === "lift"
          ? "pointer-events-none opacity-80 shadow-2xl"
          : rowMove === "part" && "transition-[top] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : o.start * pps,
        top: top + 2 + (drag ? drag.ghostY : 0),
        width: Math.max(8, w - CLIP_GAP),
        height: TEXT_H - 6,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag || rowMove === "lift" ? 20 : undefined,
      }}
      data-tl-sel={`overlay:${o.id}`}
      onPointerDown={(e) => startLaneMove(e, "overlay", o.id, ui)}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ x: e.clientX, y: e.clientY, id: o.id });
      }}
    >
      <span className="pointer-events-none flex min-w-0 items-center truncate px-2 text-[10.5px] font-medium text-white">
        {chip}
      </span>
      {/* Keys sit on the bar where they fall, so a track is visible without
          opening the inspector. */}
      {(o.kf ?? []).map((k) => (
        <KeyMarker key={k.t} item={o} kind="overlay" t={k.t} pps={pps} width={w} onMenu={onMenu} />
      ))}
      {(o.mask?.kf ?? []).map((k) => (
        <KeyMarker key={`m${k.t}`} item={o} kind="overlay" track="mask" t={k.t} pps={pps} width={w} />
      ))}
      <HideChip
        hidden={!!o.hidden}
        small
        className="top-1/2 right-2 -translate-y-1/2"
        onToggle={() => useEditor.getState().updateOverlay(o.id, { hidden: !o.hidden })}
      />
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "overlay", o.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "overlay", o.id, "r", ui)}
      />
    </div>
  );
}

/** A subtitle cue on its track: click selects (⌫ deletes it), drag to retime,
 * edges to trim. Editing the words happens in the Subtitles panel. */
function SubBar({
  cue,
  dimmed,
  pps,
  top,
  homeRow,
  selected,
  drag,
  parting,
  onDrag,
  onSnap,
}: {
  cue: SubtitleCue;
  /** The cue's track is hidden — gray the bar like a hidden clip. */
  dimmed: boolean;
  pps: number;
  /** Rendered row top in px — one row per subtitle track (language). */
  top: number;
  homeRow: number;
  selected: boolean;
  /** This bar's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another cue is dragging: animate this bar's shifts as it parts. */
  parting: boolean;
  onDrag: (d: LaneDrag | null) => void;
  onSnap: (x: number | null) => void;
}) {
  const w = Math.max(8, (cue.end - cue.start) * pps);
  const ui = { pps, rowH: SUB_H, laneCount: 0, homeRow, onDrag, onSnap };

  return (
    <div
      className={cn(
        "tl-sub-bar group absolute flex cursor-grab items-center overflow-hidden rounded-[5px] bg-gradient-to-b from-amber-300 to-amber-400 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
        dimmed && "opacity-40 grayscale",
        selected && SELECTED_SHADOW,
        drag
          ? "tl-sub-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : cue.start * pps,
        top: top + 1 + (drag ? drag.ghostY : 0),
        width: Math.max(8, w - CLIP_GAP),
        height: SUB_H - 4,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      title={cue.text}
      data-tl-sel={`cue:${cue.id}`}
      onPointerDown={(e) => startLaneMove(e, "cue", cue.id, ui)}
    >
      <span className="pointer-events-none truncate px-1.5 text-[9.5px] font-medium text-amber-950/90">
        {cue.text}
      </span>
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "cue", cue.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "cue", cue.id, "r", ui)}
      />
    </div>
  );
}

/** The landing-slot preview for an in-flight lane drag, drawn in the track
 * family's own chrome; it tracks the coordinator's resolved slot and row. */
function LaneSlot({
  drag,
  pps,
  rowH,
  barH,
  shift = 0,
  className,
}: {
  drag: LaneDrag;
  pps: number;
  rowH: number;
  barH: number;
  /** Rows pushed down by a new row opening above them. */
  shift?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "tl-lane-slot pointer-events-none absolute transition-[left] duration-150 ease-out",
        className
      )}
      style={{
        left: drag.slotStart * pps,
        top: drag.targetRow * rowH + 2 + shift,
        width: Math.max(8, drag.len * pps - CLIP_GAP),
        height: barH,
      }}
    />
  );
}
