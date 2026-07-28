"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, ArrowUp, ArrowUpToLine, AudioLines, Blend, Check, Circle, Clapperboard, Droplets, EllipsisVertical, Expand, Eye, EyeOff, FolderOpen, FolderPlus, FoldHorizontal, Loader2, Moon, Pause, Play, Scissors, SkipBack, Sun, Target, Trash2, Type, UnfoldHorizontal, Volume2, VolumeX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
import {
  clearAssetDrag,
  draggedAssetId,
  draggedLibraryId,
  draggingAssetId,
  draggingLibrary,
  draggingTemplate,
  hasAssetDrag,
  hasLibraryDrag,
  hasTemplateDrag,
} from "@/cut/lib/assetDrag";
import { audioClipRefs, draggingRef, hasRefDrag, type AssetRef } from "@/cut/lib/assetRef";
import { useCutCaps } from "@/cut/lib/backend/hooks";
import {
  addProjectTemplateToTimeline,
  addTemplateToProject,
  importLibraryAsset,
  saveAssetToLibrary,
} from "@/cut/lib/library";
import { originalSettings, type ExportDoc } from "@/cut/lib/exportClient";
import { useExports } from "@/cut/lib/exportStore";
import { isDragActive, startDrag, subscribeDragActive } from "@/cut/lib/drag";
import { CLIP_GAP, startLaneMove, startLaneTrim, type LaneDrag } from "@/cut/lib/laneTracks";
import { ensurePeaks, importImage, importStockMusic, importStockVideo, peekEdgeFrame, requestEdgeFrame, revealMedia } from "@/cut/lib/media";
import { track0Clips, trackGapAt, clipLen, clipSpeed, footprints, getClipSpans, nextFreeStart, overlayLayers, projectDuration, rippleInsert, TIMELINE_H_MAX, useEditor } from "@/cut/lib/store";
import type { VideoTrackPlacement } from "@/cut/lib/store";
import { subtitleLaneCount } from "@/cut/lib/subtitles";
import { formatTime, formatTimecode } from "@/cut/lib/time";
import { emptySubtitles, IMAGE_CLIP_SECONDS, TRANSITION_STYLE_LABELS } from "@/cut/lib/types";
import type { AudioClip, ClipSpan, ColorGrade, MediaAsset, SubtitleCue, TextOverlay, TransitionStyle, VideoClip } from "@/cut/lib/types";
import { gradeTint, gradeToCssFilter } from "@/cut/lib/colorGrade";
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

const VIDEO_H = 64;
const OVERLAY_H = VIDEO_H; // every video track shares the same row height
const AUDIO_H = 44;

/** Where a dragged video clip can land. Re-exported name for the store's
 * placement union (existing track, 0 included / newly-inserted track). */
type TrackTarget = VideoTrackPlacement;

/** Encode/decode a placement in a row's `data-drop` attribute. */
function placementAttr(place: TrackTarget): string {
  return place.kind === "track" ? `track:${place.track}` : `insert:${place.level}`;
}
function parsePlacement(raw: string): TrackTarget | null {
  const [k, n] = raw.split(":");
  if (k === "track") return { kind: "track", track: Number(n) };
  if (k === "insert") return { kind: "insert", level: Number(n) };
  return null;
}
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
/** Breathing room on both sides so the playhead cap is never clipped. */
const PAD_SIDE = 20;

/** Zoom range, in timeline pixels per second of media. */
const ZOOM_MIN = 12;
const ZOOM_MAX = 800;
/**
 * Zoom reads as a ratio — doubling px/sec feels like one step whether you start
 * at 20 or at 400 — so the slider travels in log space. A linear track would
 * spend its first sixth on every zoom anyone uses and the rest on extremes.
 */
const zoomToSlider = (pps: number) =>
  (Math.log(pps / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)) * 100;
const sliderToZoom = (pos: number) => ZOOM_MIN * (ZOOM_MAX / ZOOM_MIN) ** (pos / 100);

// A high-contrast selected state: a bright blue ring drawn both inside and
// (crucially) *outside* the box, so it stays visible on top of a clip's
// filmstrip thumbnails, plus a halo and a raised stacking order so selected
// items read clearly against their neighbours.
const SELECTED_SHADOW =
  "z-10 shadow-[inset_0_0_0_2px_#0a84ff,0_0_0_2px_#0a84ff,0_2px_11px_rgba(10,132,255,0.6)]";

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

/** An asset type that lands as a video clip — footage or a still image. */
const isClipMedia = (t: string | undefined): t is "video" | "image" =>
  t === "video" || t === "image";

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
  // The static ruler band behind the scroller follows vertical scroll so it
  // stays glued under the in-content ruler; overscroll can't move it, so the
  // band runs unbroken through the bounce. (Horizontal position is moot — the
  // band is uniform across the full width.)
  const rulerUnderlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const band = rulerUnderlayRef.current;
    if (!el || !band) return;
    const sync = () => {
      band.style.transform = `translateY(${-el.scrollTop}px)`;
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
  // Per-upper-track spans: each track carries its own transitions, so its row
  // needs the same overlap-aware geometry (insets, badges) as track 0's.
  const overlayTrackSpans = useMemo(() => {
    const m = new Map<number, ClipSpan[]>();
    for (const c of overlayClips)
      if (!m.has(c.track)) m.set(c.track, getClipSpans(clips, assets, c.track));
    return m;
  }, [overlayClips, clips, assets]);
  const total = projectDuration({ clips, audioClips });
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
  // clip would land, how long it runs, and a poster frame so the preview reads
  // as the segment itself sliding along the row rather than an empty slot.
  const [assetDrop, setAssetDrop] = useState<{ t: number; len: number; thumb?: string } | null>(
    null
  );
  // Kind of external media being dragged over the timeline (audio vs video).
  const [dropType, setDropType] = useState<"video" | "audio" | null>(null);
  // A video clip is being dragged (internal or external): reveals the
  // would-be new tracks past the stack's edges.
  const [videoDragging, setVideoDragging] = useState(false);
  // The pending drop preview: which track/gap, at what time, for how long.
  const [overlayDrop, setOverlayDrop] = useState<
    { target: TrackTarget; t: number; len: number } | null
  >(null);
  // Stage-x pixel a snapped title edge sits at, for the guide line (null = off).
  const [snapX, setSnapX] = useState<number | null>(null);
  const videoDragActive = videoDragging || dropType === "video";

  // Which drop the cursor is over: an existing track (0 included) or a
  // would-be new track past the stack's edges. Hit-test live via
  // elementFromPoint — rows (new-track rows included) carry a `data-drop`
  // placement.
  const resolveDropTrack = useCallback((clientX: number, clientY: number): TrackTarget => {
    // An empty video timeline has no base yet: the first clip always lands on
    // track 0, whatever height the pointer is at. Otherwise a drop above the
    // thin empty row resolves to an overlay track, leaving track 0 empty — and
    // an empty track 0 plays black (the compositor's master lives there).
    const st = useEditor.getState();
    if (st.clips.length === 0) return TRACK_ZERO;
    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    const zone = el?.closest<HTMLElement>("[data-drop]");
    const parsed = zone ? parsePlacement(zone.dataset.drop!) : null;
    if (parsed) return parsed;
    // Past the ends of the stack → above opens a new top track; below the
    // bottom row opens a new track 0 (the spine transplants onto the drop).
    const rows = innerRef.current?.querySelectorAll<HTMLElement>("[data-drop]");
    const tracks = overlayLayers(useEditor.getState().clips).map((c) => c.track);
    if (rows && rows.length) {
      if (clientY < rows[0].getBoundingClientRect().top)
        return { kind: "insert", level: Math.max(0, ...tracks) + 1 };
      if (clientY > rows[rows.length - 1].getBoundingClientRect().bottom)
        return { kind: "insert", level: 0 };
    }
    return TRACK_ZERO;
  }, []);

  // Drive the drop preview while a clip is dragged across tracks: highlight the
  // target track's slot or a between-track insertion line. An existing track
  // slides the drop to its next free slot, so the slot previews where the clip
  // will actually land, not the raw pointer time.
  const previewCross = useCallback((target: TrackTarget | null, start = 0, len = 0) => {
    if (target === null) return setOverlayDrop(null);
    const t =
      target.kind === "track"
        ? nextFreeStart(
            footprints(useEditor.getState().clips.filter((c) => c.track === target.track)),
            Math.max(0, start),
            len
          )
        : start;
    setOverlayDrop({ target, t, len });
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

  // Right-click on a video row's empty space: a small popover offering to
  // close that track's gap under the cursor. The cut is track-local — only
  // the clicked track's later clips slide left — so the menu carries the gap
  // it would cut and the row tints it red while the menu is open.
  const [gapMenu, setGapMenu] = useState<
    { x: number; y: number; track: number; gap: { start: number; len: number } } | null
  >(null);
  useEffect(() => {
    if (!gapMenu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGapMenu(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [gapMenu]);

  // Title tracks: overlays carry a `lane`; used lanes compact to contiguous
  // display rows, so empty tracks disappear on their own.
  const overlayLanes = useMemo(() => {
    const used = [...new Set(overlays.map((o) => o.lane ?? 0))].sort((a, b) => a - b);
    const rowOf = new Map(used.map((l, i) => [l, i]));
    return { used, rowOf, count: used.length };
  }, [overlays]);

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
  const audioLanes = useMemo(() => {
    const used = [...new Set(audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b);
    const rowOf = new Map(used.map((l, i) => [l, i]));
    return { used, rowOf, count: used.length };
  }, [audioClips]);
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

  const timeAt = (clientX: number) => {
    const rect = innerRef.current!.getBoundingClientRect();
    return (clientX - rect.left) / pps;
  };

  // Where a dropped asset should land. An empty timeline has no arrangement to
  // read a position against, so the drop starts the film at 0 no matter where
  // the cursor released.
  const dropTimeAt = (clientX: number) => (total <= 0 ? 0 : Math.max(0, timeAt(clientX)));

  // Scrub with auto-scroll when the pointer nears the viewport edges.
  const scrub = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    if (s.playing) s.setPlaying(false);
    s.seek(timeAt(e.clientX));
    const el = scrollRef.current;
    startDrag(e, {
      onMove: (_dx, _dy, ev) => {
        if (el) {
          const r = el.getBoundingClientRect();
          if (ev.clientX > r.right - 36) el.scrollLeft += 14;
          else if (ev.clientX < r.left + 36) el.scrollLeft -= 14;
        }
        useEditor.getState().seek(timeAt(ev.clientX));
      },
    });
  };

  // Clicking empty track space deselects AND moves the playhead (iMovie).
  const deselectIfSelf = (e: React.PointerEvent) => {
    if (e.target === e.currentTarget) {
      useEditor.getState().select(null);
      scrub(e);
    }
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
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    if (Math.abs(clamped - cur.pxPerSec) < 0.01) return;
    if (el) {
      const t = anchorT ?? cur.currentTime;
      const px = anchorPx ?? PAD_SIDE + t * cur.pxPerSec - el.scrollLeft;
      pendingAnchor.current = { t, px };
    }
    cur.setPxPerSec(clamped);
  }, []);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    const dur = projectDuration(useEditor.getState());
    if (!el || dur <= 0) return;
    zoomTo((el.clientWidth - 60) / dur, 0, PAD_SIDE);
  }, [zoomTo]);

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
    place: TrackTarget = TRACK_ZERO
  ) => {
    const s = useEditor.getState();
    if (isClipMedia(type)) {
      if (place.kind === "insert") s.addVideoFromAsset(assetId, place, t);
      // Drop at the pointer, rippling later clips right — so a drop into a
      // leading gap or between clips lands there instead of sliding to the end.
      else s.dropClipFromAsset(assetId, t);
    } else {
      const used = [...new Set(s.audioClips.map((a) => a.lane ?? 0))].sort((a, b) => a - b);
      const lane =
        audioRow < used.length ? used[audioRow] : (used[used.length - 1] ?? -1) + 1;
      s.addAudioFromAsset(assetId, t, { lane });
    }
  };

  // The video being dragged — project media, a library clip, or an image ref
  // (which lands as a still).
  const draggedVideo = (e: React.DragEvent): { duration: number } | null => {
    if (hasLibraryDrag(e)) {
      const lib = draggingLibrary();
      if (!lib || !isClipMedia(lib.type)) return null;
      return { duration: lib.type === "image" ? STILL_SECONDS : lib.duration };
    }
    const id = draggingAssetId();
    if (id) {
      const asset = useEditor.getState().assets.find((a) => a.id === id);
      if (!asset || !isClipMedia(asset.type)) return null;
      return { duration: asset.type === "image" ? STILL_SECONDS : asset.duration };
    }
    const stockVideo = draggingStockVideo(e);
    if (stockVideo) return { duration: stockVideo.duration ?? 0 };
    return draggingStill(e) ? { duration: STILL_SECONDS } : null;
  };

  // Drop targets for the upper tracks and between-track gaps: dragging a video
  // onto a lane adds it there; onto a gap opens a fresh track at that z-level.
  // Works the same for project media and library clips.
  const overlayDropHandlers = (place: TrackTarget) => ({
    onDragOver: (e: React.DragEvent) => {
      const vid = draggedVideo(e);
      if (!vid) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      setAssetDrop(null);
      setDropType("video"); // keep the insertion zones lit however the drag entered
      previewCross(place, Math.max(0, timeAt(e.clientX)), vid.duration);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverlayDrop(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const t = Math.max(0, timeAt(e.clientX));
      setOverlayDrop(null);
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
      if (id && isClipMedia(asset?.type)) {
        useEditor.getState().addVideoFromAsset(id, place, t);
        return;
      }
      if (stockVideo && projectId) {
        void importStockVideo(projectId, { url: stockVideo.url, name: stockVideo.name })
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
  });

  // Drag the panel's top border to resize; the border itself stays as-is,
  // only an invisible grab strip sits on top of it.
  const resize = (e: React.PointerEvent) => {
    const h0 = useEditor.getState().timelineH;
    startDrag(e, {
      onMove: (_dx, dy) => {
        const max = Math.min(TIMELINE_H_MAX, window.innerHeight - 220);
        useEditor.getState().setTimelineH(Math.min(max, h0 - dy));
      },
    });
  };

  // The landing-slot preview on a video row while the drag targets it — the
  // same chrome as the lane slots.
  const trackSlot = (place: TrackTarget, h: number) =>
    samePlacement(overlayDrop?.target ?? null, place) ? (
      <div
        className="pointer-events-none absolute top-0.5 rounded-lg bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)] transition-[left] duration-150 ease-out"
        style={{
          left: overlayDrop!.t * pps,
          width: Math.max(10, overlayDrop!.len * pps - CLIP_GAP),
          height: h,
        }}
      />
    ) : null;

  // Only empty space gets the menu: a right-click on a clip sits on a
  // footprint, so the gap lookup misses and the event falls through to the
  // browser.
  const openGapMenu = (track: number) => (e: React.MouseEvent) => {
    const gap = trackGapAt(useEditor.getState().clips, track, timeAt(e.clientX));
    if (!gap) return;
    e.preventDefault();
    setGapMenu({ x: e.clientX, y: e.clientY, track, gap });
  };

  // The span the open gap menu would cut, tinted red on its own track.
  const gapHighlight = (track: number, h: number) =>
    gapMenu?.track === track ? (
      <div
        className="pointer-events-none absolute top-0.5 z-10 rounded-lg bg-red-500/15"
        style={{
          left: gapMenu.gap.start * pps,
          width: Math.max(2, gapMenu.gap.len * pps - CLIP_GAP),
          height: h,
        }}
      />
    ) : null;

  // The would-be new video track, one row past the stack's edge — the same
  // grown-row experience as the audio and title lanes. Dropping here opens a
  // brand-new track at z-level `level`.
  const newTrackRow = (level: number) => {
    const place: TrackTarget = { kind: "insert", level };
    return (
      <div
        className="relative mt-1.5"
        style={{ height: OVERLAY_H }}
        data-drop={placementAttr(place)}
        {...overlayDropHandlers(place)}
      >
        {trackSlot(place, OVERLAY_H - 4)}
      </div>
    );
  };

  return (
    <footer
      className="relative flex min-w-0 shrink-0 flex-col overflow-hidden border-t border-border bg-card select-none"
      style={{ height: timelineH }}
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
        if (!hasAssetDrag(e) && !isLib && !still && !stockVideo && !stockMusic) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        // Preview where a video would land; audio drops free-form. Library and
        // stock drags carry their own shape since they aren't in the project yet.
        let type: "video" | "audio" | "image" | undefined;
        let duration = 0;
        // Poster frame for the on-track ghost, when the source can offer one.
        let thumb: string | undefined;
        if (isLib) {
          const lib = draggingLibrary();
          type = lib?.type;
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
          type = asset?.type;
          duration = asset?.type === "image" ? STILL_SECONDS : asset?.duration ?? 0;
          thumb = asset?.type === "image" ? asset.url : asset?.thumbs?.[0];
        }
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
          setOverlayDrop({ target: place, t: dropTimeAt(e.clientX), len: duration });
          return;
        }
        setOverlayDrop(null);
        // Preview the true landing spot: a drop at the pointer inserts here,
        // rippling later clips right, so the ghost sits where the segment will
        // actually land — a box under the pointer that lands minutes away lies.
        const cur = useEditor.getState();
        const { start } = rippleInsert(track0Clips(cur.clips), dropTimeAt(e.clientX), duration);
        setAssetDrop({ t: start, len: duration, thumb });
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setAssetDrop(null);
          setOverlayDrop(null);
          setAudioDrop(null);
          setDropType(null);
        }
      }}
      onDrop={(e) => {
        // Resolve the hovered rows before the previews (and their rows) clear.
        const audioRow = audioRowAt(e.clientY);
        const videoPlace = resolveDropTrack(e.clientX, e.clientY);
        setAssetDrop(null);
        setOverlayDrop(null);
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
        const projectId = useEditor.getState().projectId;
        clearAssetDrag();
        if (tpl && projectId) {
          e.preventDefault();
          if (tpl.scope === "project") addProjectTemplateToTimeline(projectId, tpl.template, t);
          else void addTemplateToProject(projectId, tpl.template, t).catch(() => {});
          return;
        }
        if (libId && lib && projectId) {
          e.preventDefault();
          void importLibraryAsset(projectId, lib)
            .then((asset) => placeAssetAt(asset.id, asset.type, t, audioRow, videoPlace))
            .catch(() => {});
          return;
        }

        const id = draggedAssetId(e);
        if (id) {
          e.preventDefault();
          const asset = useEditor.getState().assets.find((a) => a.id === id);
          if (asset) placeAssetAt(id, asset.type, t, audioRow, videoPlace);
          return;
        }

        // A stock-music sample imports as an audio asset and lands on the
        // hovered soundtrack lane.
        if (stockMusic && projectId) {
          e.preventDefault();
          void importStockMusic(projectId, { url: stockMusic.url, name: stockMusic.name })
            .then((asset) => placeAssetAt(asset.id, "audio", t, audioRow))
            .catch(() => {});
          return;
        }

        // A stock clip imports as footage, an image ref as a still, then each
        // lands in the resolved video slot.
        if (stockVideo && projectId) {
          e.preventDefault();
          void importStockVideo(projectId, { url: stockVideo.url, name: stockVideo.name })
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
      <div className="relative flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2.5">
        <Button
          variant="ghost"
          size="sm"
          title="Split at pointer, or at playhead (⌘B or S)"
          onClick={() => {
            const s = useEditor.getState();
            s.splitAtPlayhead(s.skimTime ?? undefined);
          }}
        >
          <Scissors /> Split
        </Button>
        <Button variant="ghost" size="sm" title="Text (T)" onClick={() => useEditor.getState().addOverlay()}>
          <Type /> Text
        </Button>
        <Button
          variant="ghost"
          size="sm"
          title="Delete (⌫)"
          disabled={multiSelection.length === 0}
          onClick={() => useEditor.getState().deleteSelection()}
        >
          <Trash2 /> {multiSelection.length > 1 ? `Delete ${multiSelection.length}` : "Delete"}
        </Button>
        <SaveSelectionButton />

        <Transport total={total} />

        <div className="flex-1" />
        <Slider
          className="data-horizontal:w-28"
          min={0}
          max={100}
          step={0.1}
          value={zoomToSlider(pps)}
          aria-label="Zoom"
          onValueChange={(v) => zoomTo(sliderToZoom(Number(v)))}
        />
        <Button variant="ghost" size="sm" title="Fit timeline to window" onClick={fit}>
          Fit
        </Button>
      </div>

      {/* Rubber-band overscroll translates the scroller's content and
          background wholesale, so the wrapper behind it paints the resting
          picture the bounce reveals: the card-white ruler band (with its
          baseline) over the track gray. The scroller stays transparent — the
          underlay IS the timeline's surface. */}
      <div className="relative min-h-0 flex-1 bg-muted">
      <div ref={rulerUnderlayRef} className="pointer-events-none absolute inset-x-0 top-0">
        <div
          className="absolute inset-x-0 top-0 border-b border-border bg-card"
          style={{ height: RULER_H }}
        />
        {railYs.map((y, i) => (
          <div key={i} className="absolute inset-x-0 h-px bg-border" style={{ top: y }} />
        ))}
        {total <= 0 && (
          <div
            className="absolute inset-x-0"
            style={{ top: RULER_H, height: timelineH, background: REST_RAILS }}
          />
        )}
      </div>
      <div
        ref={scrollRef}
        data-tl-scroll
        className="tl-scroll relative h-full overflow-auto overscroll-y-none"
      >
        <div
          className="relative flex min-h-full min-w-full flex-col"
          style={{ width: contentW + PAD_SIDE * 2 }}
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
          <Ruler pps={pps} width={contentW} onScrub={scrub} />

          {/* The top-side new track reveals once the drag heads past the
              stack's upper edge; mounting it earlier would shift every row
              down under a freshly grabbed clip. */}
          {videoDragActive &&
            samePlacement(overlayDrop?.target ?? null, { kind: "insert", level: topInsertLevel }) &&
            newTrackRow(topInsertLevel)}
          {aboveTracks.map((track) => (
            <div
              key={`ov-${track}`}
              className="relative mt-1.5"
              style={{ height: OVERLAY_H }}
              data-drop={placementAttr({ kind: "track", track })}
              onPointerDown={deselectIfSelf}
              onContextMenu={openGapMenu(track)}
              {...overlayDropHandlers({ kind: "track", track })}
            >
              {laneRail(OVERLAY_H - 2)}
              {gapHighlight(track, OVERLAY_H - 4)}
              {draggedOverlayTrack === track && laneDrag && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={OVERLAY_H}
                  barH={OVERLAY_H - 4}
                  className="rounded-lg bg-[#0a84ff]/10 shadow-[inset_0_0_0_1.5px_rgba(10,132,255,0.4)]"
                />
              )}
              {(overlayTrackSpans.get(track) ?? []).map((span, i, tSpans) => (
                <OverlayClipView
                  key={span.clip.id}
                  clip={span.clip}
                  asset={span.asset}
                  prevOverlap={tSpans[i - 1]?.transitionOut ?? 0}
                  overlap={span.transitionOut}
                  pps={pps}
                  selected={selKeys.has(`clip:${span.clip.id}`)}
                  drag={
                    laneDrag?.kind === "overlayClip" && laneDrag.id === span.clip.id
                      ? laneDrag
                      : null
                  }
                  parting={laneDrag?.kind === "overlayClip" && laneDrag.id !== span.clip.id}
                  onDrag={setLaneDrag}
                  onSnap={setSnapX}
                  resolveTarget={resolveDropTrack}
                  onCrossMove={previewCross}
                  onCrossDrop={onOverlayCrossDrop}
                  onDragActive={setVideoDragging}
                />
              ))}
              {laneDrag?.kind !== "overlayClip" && (
                <TransitionBadges
                  spans={overlayTrackSpans.get(track) ?? []}
                  pps={pps}
                  rowH={OVERLAY_H}
                />
              )}
              {trackSlot({ kind: "track", track }, OVERLAY_H - 4)}
            </div>
          ))}

          {/* An empty track 0 disappears like any other empty track. It
              renders while it has clips, while the whole project is empty
              (the first drop target), for the length of an external media
              drag, or once an internal drag targets it — the seam where it
              sat resolves to TRACK_ZERO, so heading there reveals the row. */}
          {(spans.length > 0 ||
            total <= 0 ||
            dropType === "video" ||
            samePlacement(overlayDrop?.target ?? null, TRACK_ZERO)) && (
          <div
            className="relative mt-1.5"
            style={{ height: VIDEO_H }}
            data-drop={placementAttr(TRACK_ZERO)}
            onPointerDown={deselectIfSelf}
            onContextMenu={openGapMenu(0)}
          >
            {spans.length > 0 && laneRail(VIDEO_H - 2)}
            {gapHighlight(0, VIDEO_H - 4)}
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
            {assetDrop && (
              // The dragged clip as a floating segment: the poster fills it and
              // it rides above the row's clips (z-20), so a drag reads as a
              // placed segment sliding to its landing spot, not a hole to fill.
              <div
                className="tl-asset-drop-slot pointer-events-none absolute top-0.5 z-20 overflow-hidden rounded-lg bg-neutral-200 opacity-90 shadow-2xl ring-[1.5px] ring-[#0a84ff]/70 transition-[left] duration-100 ease-out"
                style={{
                  left: assetDrop.t * pps,
                  width: Math.max(10, assetDrop.len * pps - CLIP_GAP),
                  height: VIDEO_H - 4,
                }}
              >
                {assetDrop.thumb && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={assetDrop.thumb}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                )}
                <span className="absolute top-1 left-1 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] tabular-nums text-white">
                  {assetDrop.len.toFixed(1)}s
                </span>
              </div>
            )}
            {spans.map((span, i) => (
              <ClipView
                key={span.clip.id}
                span={span}
                prevOverlap={spans[i - 1]?.transitionOut ?? 0}
                mention={`@c${i + 1}`}
                pps={pps}
                selected={selKeys.has(`clip:${span.clip.id}`)}
                drag={laneDrag?.kind === "clip" && laneDrag.id === span.clip.id ? laneDrag : null}
                parting={laneDrag?.kind === "clip" && laneDrag.id !== span.clip.id}
                onDrag={setLaneDrag}
                onSnap={setSnapX}
                resolveTarget={resolveDropTrack}
                onCrossMove={previewCross}
                onCrossDrop={onClipCrossDrop}
                onDragActive={setVideoDragging}
              />
            ))}
            {laneDrag?.kind !== "clip" && (
              <TransitionBadges spans={spans} pps={pps} rowH={VIDEO_H} />
            )}
          </div>
          )}

          {/* The bottom-side new track grows the stack downward, like the
              audio and title lanes' extra row — nothing above it moves.
              Dropping here opens a new track 0: the whole stack renumbers up
              and the spine (ripple, transitions) transplants onto the drop. */}
          {videoDragActive && newTrackRow(bottomInsertLevel)}

          {(audioClips.length > 0 || audioDrop !== null) && (
            <div
              ref={audioRef}
              className="relative mt-1.5"
              style={{
                height:
                  Math.max(
                    audioLanes.count,
                    // An in-flight audio drag shows the whole landing area,
                    // the would-be new track included.
                    laneDrag?.kind === "audio" ? audioLanes.count + 1 : 0,
                    (audioDrop?.row ?? -1) + 1
                  ) * AUDIO_H,
              }}
              onPointerDown={deselectIfSelf}
            >
              {Array.from({ length: audioLanes.count }, (_, r) =>
                laneRail((r + 1) * AUDIO_H - 2, r)
              )}
              {laneDrag?.kind === "audio" &&
                Array.from({ length: audioLanes.count + 1 }, (_, r) => (
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
                    top={homeRow * AUDIO_H}
                    homeRow={homeRow}
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

          {overlays.length > 0 && (
            <div
              className="relative mt-1.5"
              style={{
                height:
                  Math.max(
                    overlayLanes.count,
                    // An in-flight title drag shows the whole landing area,
                    // the would-be new track included.
                    laneDrag?.kind === "text" ? overlayLanes.count + 1 : 0
                  ) * TEXT_H,
              }}
              onPointerDown={deselectIfSelf}
            >
              {Array.from({ length: overlayLanes.count }, (_, r) =>
                laneRail((r + 1) * TEXT_H - 4, r)
              )}
              {laneDrag?.kind === "text" &&
                Array.from({ length: overlayLanes.count + 1 }, (_, r) => (
                  <div
                    key={r}
                    className={cn(
                      "pointer-events-none absolute inset-x-0 rounded-md border border-dashed transition-colors",
                      r === laneDrag.targetRow
                        ? "border-purple-500/70 bg-purple-500/5"
                        : "border-purple-500/25"
                    )}
                    style={{ top: r * TEXT_H + 2, height: TEXT_H - 6 }}
                  />
                ))}
              {laneDrag?.kind === "text" && (
                <LaneSlot
                  drag={laneDrag}
                  pps={pps}
                  rowH={TEXT_H}
                  barH={TEXT_H - 6}
                  className="rounded-md bg-purple-500/10 shadow-[inset_0_0_0_1.5px_rgba(168,85,247,0.5)]"
                />
              )}
              {overlays.map((o) => {
                const homeRow = overlayLanes.rowOf.get(o.lane ?? 0) ?? 0;
                const drag = laneDrag?.kind === "text" && laneDrag.id === o.id ? laneDrag : null;
                return (
                  <TextBar
                    key={o.id}
                    overlay={o}
                    pps={pps}
                    top={homeRow * TEXT_H}
                    homeRow={homeRow}
                    laneCount={overlayLanes.count}
                    selected={selKeys.has(`text:${o.id}`)}
                    drag={drag}
                    parting={laneDrag?.kind === "text" && laneDrag.id !== o.id}
                    onDrag={setLaneDrag}
                    onSnap={setSnapX}
                  />
                );
              })}
            </div>
          )}

          {subtitles.showOnTimeline && subtitles.cues.length > 0 && (
            <div
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
            <HoverLine scrollRef={scrollRef} innerRef={innerRef} pps={pps} />
            <Playhead pps={pps} scrollRef={scrollRef} onScrub={scrub} />
          </div>
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
                useEditor.getState().removeGap(gapMenu.track, gapMenu.gap.start);
                setGapMenu(null);
              }}
            >
              <Scissors className="size-3.5 text-muted-foreground" /> Remove empty space
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}

/**
 * iMovie skimmer: a line that follows the mouse over the timeline. It marks
 * where Split (⌘B / S) will cut; clicking still moves the playhead itself.
 */
function HoverLine({
  scrollRef,
  innerRef,
  pps,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  innerRef: React.RefObject<HTMLDivElement | null>;
  pps: number;
}) {
  const skimTime = useEditor((s) => s.skimTime);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      const inner = innerRef.current;
      const s = useEditor.getState();
      if (!inner || e.buttons) return s.setSkimTime(null);
      const t = (e.clientX - inner.getBoundingClientRect().left) / s.pxPerSec;
      s.setSkimTime(Math.max(0, t));
    };
    const leave = () => useEditor.getState().setSkimTime(null);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      useEditor.getState().setSkimTime(null);
    };
  }, [scrollRef, innerRef]);
  if (skimTime === null) return null;
  return (
    <div
      className="tl-hover-line pointer-events-none absolute top-0 bottom-2 z-30 w-px bg-foreground/30"
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
function SaveSelectionButton() {
  const multiSelection = useEditor((s) => s.multiSelection);
  const [state, setState] = useState<"idle" | "saving" | "done">("idle");
  if (multiSelection.length === 0) return null;

  const save = () => {
    const s = useEditor.getState();
    const input = s.selectionTemplate();
    if (!input) return;
    s.addTemplate(input);
    setState("done");
    setTimeout(() => setState("idle"), 1800);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
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
      {state === "done" ? "Saved" : "Save template"}
    </Button>
  );
}

/** Playback transport, centered in the timeline toolbar. */
function Transport({ total }: { total: number }) {
  const playing = useEditor((s) => s.playing);
  const currentTime = useEditor((s) => s.currentTime);
  const hasClips = total > 0;

  const toggle = () => {
    const s = useEditor.getState();
    if (!s.playing && s.currentTime >= total - 0.01) s.seek(0);
    s.setPlaying(!s.playing);
  };

  return (
    <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
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
        <span className="tc-now">{formatTimecode(currentTime)}</span>
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
  const t = useEditor((s) => s.currentTime);
  const playing = useEditor((s) => s.playing);
  const x = t * pps;

  // Follow the playhead while playing, but yield to the user: any manual
  // scroll pauses following, which resumes after 5s of scroll idle. The
  // follow effect's own writes are told apart from user scrolls by matching
  // the scroll-event echo against the value it just wrote.
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    if (performance.now() < manualUntil.current) return;
    const sx = x + PAD_SIDE; // playhead position in scroll coordinates
    if (sx < el.scrollLeft + 24 || sx > el.scrollLeft + el.clientWidth - 80) {
      el.scrollLeft = Math.max(0, sx - 80);
      followWrote.current = el.scrollLeft; // read back: the browser clamps
    }
  }, [x, playing, scrollRef]);

  return (
    <div
      className="pointer-events-none absolute top-0 bottom-2 left-0 z-30 w-[1.5px] bg-[#0a84ff] shadow-[0_0_8px_rgba(10,132,255,0.6)]"
      style={{ transform: `translateX(${x}px)` }}
    >
      <div
        className="tl-playhead-cap pointer-events-auto absolute -top-0 -left-[7px] h-5 w-4 cursor-ew-resize"
        onPointerDown={onScrub}
      >
        <div className="mx-auto h-3 w-2.5 rounded-t-[3px] bg-[#0a84ff] [clip-path:polygon(0_0,100%_0,100%_58%,50%_100%,0_58%)]" />
      </div>
    </div>
  );
}

/** Transition badges for one track row, floating in the gutter where each
 * pair meets (the overlap midpoint; a hard cut for edge styles), vertically
 * centered on the row. Shared by track 0 and the upper tracks. */
function TransitionBadges({
  spans,
  pps,
  rowH,
}: {
  spans: ClipSpan[];
  pps: number;
  rowH: number;
}) {
  return (
    <>
      {spans.map((span, i) => {
        const d = span.clip.transition ?? 0;
        if (!spans[i + 1] || d <= 0) return null;
        const style = span.clip.transitionStyle ?? "crossfade";
        const Icon = TRANSITION_ICONS[style];
        return (
          <div
            key={`xf-${span.clip.id}`}
            // Above SELECTED_SHADOW's z-10: the badge marks the joint even
            // when a selected clip's ring runs under it.
            className="tl-xfade pointer-events-none absolute z-11 flex -translate-x-1/2 items-center justify-center rounded-full bg-[#0a84ff] text-white shadow-[0_0_0_2px_rgba(255,255,255,0.9)]"
            style={{
              left: (span.start + span.len - span.transitionOut / 2) * pps - CLIP_GAP / 2,
              top: 2 + (rowH - 4) / 2 - 8,
              width: 16,
              height: 16,
            }}
            title={`${TRANSITION_STYLE_LABELS[style]} ${d.toFixed(1)}s`}
          >
            <Icon className="size-2.5" />
          </div>
        );
      })}
    </>
  );
}

function ClipView({
  span,
  prevOverlap,
  mention,
  pps,
  selected,
  drag,
  parting,
  onDrag,
  onSnap,
  resolveTarget,
  onCrossMove,
  onCrossDrop,
  onDragActive,
}: {
  span: ClipSpan;
  /** Cross-dissolve overlap of the previous clip into this one, timeline
   * seconds — the room the incoming transition block claims on this clip's
   * left. This clip's own `span.transitionOut` claims the right. */
  prevOverlap: number;
  /** The clip's chat mention token ("@c2"), shown on hover so the user can
   * point the assistant at this exact segment. */
  mention: string;
  pps: number;
  selected: boolean;
  /** This clip's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another track-0 clip is dragging: animate this one's parting shifts. */
  parting: boolean;
  onDrag: (d: LaneDrag | null) => void;
  onSnap: (x: number | null) => void;
  /** Which drop the given screen point is over (a track / an insert gap). */
  resolveTarget: (clientX: number, clientY: number) => TrackTarget;
  /** Preview a cross-track drop (null clears it). */
  onCrossMove: (target: TrackTarget | null, start?: number, len?: number) => void;
  /** Commit a cross-track drop of this clip at `start`. */
  onCrossDrop: (id: string, target: TrackTarget, start: number) => void;
  /** Toggle the between-track insertion zones while this clip is dragging. */
  onDragActive: (active: boolean) => void;
}) {
  const { clip, asset } = span;
  const speed = clipSpeed(clip);
  // A cross-dissolve overlaps two clips; inset each box by half the overlap so
  // the pair meets at the overlap midpoint with the same CLIP_GAP gutter as a
  // hard cut (the dissolve badge floats in that gap).
  const leftXf = prevOverlap / 2;
  const rightXf = span.transitionOut / 2;
  const visStart = span.start + leftXf;
  const visLen = Math.max(0, span.len - leftXf - rightXf);
  const w = visLen * pps;
  // Frames start where the box does: skip the source seconds the left dissolve
  // consumed so the filmstrip stays aligned under the inset edge.
  const filmIn = clip.in + leftXf * speed;
  const filmOut = filmIn + (w / pps) * speed;

  const startFrame = useEdgeFrame(asset, filmIn, `${clip.id}:in`);
  const endFrame = useEdgeFrame(asset, filmOut, `${clip.id}:out`);
  const filmstrip = useMemo(
    () =>
      filmstripFrames(asset, filmIn, w, pps, speed, VIDEO_H - 4, 26, {
        start: startFrame,
        end: endFrame,
      }),
    [asset, filmIn, w, pps, speed, startFrame, endFrame]
  );

  // The move gesture is the shared lane behavior (parting, snapping); its
  // verticality is the video placement system — upper tracks and insert
  // gaps — resolved by DOM hit-testing.
  const ui = {
    pps,
    rowH: VIDEO_H,
    laneCount: 0,
    homeRow: 0,
    // The box is inset by half the incoming dissolve; click-to-seek anchors
    // on where the box is drawn, not the clip's footprint start.
    visStart,
    onDrag,
    onSnap,
    vertical: {
      resolve: (ev: PointerEvent) => resolveTarget(ev.clientX, ev.clientY),
      isHome: (t: TrackTarget) => samePlacement(t, TRACK_ZERO),
      preview: (t: TrackTarget | null, start: number, len: number) =>
        t ? onCrossMove(t, start, len) : onCrossMove(null),
      commit: (id: string, t: TrackTarget, start: number) => onCrossDrop(id, t, start),
      setActive: onDragActive,
    },
  };

  return (
    <div
      className={cn(
        "tl-clip group absolute top-0.5 cursor-grab overflow-hidden rounded-lg bg-neutral-200 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
        selected && SELECTED_SHADOW,
        clip.hidden && "opacity-40 grayscale",
        drag
          ? "tl-clip-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        // The ghost keeps the box's dissolve insets, offset to follow the pointer.
        left: drag ? drag.ghostX + leftXf * pps : visStart * pps,
        top: drag ? 2 + drag.ghostY : undefined,
        width: Math.max(10, w - CLIP_GAP),
        height: VIDEO_H - 4,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      onPointerDown={(e) => startLaneMove(e, "clip", clip.id, ui)}
    >
      <Filmstrip frames={filmstrip} grade={clip.grade} />
      {selected && (
        // A blue wash over the whole clip so a multi-selection reads at a
        // glance, not just from the thin border.
        <div className="pointer-events-none absolute inset-0 z-[1] bg-[#0a84ff]/25" />
      )}
      {drag ? (
        <span className="tl-dur-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] tabular-nums text-white">
          {(Math.round(span.len * 10) / 10).toFixed(1)}s
        </span>
      ) : (
        <span className="tl-mention-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {mention}
        </span>
      )}
      {asset.type === "video" && (
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
      <HideChip
        hidden={!!clip.hidden}
        className="bottom-1 right-2"
        onToggle={() => useEditor.getState().updateClip(clip.id, { hidden: !clip.hidden })}
      />
      <ClipMenu asset={asset} clip={clip}>
        {asset.type === "video" ? (
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
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "clip", clip.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "clip", clip.id, "r", ui)}
      />
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
          <FolderPlus /> Add to library
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => exportSegment(asset, clip)}>
          <ArrowDownToLine /> Export segment
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

/** Sample a clip's filmstrip tiles across its drawn width. Tiles keep the
 * asset's aspect until the tile cap would leave the tail of a long clip bare;
 * past that they widen so the capped count still spans the whole box. The
 * first and last tiles pin to the segment's exact boundary frames once
 * captured; middle tiles keep the nearest pre-sampled thumb. */
function filmstripFrames(
  asset: MediaAsset | undefined,
  filmIn: number,
  w: number,
  pps: number,
  speed: number,
  tileH: number,
  minTileW: number,
  edges?: { start: string | null; end: string | null }
) {
  if (!asset?.thumbs?.length || !asset.thumbStep) return [];
  const aspect = (asset.width ?? 16) / Math.max(1, asset.height ?? 9);
  const natural = Math.max(minTileW, Math.round(tileH * aspect));
  const count = Math.max(1, Math.min(120, Math.ceil(w / natural)));
  const imgW = Math.max(natural, w / count);
  const frames = Array.from({ length: count }, (_, k) => {
    const timeAt = filmIn + ((k * imgW + imgW / 2) / pps) * speed;
    const idx = Math.min(
      asset.thumbs!.length - 1,
      Math.max(0, Math.floor(timeAt / asset.thumbStep!))
    );
    return { src: asset.thumbs![idx], left: k * imgW, width: imgW };
  });
  if (edges?.start) frames[0] = { ...frames[0], src: edges.start };
  if (edges?.end && frames.length > 1) {
    frames[frames.length - 1] = { ...frames[frames.length - 1], src: edges.end };
  }
  return frames;
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
}: {
  frames: { src: string; left: number; width: number }[];
  grade?: ColorGrade;
}) {
  const tint = gradeTint(grade);
  return (
    <div
      className="tl-filmstrip pointer-events-none absolute inset-0 isolate"
      style={{ filter: gradeToCssFilter(grade) || undefined }}
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

function HideChip({
  hidden,
  onToggle,
  className,
}: {
  hidden: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={hidden ? "Enable clip" : "Disable clip"}
      aria-label={hidden ? "Enable clip" : "Disable clip"}
      className={cn(
        "tl-hide-chip absolute z-4 grid size-[18px] place-items-center rounded-[5px] bg-black/55 text-white transition-opacity hover:bg-black/75",
        hidden ? "opacity-100" : "opacity-0 group-hover:opacity-100",
        className
      )}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onToggle}
    >
      {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
    </button>
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
  /** Publish (or clear) the in-flight drag so the slot and rows track it. */
  onDrag: (d: LaneDrag | null) => void;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap: (x: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const len = clipLen(clip);
  const w = Math.max(10, len * pps);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !asset?.peaks) return;
    // Cap the backing store below browser canvas limits; the element is
    // CSS-stretched to the bar, so past the cap bars widen instead of the
    // tail going bare (a canvas keeps its intrinsic width under inset-x-0).
    const width = Math.min(16384, Math.round(w));
    const height = AUDIO_H - 8;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    const peaks = asset.peaks;
    const n = peaks.length;
    const from = (clip.in / asset.duration) * n;
    const span = ((clip.out - clip.in) / asset.duration) * n;
    const bars = Math.max(1, Math.floor(width / 3));
    for (let i = 0; i < bars; i++) {
      const p = peaks[Math.min(n - 1, Math.floor(from + (i / bars) * span))] ?? 0;
      const h = Math.max(1.5, p * (height - 2));
      ctx.fillRect(i * 3, (height - h) / 2, 2, h);
    }
  }, [asset, clip.in, clip.out, w]);

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
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : clip.start * pps,
        top: top + 2 + (drag ? drag.ghostY : 0),
        width: Math.max(10, w - CLIP_GAP),
        height: AUDIO_H - 4,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      onPointerDown={(e) => startLaneMove(e, "audio", clip.id, ui)}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-x-0 inset-y-1 w-full" />
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
      {mention && !drag && (
        <span className="tl-mention-chip pointer-events-none absolute top-1 left-1 z-2 rounded-[5px] bg-black/65 px-1.5 py-px font-mono text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
          {mention}
        </span>
      )}
      <ClipMenu asset={asset} clip={clip} />
      <MuteChip
        muted={!!clip.hidden}
        className="bottom-1 left-1"
        onToggle={() => useEditor.getState().updateAudio(clip.id, { hidden: !clip.hidden })}
      />
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

/** Timeline footprint (seconds) of an overlay clip, honoring its speed. */
function overlayLen(c: VideoClip) {
  const src = c.out - c.in;
  const eff = c.speed && c.speed > 0 ? src / c.speed : src;
  return Math.max(0.1, eff);
}

/**
 * An upper-track video clip: free-positioned by `start` like an audio clip,
 * draggable and trimmable. Full-frame layers (`scale === 1`) read as a stacked
 * composite; smaller ones are picture-in-picture. Hidden clips gray out.
 */
function OverlayClipView({
  clip,
  asset,
  prevOverlap,
  overlap,
  pps,
  selected,
  drag,
  parting,
  onDrag,
  onSnap,
  resolveTarget,
  onCrossMove,
  onCrossDrop,
  onDragActive,
}: {
  clip: VideoClip;
  asset: MediaAsset | undefined;
  /** Cross-dissolve overlap of the previous same-track clip into this one —
   * the room the incoming transition claims on this clip's left. */
  prevOverlap: number;
  /** This clip's own dissolve into the next same-track clip (its right). */
  overlap: number;
  pps: number;
  selected: boolean;
  /** This clip's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another upper-layer clip is dragging: animate this one's parting shifts. */
  parting: boolean;
  onDrag: (d: LaneDrag | null) => void;
  onSnap: (x: number | null) => void;
  resolveTarget: (clientX: number, clientY: number) => TrackTarget;
  onCrossMove: (target: TrackTarget | null, start?: number, len?: number) => void;
  onCrossDrop: (id: string, target: TrackTarget, start: number) => void;
  onDragActive: (active: boolean) => void;
}) {
  // A cross-dissolve overlaps two clips; inset each box by half the overlap
  // so the pair meets at the overlap midpoint with the same CLIP_GAP gutter
  // as a hard cut — identical to the track-0 boxes.
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const leftXf = prevOverlap / 2;
  const rightXf = overlap / 2;
  const visStart = clip.start + leftXf;
  const w = Math.max(10, Math.max(0, overlayLen(clip) - leftXf - rightXf) * pps);
  // Frames start where the box does: skip the source seconds the left
  // dissolve consumed so the filmstrip stays aligned under the inset edge.
  const filmIn = clip.in + leftXf * speed;
  const filmOut = filmIn + (w / pps) * speed;

  // Same filmstrip as a track-0 clip so an overlay reads as a video, not a
  // featureless bar — sampled across the clip's trimmed span.
  const startFrame = useEdgeFrame(asset, filmIn, `${clip.id}:in`);
  const endFrame = useEdgeFrame(asset, filmOut, `${clip.id}:out`);
  const filmstrip = useMemo(
    () =>
      filmstripFrames(asset, filmIn, w, pps, speed, OVERLAY_H - 4, 24, {
        start: startFrame,
        end: endFrame,
      }),
    [asset, filmIn, speed, w, pps, startFrame, endFrame]
  );

  if (!asset) return null;

  // The move gesture is the shared lane behavior (parting, snapping); its
  // verticality is the video placement system — other tracks (0 included)
  // and insert gaps — resolved by DOM hit-testing.
  const ui = {
    pps,
    rowH: OVERLAY_H,
    laneCount: 0,
    homeRow: 0,
    // The box is inset by half the incoming dissolve; click-to-seek anchors
    // on where the box is drawn, not the clip's footprint start.
    visStart,
    onDrag,
    onSnap,
    vertical: {
      resolve: (ev: PointerEvent) => resolveTarget(ev.clientX, ev.clientY),
      isHome: (t: TrackTarget) => samePlacement(t, { kind: "track", track: clip.track }),
      preview: (t: TrackTarget | null, start: number, len: number) =>
        t ? onCrossMove(t, start, len) : onCrossMove(null),
      commit: (id: string, t: TrackTarget, start: number) => onCrossDrop(id, t, start),
      setActive: onDragActive,
    },
  };

  return (
    <div
      className={cn(
        "tl-overlay-clip group absolute top-0.5 cursor-grab overflow-hidden rounded-lg bg-neutral-200 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]",
        selected && SELECTED_SHADOW,
        clip.hidden && "opacity-40 grayscale",
        drag
          ? "tl-overlay-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        // The ghost keeps the box's dissolve insets, offset to follow the pointer.
        left: drag ? drag.ghostX + leftXf * pps : visStart * pps,
        top: drag ? 2 + drag.ghostY : undefined,
        width: Math.max(10, w - CLIP_GAP),
        height: OVERLAY_H - 4,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      onPointerDown={(e) => startLaneMove(e, "overlayClip", clip.id, ui)}
    >
      <Filmstrip frames={filmstrip} grade={clip.grade} />
      {selected && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-[#0a84ff]/25" />
      )}
      {asset.type === "video" && (
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
      <ClipMenu asset={asset} clip={clip} />
      <HideChip
        hidden={!!clip.hidden}
        className="bottom-1 right-2"
        onToggle={() => useEditor.getState().updateClip(clip.id, { hidden: !clip.hidden })}
      />
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "overlayClip", clip.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "overlayClip", clip.id, "r", ui)}
      />
    </div>
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
  onDrag,
  onSnap,
}: {
  overlay: TextOverlay;
  pps: number;
  top: number;
  homeRow: number;
  laneCount: number;
  selected: boolean;
  /** This bar's live drag when it is the one being carried (ghost mode). */
  drag: LaneDrag | null;
  /** Another title is dragging: animate this bar's shifts as it parts. */
  parting: boolean;
  /** Publish (or clear) the in-flight drag so the slot and lanes track it. */
  onDrag: (d: LaneDrag | null) => void;
  /** Paint (or clear) the snap guide at this stage-x pixel. */
  onSnap: (x: number | null) => void;
}) {
  const w = Math.max(8, (o.end - o.start) * pps);
  const ui = { pps, rowH: TEXT_H, laneCount, homeRow, onDrag, onSnap };

  return (
    <div
      className={cn(
        "tl-text-bar group absolute flex cursor-grab items-center overflow-hidden rounded-md bg-gradient-to-b from-purple-500 to-purple-600 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.1)]",
        selected && SELECTED_SHADOW,
        drag
          ? "tl-text-ghost pointer-events-none cursor-grabbing opacity-80 shadow-2xl"
          : parting && "transition-[left] duration-150 ease-out"
      )}
      style={{
        left: drag ? drag.ghostX : o.start * pps,
        top: top + 2 + (drag ? drag.ghostY : 0),
        width: Math.max(8, w - CLIP_GAP),
        height: TEXT_H - 6,
        // Inline so it beats SELECTED_SHADOW's z-10 class on the same element.
        zIndex: drag ? 20 : undefined,
      }}
      onPointerDown={(e) => startLaneMove(e, "text", o.id, ui)}
    >
      <span className="pointer-events-none truncate px-2 text-[10.5px] font-medium text-white">
        {o.text.replace(/\n/g, " ")}
      </span>
      <span
        className={cn(trimHandle, "tl-trim-l left-0")}
        onPointerDown={(e) => startLaneTrim(e, "text", o.id, "l", ui)}
      />
      <span
        className={cn(trimHandle, "tl-trim-r right-0")}
        onPointerDown={(e) => startLaneTrim(e, "text", o.id, "r", ui)}
      />
    </div>
  );
}

/** A subtitle cue on its track: click selects (⌫ deletes it), drag to retime,
 * edges to trim. Editing the words happens in the Subtitles panel. */
function SubBar({
  cue,
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
  className,
}: {
  drag: LaneDrag;
  pps: number;
  rowH: number;
  barH: number;
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
        top: drag.targetRow * rowH + 2,
        width: Math.max(8, drag.len * pps - CLIP_GAP),
        height: barH,
      }}
    />
  );
}
