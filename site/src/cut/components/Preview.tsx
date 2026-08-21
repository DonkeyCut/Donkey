"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { usePlayback } from "@/cut/hooks/usePlayback";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { startDrag } from "@/cut/lib/drag";
import {
  playheadAt,
  previewAt,
  subscribePlayhead,
  usePreviewSelector,
  useSkim,
} from "@/cut/lib/playhead";
import { getClipSpans, projectDuration, useEditor } from "@/cut/lib/store";
import {
  capturePoster,
  capturePosterWhenReady,
  paintPoster,
  readPoster,
} from "@/cut/lib/posterCache";
import { resizePreviewSurface, setPreviewCanvas } from "@/cut/lib/previewCanvas";
import { CLIP_MAX_ZOOM, clipCovers, clipKeyed, clipPoseAt, clipZoom, contentRect, frameOf, isFullRect, rectOf, REGION_MAX_SCALE, type Aspect, type ClipSpan, type FrameRect, type MediaAsset, type VideoClip } from "@/cut/lib/types";
import { hasMaskKeys, type MaskKey } from "@donkeycut/effects-kit";
import { cn } from "@/lib/utils";
import { MaskGizmoCore, OverlayChromeHost, OverlayLayer } from "./OverlayLayer";
import { CORNER_HANDLES, HANDLE_AXIS, TransformHandles, type ResizeHandle } from "./TransformHandles";
import {
  StageEffectPaint,
  StagePictureFx,
  stageSliceStructure,
  useEffectLanes,
} from "./StageEffects";

/** How far a clip's picture hangs past its box, in the box's units. Zero on an
 * axis with nothing to spare. */
function overflowOf(
  clip: VideoClip,
  asset: { width?: number; height?: number },
  box: FrameRect
): { ox: number; oy: number } {
  if (!asset.width || !asset.height) return { ox: 0, oy: 0 };
  const pic = contentRect(
    box,
    asset.width,
    asset.height,
    clipCovers(clip),
    clipZoom(clip),
    clip.panX ?? 0,
    clip.panY ?? 0
  );
  return { ox: Math.max(0, pic.w - box.w), oy: Math.max(0, pic.h - box.h) };
}

/** A stationary click on the stage: the first click clears whatever is
 * selected; with nothing selected it plays or pauses, rewinding first when
 * the playhead is parked at the end. */
function stageClick() {
  const s = useEditor.getState();
  if (s.selection || s.multiSelection.length) {
    s.select(null);
    return;
  }
  const total = projectDuration(s);
  if (!total) return;
  if (!s.playing && playheadAt() >= total - 0.01) s.seek(0);
  s.setPlaying(!s.playing);
}

/** The clip under the playhead, when its picture overflows the whole frame —
 * covering it or zoomed into it. A regioned clip is panned from its own
 * preview handle instead. */
function pannableSpan(
  s: { clips: VideoClip[]; assets: MediaAsset[]; aspect: Aspect },
  t: number
): ClipSpan | null {
  const spans = getClipSpans(s.clips, s.assets);
  const span = spans.find((sp) => t >= sp.start && sp.start + sp.len > t) ?? spans[spans.length - 1];
  if (!span || !isFullRect(rectOf(span.clip))) return null;
  const frame = frameOf(s.aspect);
  const { ox, oy } = overflowOf(span.clip, span.asset, { x: 0, y: 0, w: frame.w, h: frame.h });
  return ox > 1 || oy > 1 ? span : null;
}

/**
 * Show the grab cursor while the clip under the playhead can be panned.
 *
 * Which clip that is changes sixty times a second, and the answer is one class
 * on one element. Rendering the whole preview to find out would put every
 * frame of playback through React; the class goes on from a subscription
 * instead, and only when the answer actually changes.
 */
function usePannableCursor(target: RefObject<HTMLElement | null>) {
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const aspect = useEditor((s) => s.aspect);
  useEffect(() => {
    const el = target.current;
    if (!el) return;
    let on: boolean | null = null;
    const apply = () => {
      const next = pannableSpan({ clips, assets, aspect }, previewAt()) !== null;
      if (next === on) return;
      on = next;
      el.classList.toggle("cursor-grab", next);
      el.classList.toggle("active:cursor-grabbing", next);
    };
    apply();
    return subscribePlayhead(apply);
  }, [target, clips, assets, aspect]);
}

/** Paint the picture this project's preview last showed, then hand the canvas
 * back to the engine. Cloud media is a network away, so without this the
 * preview holds black for about a second on every open while the first decoder
 * fetches and seeks — the engine leaves the canvas alone until it has a frame,
 * which is what lets a poster sit there in the meantime. Once a real frame
 * lands it is kept for the next open. */
function useCachedFirstFrame(canvasRef: RefObject<HTMLCanvasElement | null>) {
  // Re-runs per load, so reopening a project repaints and re-captures.
  const epoch = useEditor((s) => (s.loaded ? s.loadEpoch : 0));
  const projectId = useEditor((s) => s.projectId);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !epoch || !projectId) return;
    let alive = true;
    void readPoster("frame", projectId).then((data) => {
      // Only if the engine has not beaten us to it — a warm decoder paints
      // within the same frame, and the real picture outranks a stored one.
      if (alive && data && !capturePoster("frame", projectId, canvas)) {
        void paintPoster(canvas, data);
      }
    });
    const stop = capturePosterWhenReady("frame", projectId, () => canvasRef.current);
    return () => {
      alive = false;
      stop();
    };
  }, [canvasRef, epoch, projectId]);
}

/** How far the camera zooms from the fitted size, in multiples of the fit. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
/** The ladder the zoom buttons climb; the wheel moves freely between rungs. */
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
/** How long the zoom control lingers after the last camera move. */
const HUD_LINGER_MS = 2600;
/** How still the camera has to be before the backing store re-resolves to the
 * size on screen. */
const SURFACE_SETTLE_MS = 220;

/** The stage's corner rounding: tiny, and gone once the picture is small on
 * screen. */
const stageRadius = (w: number, h: number) => (Math.min(w, h) < 140 ? 0 : 6);

/** How much of the picture has to stay inside the pane to count as on screen. */
const ONSCREEN_MIN_PX = 24;

/** Whether any of the picture still lands in the pane. A pan or a zoom can
 * carry the whole stage past an edge, and a pane showing nothing but backdrop
 * is the moment the camera control has to stay up. */
function pictureInPane(
  cam: { x: number; y: number },
  stage: { w: number; h: number },
  pane: { w: number; h: number }
): boolean {
  const left = (pane.w - stage.w) / 2 + cam.x;
  const top = (pane.h - stage.h) / 2 + cam.y;
  const visX = Math.min(pane.w, left + stage.w) - Math.max(0, left);
  const visY = Math.min(pane.h, top + stage.h) - Math.max(0, top);
  return visX >= Math.min(ONSCREEN_MIN_PX, stage.w) && visY >= Math.min(ONSCREEN_MIN_PX, stage.h);
}

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // The camera: the picture's fitted size at 100%, the pane it lives in, and
  // the view's zoom and pan on top. The stage's on-screen size stays the unit
  // every gizmo and drag measures in.
  const [base, setBase] = useState({ w: 270, h: 480 });
  const [pane, setPane] = useState({ w: 300, h: 500 });
  // The zoom lives in React state — the stage's size and the canvas backing
  // store follow it. The pan is one transform on one element, written to the
  // DOM directly: a pan changes no layout, and the resize compensation has to
  // land in the same frame as the layout move it cancels, ahead of React's
  // next render, or the picture blinks to the new center and back.
  const [zoom, setZoom] = useState(1);
  const camRef = useRef({ zoom: 1, x: 0, y: 0 });
  const boxRef = useRef<HTMLDivElement>(null);
  // Whether the picture has left the pane entirely. Every camera move funnels
  // through applyPan, so that is where it gets decided; the geometry it reads
  // is mirrored into a ref because a pan runs between renders.
  const [lost, setLost] = useState(false);
  const lostRef = useRef(false);
  const geomRef = useRef({ stage: { w: 0, h: 0 }, pane: { w: 0, h: 0 } });
  const applyPan = useCallback(() => {
    const box = boxRef.current;
    if (!box) return;
    const { x, y } = camRef.current;
    box.style.transform = x || y ? `translate(${x}px, ${y}px)` : "";
    const g = geomRef.current;
    const gone = g.stage.w > 0 && !pictureInPane(camRef.current, g.stage, g.pane);
    lostRef.current = gone;
    setLost(gone);
  }, []);
  const refitRef = useRef(() => {});
  // The unclipped layer the selected element's chrome portals into, so an
  // outline hanging past the frame edge stays visible and grabbable.
  const [chromeHost, setChromeHost] = useState<HTMLDivElement | null>(null);
  const aspect = useEditor((s) => s.aspect);
  const frame = frameOf(aspect);

  // The picture's box plus the empty room around it in the pane, which is where
  // the outline of an oversized picture gets to show.
  const stage = useMemo(() => {
    const w = Math.max(2, Math.round(base.w * zoom));
    const h = Math.max(2, Math.round(base.h * zoom));
    return {
      w,
      h,
      padX: Math.max(0, Math.floor((pane.w - w) / 2)),
      padY: Math.max(0, Math.floor((pane.h - h) / 2)),
    };
  }, [base, pane, zoom]);

  // After every commit, so the transform a zoom computed rides the same paint
  // as the stage's new size, and the picture is judged against the geometry
  // that commit settled on.
  useLayoutEffect(() => {
    geomRef.current = { stage, pane };
    applyPan();
  });

  // The zoom control shows while the camera is moving and lingers a moment
  // after, the way the browser's own zoom bubble does. It stays up for as long
  // as the picture is off screen, which is the one state a blank pane cannot
  // be recovered from without it.
  const [hud, setHud] = useState({ shown: false, open: false });
  const hudTimer = useRef(0);
  const hudHeld = useRef(false);
  const pokeHud = useCallback(() => {
    setHud((h) => (h.shown ? h : { ...h, shown: true }));
    window.clearTimeout(hudTimer.current);
    hudTimer.current = window.setTimeout(() => {
      if (!hudHeld.current && !lostRef.current) setHud({ shown: false, open: false });
    }, HUD_LINGER_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(hudTimer.current), []);

  /** Scale the view about a screen point, which stays planted on the picture. */
  const zoomAt = useCallback(
    (cx: number, cy: number, factor: number) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const v = camRef.current;
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
      if (next === v.zoom) return;
      const f = next / v.zoom;
      const centerX = r.left + r.width / 2;
      const centerY = r.top + r.height / 2;
      camRef.current = {
        zoom: next,
        x: cx - (cx - (centerX + v.x)) * f - centerX,
        y: cy - (cy - (centerY + v.y)) * f - centerY,
      };
      setZoom(next);
      pokeHud();
    },
    [pokeHud]
  );

  /** One rung up or down the ladder, about the pane's center. */
  const stepZoom = useCallback(
    (dir: 1 | -1) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      const z = camRef.current.zoom;
      const next =
        dir > 0
          ? ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM
          : [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999) ?? MIN_ZOOM;
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, next / z);
    },
    [zoomAt]
  );

  usePlayback(canvasRef);
  // An effect grades what plays under it, so the stage is built in slices: the
  // picture, then the elements of each lane band with the look of the effects
  // above them, and each effect's paints sitting where the effect does. Only
  // which lanes hold effects decides the shape, so this component never renders
  // for the clock; each slice reads the clock for itself.
  const effectLanes = useEffectLanes();
  const slices = useMemo(() => stageSliceStructure(effectLanes), [effectLanes]);
  usePannableCursor(stageRef);

  useEffect(() => {
    setPreviewCanvas(canvasRef.current);
    return () => setPreviewCanvas(null);
  }, []);

  useCachedFirstFrame(canvasRef);

  // The canvas backing store matches the pixels the screen will actually show,
  // capped at the project's own frame. Painting a 4K backing store into a box
  // a few hundred pixels wide put every grade, look and mask pass through
  // millions of pixels nobody could see; the export renders at full size on its
  // own surface, so nothing about the file changes.
  const wantSurface = useMemo(() => {
    const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.min(frame.w, Math.round(stage.w * dpr)));
    return { w, h: Math.max(2, Math.round((w * frame.h) / frame.w)) };
  }, [stage.w, frame.w, frame.h]);

  /**
   * The resolution the store actually holds, which is not the same thing as
   * the size on screen.
   *
   * Re-resolving costs the picture: the store is erased, and the decoders are
   * keyed to their decode height, so a new height opens sources that have yet
   * to produce a frame. Doing that on every step of a zoom is the flicker —
   * the resize empties the canvas and the replacement frame is not there yet.
   * So the resolution follows the screen only once the picture is standing
   * still: never mid-playback, and only after the camera has settled. In
   * between, the pixels already on the canvas are scaled to the box, which
   * costs sharpness and nothing else.
   */
  const playing = useEditor((s) => s.playing);
  const [surface, setSurface] = useState(wantSurface);
  // What the store was last resolved for. The wait below is there to absorb a
  // camera in motion, so everything else lands at once: the opening fit, and a
  // change of project aspect, which the store has to match or the picture is
  // squashed into the wrong shape.
  const resolved = useRef({ frameW: 0, fitted: false });
  useEffect(() => {
    if (wantSurface.w === surface.w && wantSurface.h === surface.h) return;
    const camera = resolved.current.fitted && resolved.current.frameW === frame.w;
    resolved.current = { frameW: frame.w, fitted: true };
    if (!camera) {
      setSurface(wantSurface);
      return;
    }
    if (playing) return;
    const id = window.setTimeout(() => setSurface(wantSurface), SURFACE_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [wantSurface, surface, playing, frame.w]);

  // The store is written here rather than as a rendered attribute, because
  // assigning one erases the canvas and the picture has to come across.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) resizePreviewSurface(canvas, surface.w, surface.h);
  }, [surface]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const { w: rw, h: rh } = frameOf(aspect);
    const fit = () => {
      const r = wrap.getBoundingClientRect();
      const pad = 28;
      const availW = Math.max(120, r.width - pad);
      const availH = Math.max(120, r.height - pad);
      const scale = Math.min(availW / rw, availH / rh);
      setBase({ w: Math.floor(scale * rw), h: Math.floor(scale * rh) });
      camRef.current = { zoom: 1, x: 0, y: 0 };
      applyPan();
      setZoom(1);
    };
    refitRef.current = fit;
    // The fit happens once per aspect. After that the camera holds its place
    // on screen: when a panel opens and the pane's center moves, the pan
    // absorbs the difference. The observer's callback runs after layout and
    // before paint, and the transform is written right there, so the frame the
    // pane moved in is the frame the move is cancelled in.
    let prev: DOMRect | null = null;
    const measure = () => {
      const r = wrap.getBoundingClientRect();
      if (!prev) {
        fit();
      } else {
        const dx = prev.left + prev.width / 2 - (r.left + r.width / 2);
        const dy = prev.top + prev.height / 2 - (r.top + r.height / 2);
        if (dx || dy) {
          camRef.current.x += dx;
          camRef.current.y += dy;
          applyPan();
        }
      }
      prev = r;
      setPane({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [aspect, applyPan]);

  // Pinch and ⌘/ctrl-wheel zoom about the cursor; a plain scroll pans. The
  // listener is native so preventDefault beats the page's own pinch zoom.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : 1;
      if (e.ctrlKey || e.metaKey) {
        // A trackpad pinch streams small deltas; a wheel notch arrives as one
        // big one. The clamp keeps a notch to a comfortable step.
        const factor = Math.max(1 / 1.6, Math.min(1.6, Math.exp(-e.deltaY * k * 0.01)));
        zoomAt(e.clientX, e.clientY, factor);
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        camRef.current.x -= dx * k;
        camRef.current.y -= dy * k;
        applyPan();
        pokeHud();
      }
    };
    wrap.addEventListener("wheel", onWheel, { passive: false });
    return () => wrap.removeEventListener("wheel", onWheel);
  }, [zoomAt, pokeHud, applyPan]);

  // Drag a fill-mode clip inside the frame to choose the visible crop.
  const panDrag = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const span = pannableSpan(s, previewAt());
    if (!span) return false;
    const fr = frameOf(s.aspect);
    const { ox, oy } = overflowOf(span.clip, span.asset, { x: 0, y: 0, w: fr.w, h: fr.h });
    const clipId = span.clip.id;
    const panX0 = span.clip.panX ?? 0;
    const panY0 = span.clip.panY ?? 0;
    const toFrame = fr.w / stage.w; // screen px → frame px
    // Selection moves to the panned clip only once the pointer actually travels;
    // a stationary press is a stage click: it deselects first, and plays or
    // pauses once nothing is selected.
    let began = false;
    startDrag(e, {
      onMove: (dx, dy) => {
        if (!began) {
          if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
          began = true;
          const st = useEditor.getState();
          st.select({ kind: "clip", id: clipId });
          st.pushHistory();
        }
        // Content follows the pointer; pan is the crop-window position.
        useEditor.getState().updateClipTransient(clipId, {
          panX: ox > 1 ? Math.max(-1, Math.min(1, panX0 - (dx * toFrame) / (ox / 2))) : 0,
          panY: oy > 1 ? Math.max(-1, Math.min(1, panY0 - (dy * toFrame) / (oy / 2))) : 0,
        });
      },
      // startDrag suppresses the click event, so a stationary press on a
      // pannable clip runs the stage click here instead: clear the selection
      // first, play or pause once nothing is selected.
      onUp: (_dx, _dy, moved) => {
        if (!moved) stageClick();
      },
    });
    return true;
  };

  // The topmost regioned clip under a stage point at the playhead — clicking
  // its picture selects it, in the preview and the timeline alike. Full-frame
  // clips stay out: a click on the backdrop clears the selection.
  const clipAtPoint = (e: React.MouseEvent): string | null => {
    const rct = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - rct.left) / rct.width;
    const py = (e.clientY - rct.top) / rct.height;
    const s = useEditor.getState();
    const t = previewAt();
    let best: { id: string; track: number } | null = null;
    for (const c of s.clips) {
      if (c.hidden) continue;
      const r = rectOf(c);
      if (isFullRect(r)) continue;
      const speed = c.speed && c.speed > 0 ? c.speed : 1;
      const len = Math.max(0.1, (c.out - c.in) / speed);
      if (t < c.start || t >= c.start + len) continue;
      if (px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
      if (!best || c.track > best.track) best = { id: c.id, track: c.track };
    }
    return best?.id ?? null;
  };

  return (
    <section className="preview-pane relative flex min-h-0 min-w-0 flex-col bg-muted/40 select-none">
      <div
        ref={wrapRef}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-3"
        // A middle-button drag pans the camera from anywhere in the pane, ahead
        // of whatever gizmo or clip sits under the pointer.
        onPointerDownCapture={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          e.stopPropagation();
          const el = e.currentTarget;
          el.setPointerCapture(e.pointerId);
          const v0 = { ...camRef.current };
          const sx = e.clientX;
          const sy = e.clientY;
          const move = (ev: PointerEvent) => {
            camRef.current = { zoom: v0.zoom, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy };
            applyPan();
            pokeHud();
          };
          const up = () => {
            el.removeEventListener("pointermove", move);
            el.removeEventListener("pointerup", up);
            el.removeEventListener("pointercancel", up);
          };
          el.addEventListener("pointermove", move);
          el.addEventListener("pointerup", up);
          el.addEventListener("pointercancel", up);
        }}
        // A drag on the empty room around the picture pans the camera; a
        // stationary press there clears the selection, and so does one on
        // the picture itself.
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const v0 = { ...camRef.current };
          startDrag(e, {
            onMove: (dx, dy) => {
              camRef.current = { zoom: v0.zoom, x: v0.x + dx, y: v0.y + dy };
              applyPan();
              pokeHud();
            },
            onUp: (_dx, _dy, moved) => {
              if (!moved) useEditor.getState().select(null);
            },
            cursor: () => "grabbing",
          });
        }}
      >
        {/* The selection handle mounts beside the stage, outside its clipping,
            so a box dragged past the frame edge stays visible and grabbable. */}
        <div
          ref={boxRef}
          className="relative shrink-0"
          style={{ width: stage.w, height: stage.h }}
        >
        <div
          ref={stageRef}
          className={cn(
            "stage absolute inset-0 overflow-hidden bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_36px_rgba(0,0,0,0.18)]"
          )}
          style={{ borderRadius: stageRadius(stage.w, stage.h) }}
          onPointerDown={(e) => {
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).tagName === "CANVAS"
            ) {
              // A press over a regioned clip belongs to the click handler
              // below (select it); a pan gesture here would swallow the click.
              if (clipAtPoint(e)) return;
              panDrag(e);
            }
          }}
          // A native drag on the canvas swallows the click, so this only fires
          // for a stationary click.
          onClick={(e) => {
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).tagName === "CANVAS"
            ) {
              const hit = clipAtPoint(e);
              if (hit) {
                useEditor.getState().select({ kind: "clip", id: hit });
                return;
              }
              stageClick();
            }
          }}
        >
          <StagePictureFx>
          <canvas
            ref={canvasRef}
            // The backing store is sized in a layout effect, which carries the
            // picture across the resize; rendering it as an attribute would
            // blank the canvas on every change.
            className="block size-full"
            // Drag the viewport to reference what's on screen: the clip under
            // the playhead travels as a media drag (timeline placement, chat
            // attachment, generation reference). Pan on a fill clip wins —
            // its pointerdown cancels the native drag.
            draggable
            onDragStart={(e) => {
              const s = useEditor.getState();
              const spans = getClipSpans(s.clips, s.assets);
              const t = previewAt();
              const span =
                spans.find((sp) => t >= sp.start && sp.start + sp.len > t) ??
                spans[spans.length - 1];
              if (!span) return e.preventDefault();
              setAssetDragData(e, span.asset.id);
            }}
            onDragEnd={clearAssetDrag}
          />
          </StagePictureFx>
          {slices.map((slice) =>
            slice.kind === "elements" ? (
              <OverlayChromeHost.Provider key={slice.key} value={chromeHost}>
                <OverlayLayer
                  stageWidth={stage.w}
                  gradeAbove={slice.gradeAbove}
                  from={slice.from}
                  to={slice.to}
                  captions={slice.captions}
                />
              </OverlayChromeHost.Provider>
            ) : (
              <StageEffectPaint key={slice.key} lane={slice.lane} />
            )
          )}
        </div>
        {/* Chrome layers sit beside the stage, outside its clipping: the
            element chrome host, the clip's mask gizmo, and the clip gizmo.
            The host hands the frame's corner rounding to the chrome inside,
            whose frame-clipped rings follow the stage's own corners. */}
        <div
          ref={setChromeHost}
          className="pointer-events-none absolute inset-0"
          style={{ "--stage-radius": `${stageRadius(stage.w, stage.h)}px` } as React.CSSProperties}
        />
        <ClipMaskGizmo stage={stage} />
        <ClipTransformGizmo stage={stage} />
        </div>
      </div>
      <ZoomHud
        zoom={zoom}
        shown={hud.shown || lost}
        open={hud.open}
        onToggle={() => {
          setHud((h) => ({ shown: true, open: !h.open }));
          pokeHud();
        }}
        onZoom={stepZoom}
        onReset={() => {
          refitRef.current();
          pokeHud();
        }}
        onHold={(held) => {
          hudHeld.current = held;
          if (!held) pokeHud();
        }}
      />
    </section>
  );
}

/**
 * The camera's zoom control, in the pane's top-right corner. It appears while
 * the camera moves and lingers a moment after, and holds while the picture is
 * off screen; the round button opens a bubble with the zoom level, a step in
 * each direction, and Reset, which refits the picture to the pane.
 */
function ZoomHud({
  zoom,
  shown,
  open,
  onToggle,
  onZoom,
  onReset,
  onHold,
}: {
  zoom: number;
  shown: boolean;
  open: boolean;
  onToggle: () => void;
  onZoom: (dir: 1 | -1) => void;
  onReset: () => void;
  onHold: (held: boolean) => void;
}) {
  const Icon = zoom < 0.999 ? ZoomOut : ZoomIn;
  return (
    <div
      className={cn(
        "absolute top-3 right-3 z-20 flex origin-[right_center] items-center gap-2 transition-[opacity,transform]",
        shown
          ? "scale-100 opacity-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
          : "pointer-events-none scale-90 opacity-0 duration-200 ease-in"
      )}
      onPointerEnter={() => onHold(true)}
      onPointerLeave={() => onHold(false)}
    >
      {/* The bubble unfurls out of the button's left side — it stretches open
          past its resting size and settles through a bounce or two — and
          tucks back in with a quick, smooth ease. */}
      <div
        className={cn(
          "flex origin-right items-center gap-1 rounded-full border bg-background/95 py-1 pr-1 pl-3 shadow-md backdrop-blur",
          open
            ? "animate-[cut-hud-unfurl_480ms_both]"
            : "pointer-events-none translate-x-4 scale-x-50 scale-y-75 opacity-0 transition-[opacity,transform] duration-200 ease-in"
        )}
      >
        <span className="w-11 text-center text-xs font-medium tabular-nums">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          title="Zoom out"
          onClick={() => onZoom(-1)}
          className="grid size-7 place-items-center rounded-full text-foreground hover:bg-accent"
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          type="button"
          title="Zoom in"
          onClick={() => onZoom(1)}
          className="grid size-7 place-items-center rounded-full text-foreground hover:bg-accent"
        >
          <ZoomIn className="size-4" />
        </button>
        <button
          type="button"
          onClick={onReset}
          className="ml-1 rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-accent"
        >
          Reset
        </button>
      </div>
      <button
        type="button"
        title={`Zoom ${Math.round(zoom * 100)}%`}
        onClick={onToggle}
        className="grid size-9 shrink-0 place-items-center rounded-full border bg-background/95 text-foreground shadow-md backdrop-blur hover:bg-accent"
      >
        <Icon className="size-4" />
      </button>
    </div>
  );
}

/**
 * Direct manipulation for the selected video clip, on any track and at any
 * size: drag the blue box to move it, a corner to scale it whole, a side to
 * pull one edge, the button above to turn it. Every gesture writes the clip's
 * own `frame`/`rotation`, and the gizmo shows only while the clip is live under
 * the playhead so it lines up with what the compositor draws.
 *
 * The grey outline beside it is the picture itself — where the source lands
 * once its box has fitted or cropped it. When it overflows, its corners zoom
 * and its interior pans, which is how a landscape shot gets framed for a
 * vertical cut.
 */
/** How close (screen px) a box edge pulls onto a snap line while dragging. */
const SNAP_PX = 8;

/** The picture's box on screen plus the empty room around it in the pane. */
type Stage = { w: number; h: number; padX: number; padY: number };

/** Snap a moving box along one axis: its leading edge, center, and trailing
 * edge each pull to the frame's edges and centerline. Returns the snapped
 * position and the frame line it landed on, for the guide. */
function snapAxis(v: number, size: number, tol: number): { v: number; guide: number | null } {
  let best = { v, guide: null as number | null, d: tol };
  for (const offset of [0, size / 2, size]) {
    for (const target of [0, 0.5, 1]) {
      const d = Math.abs(v - (target - offset));
      if (d < best.d) best = { v: target - offset, guide: target, d };
    }
  }
  return best;
}

/** The frame line nearest a resized edge, within tolerance: either frame
 * edge or the centerline, whichever way the grip travels. */
function snapEdge(v: number, tol: number): number | null {
  let best: number | null = null;
  let bd = tol;
  for (const target of [0, 0.5, 1]) {
    const d = Math.abs(v - target);
    if (d < bd) {
      bd = d;
      best = target;
    }
  }
  return best;
}

function ClipTransformGizmo({ stage }: { stage: Stage }) {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const skimTime = useSkim();
  const layerRef = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const [turning, setTurning] = useState<number | null>(null);
  // The gizmo only cares whether its clip is on screen, so it subscribes to
  // that answer instead of to the clock: one render when the clip comes and
  // goes, rather than one per frame while it stays.
  const selectedClip = selection?.kind === "clip" ? clips.find((c) => c.id === selection.id) : null;
  const live = usePreviewSelector((t) => {
    if (!selectedClip) return false;
    const speed = selectedClip.speed && selectedClip.speed > 0 ? selectedClip.speed : 1;
    const len = Math.max(0.1, (selectedClip.out - selectedClip.in) / speed);
    return t >= selectedClip.start && t < selectedClip.start + len;
  });
  // While hover-scrubbing the preview shows the skimmer's frame, where the
  // selected clip may not even be on screen — selection stays, the gizmo hides.
  if (skimTime !== null) return null;
  const clip = selectedClip;
  if (!clip || clip.hidden || !live) return null;

  const st = () => useEditor.getState();
  const patch = (p: Partial<VideoClip>) => st().updateClipTransient(clip.id, p);
  /**
   * A drag on one of the gizmo's large surfaces — the box body, the picture's
   * interior. The history checkpoint waits for real travel; a press that
   * never travels is a stage click, which here clears the clip's selection
   * (playback stays put — something was selected).
   */
  const surfaceDrag = (
    e: React.PointerEvent,
    onMove: (dx: number, dy: number) => void,
    onEnd?: () => void
  ) => {
    e.stopPropagation();
    let began = false;
    startDrag(e, {
      onMove: (dx, dy) => {
        if (!began) {
          if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
          began = true;
          st().pushHistory();
        }
        onMove(dx, dy);
      },
      onUp: (_dx, _dy, moved) => {
        onEnd?.();
        if (!moved) stageClick();
      },
    });
  };
  const asset = assets.find((a) => a.id === clip.assetId);
  const r = rectOf(clip);
  const rotation = clip.rotation ?? 0;
  const zoom = clipZoom(clip);
  // Where the source actually lands inside the box — the same geometry the
  // compositor draws and the export crops, measured in stage pixels so the two
  // axes share one scale.
  const boxPx = { x: r.x * stage.w, y: r.y * stage.h, w: r.w * stage.w, h: r.h * stage.h };
  const pic =
    asset?.width && asset?.height
      ? contentRect(
          boxPx,
          asset.width,
          asset.height,
          clipCovers(clip),
          zoom,
          clip.panX ?? 0,
          clip.panY ?? 0
        )
      : boxPx;
  const ox = Math.max(0, pic.w - boxPx.w);
  const oy = Math.max(0, pic.h - boxPx.h);
  const overflows = ox > 1 || oy > 1;
  // The outline is worth drawing whenever the picture and its box part ways:
  // cropped past the edges, or sitting inside them with margins.
  const showPicture = Math.abs(pic.w - boxPx.w) > 2 || Math.abs(pic.h - boxPx.h) > 2;

  // The box may leave the frame — oversize it to focus on an area, or park it
  // partly off screen — as long as a sliver stays inside to grab.
  const onMoveBox = (e: React.PointerEvent) =>
    surfaceDrag(
      e,
      (dx, dy) => {
        const sx = snapAxis(r.x + dx / stage.w, r.w, SNAP_PX / stage.w);
        const sy = snapAxis(r.y + dy / stage.h, r.h, SNAP_PX / stage.h);
        setGuides({ x: sx.guide, y: sy.guide });
        patch({
          frame: {
            ...r,
            x: Math.max(0.05 - r.w, Math.min(0.95, sx.v)),
            y: Math.max(0.05 - r.h, Math.min(0.95, sy.v)),
          },
        });
      },
      () => setGuides({ x: null, y: null })
    );

  // A turned box is grabbed on screen but sized in the frame's own axes, so a
  // grip's travel comes back the way the box went out.
  const unturn = (dx: number, dy: number) => {
    if (!rotation) return { dx, dy };
    const a = (-rotation * Math.PI) / 180;
    return { dx: dx * Math.cos(a) - dy * Math.sin(a), dy: dx * Math.sin(a) + dy * Math.cos(a) };
  };

  // A corner scales the box whole, the way every editor's corner does: the
  // shape holds and the opposite corner stays planted. A side grip pulls its
  // own edge and snaps to the frame.
  const onResize = (handle: ResizeHandle, e: React.PointerEvent) => {
    e.stopPropagation();
    st().pushHistory();
    const a = HANDLE_AXIS[handle];
    const corner = a.x !== 0 && a.y !== 0;
    startDrag(e, {
      onMove: (rawX, rawY) => {
        const { dx, dy } = unturn(rawX, rawY);
        if (corner) {
          const grow =
            1 + (a.x * (dx / stage.w) / r.w + a.y * (dy / stage.h) / r.h) / 2;
          const kMin = 0.05 / Math.min(r.w, r.h);
          const kMax = REGION_MAX_SCALE / Math.max(r.w, r.h);
          let k = Math.max(kMin, Math.min(kMax, grow));
          // The dragged corner's own edges pull onto the frame lines: the
          // scale adjusts so whichever edge sits closest lands exactly there.
          const x0 = a.x > 0 ? r.x : r.x + r.w;
          const y0 = a.y > 0 ? r.y : r.y + r.h;
          type EdgeHit = { k: number; axis: "x" | "y"; line: number; d: number };
          const consider = (
            dir: number,
            from: number,
            size: number,
            stageSize: number,
            axis: "x" | "y"
          ): EdgeHit[] =>
            [0, 0.5, 1].flatMap((line) => {
              const kt = (line - from) / (dir * size);
              if (kt < kMin || kt > kMax) return [];
              const d = Math.abs(from + dir * size * k - line) * stageSize;
              return d < SNAP_PX ? [{ k: kt, axis, line, d }] : [];
            });
          const hit = [
            ...consider(a.x, x0, r.w, stage.w, "x"),
            ...consider(a.y, y0, r.h, stage.h, "y"),
          ].reduce<EdgeHit | null>((best, c) => (!best || c.d < best.d ? c : best), null);
          if (hit) k = hit.k;
          const w = r.w * k;
          const h = r.h * k;
          setGuides({
            x: hit?.axis === "x" ? hit.line : null,
            y: hit?.axis === "y" ? hit.line : null,
          });
          patch({
            frame: {
              x: a.x > 0 ? r.x : r.x + r.w - w,
              y: a.y > 0 ? r.y : r.y + r.h - h,
              w,
              h,
            },
          });
          return;
        }
        // One axis at a time: where the grabbed edge lands, snapped to the
        // frame, then the span it leaves against the planted edge.
        const pull = (
          dir: -1 | 0 | 1,
          pos: number,
          size: number,
          d: number,
          stageSize: number
        ) => {
          if (!dir) return { pos, size, guide: null as number | null };
          const far = dir > 0 ? pos : pos + size;
          const edge = (dir > 0 ? pos + size : pos) + d / stageSize;
          const snapped = snapEdge(edge, SNAP_PX / stageSize);
          const at = snapped ?? edge;
          // Signed: a grip dragged past the planted edge stops at the floor and
          // the box keeps its side.
          const span = dir > 0 ? at - far : far - at;
          const next = Math.max(0.1, Math.min(REGION_MAX_SCALE, span));
          return {
            pos: dir > 0 ? far : far - next,
            size: next,
            guide: snapped !== null && next === span ? snapped : null,
          };
        };
        const hx = pull(a.x, r.x, r.w, dx, stage.w);
        const hy = pull(a.y, r.y, r.h, dy, stage.h);
        setGuides({ x: hx.guide, y: hy.guide });
        patch({ frame: { x: hx.pos, w: hx.size, y: hy.pos, h: hy.size } });
      },
      onUp: () => setGuides({ x: null, y: null }),
    });
  };

  /** Client coordinates of a point given in stage pixels. */
  const clientOf = (px: number, py: number) => {
    const at = layerRef.current?.getBoundingClientRect();
    return { x: (at?.left ?? 0) + stage.padX + px, y: (at?.top ?? 0) + stage.padY + py };
  };

  const onRotate = (e: React.PointerEvent) => {
    e.stopPropagation();
    st().pushHistory();
    const c = clientOf(boxPx.x + boxPx.w / 2, boxPx.y + boxPx.h / 2);
    const angleAt = (x: number, y: number) =>
      (Math.atan2(y - c.y, x - c.x) * 180) / Math.PI + 90;
    const grabX = e.clientX;
    const grabY = e.clientY;
    const from = angleAt(grabX, grabY);
    setTurning(rotation);
    startDrag(e, {
      onMove: (dx, dy) => {
        const raw = rotation + (angleAt(grabX + dx, grabY + dy) - from);
        const wrapped = ((((raw + 180) % 360) + 360) % 360) - 180;
        // Square angles pull the turn straight, the way the box edges snap to
        // the frame.
        const snapped = [-180, -90, 0, 90, 180].find((t) => Math.abs(wrapped - t) < 4);
        const deg = Math.round(snapped ?? wrapped);
        setTurning(deg);
        patch({ rotation: deg === 0 ? undefined : deg });
      },
      onUp: () => setTurning(null),
    });
  };

  // The picture's own grips, live only while something overflows: dragging a
  // corner out zooms further in, dragging it back settles at the box.
  const onZoom = (e: React.PointerEvent) => {
    e.stopPropagation();
    st().pushHistory();
    const c = clientOf(pic.x + pic.w / 2, pic.y + pic.h / 2);
    const reach = (x: number, y: number) => Math.hypot(x - c.x, y - c.y);
    const grabX = e.clientX;
    const grabY = e.clientY;
    const from = Math.max(8, reach(grabX, grabY));
    startDrag(e, {
      onMove: (dx, dy) => {
        const k = reach(grabX + dx, grabY + dy) / from;
        const next = Math.max(1, Math.min(CLIP_MAX_ZOOM, zoom * k));
        patch({ zoom: next > 1.001 ? next : undefined });
      },
    });
  };

  const onPanPicture = (e: React.PointerEvent) => {
    const panX0 = clip.panX ?? 0;
    const panY0 = clip.panY ?? 0;
    // Content follows the pointer; pan is the crop window's position.
    surfaceDrag(e, (rawX, rawY) => {
      const { dx, dy } = unturn(rawX, rawY);
      patch({
        panX: ox > 1 ? Math.max(-1, Math.min(1, panX0 - dx / (ox / 2))) : 0,
        panY: oy > 1 ? Math.max(-1, Math.min(1, panY0 - dy / (oy / 2))) : 0,
      });
    });
  };

  // Everything draws in the pane's own space, so an oversized picture's outline
  // keeps going into the empty room around the frame instead of stopping at its
  // edge; the layer clips it at the pane so it never reaches another panel.
  const at = (rect: { x: number; y: number; w: number; h: number }) => ({
    left: stage.padX + rect.x,
    top: stage.padY + rect.y,
    width: rect.w,
    height: rect.h,
  });
  const box = at(boxPx);
  const picBox = at(pic);
  const turn = {
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    transformOrigin: `${box.left + box.width / 2}px ${box.top + box.height / 2}px`,
  };
  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute overflow-hidden"
      style={{
        left: -stage.padX,
        top: -stage.padY,
        width: stage.w + 2 * stage.padX,
        height: stage.h + 2 * stage.padY,
      }}
    >
      <div className="absolute inset-0" style={turn}>
        {/* The picture as the source really lands it: grey where the frame
            throws it away, so a crop is something you can see and grab. */}
        {showPicture && (
          <div
            className="absolute rounded-[3px] border border-dashed border-white/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
            style={picBox}
          >
            {overflows && (
              <TransformHandles
                color="#c7c7cc"
                handles={CORNER_HANDLES}
                rotation={rotation}
                onResize={(_h, e) => onZoom(e)}
                resizeTitle="Drag to zoom the picture"
              />
            )}
          </div>
        )}
        {/* The dashed box draws the full extent; the frame-clipped solid ring
            paints over it, so dashes show only where the box leaves the frame. */}
        <div
          className="pointer-events-auto absolute cursor-move rounded-[3px] border-2 border-dashed border-[#0a84ff]"
          style={box}
          onPointerDown={onMoveBox}
        >
          {/* An overflowing picture pans from the interior; the ring at the
              border moves the box, the grips resize it. */}
          {overflows && (
            <div
              className="absolute inset-2 cursor-grab active:cursor-grabbing"
              onPointerDown={onPanPicture}
            />
          )}
          <TransformHandles
            color="#0a84ff"
            className="z-20"
            rotation={rotation}
            angle={turning}
            onResize={onResize}
            onRotate={onRotate}
          />
        </div>
      </div>
      {/* The solid ring and the snap guides live outside the turn: the ring's
          frame clipping is the frame's own edges, and a guide is a frame line.
          A turned box keeps just its dashed outline. */}
      <div
        className="pointer-events-none absolute overflow-hidden"
        style={{
          left: stage.padX,
          top: stage.padY,
          width: stage.w,
          height: stage.h,
          borderRadius: stageRadius(stage.w, stage.h),
        }}
      >
        {!rotation && (
          <div
            className="absolute rounded-[3px] shadow-[inset_0_0_0_2px_#0a84ff]"
            style={{ ...box, left: box.left - stage.padX, top: box.top - stage.padY }}
          />
        )}
        {guides.x !== null && (
          <div className="absolute inset-y-0 w-px bg-[#0a84ff]" style={{ left: guides.x * stage.w }} />
        )}
        {guides.y !== null && (
          <div className="absolute inset-x-0 h-px bg-[#0a84ff]" style={{ top: guides.y * stage.h }} />
        )}
      </div>
    </div>
  );
}

/**
 * The selected video clip's mask on the stage: the shared gizmo mounted at
 * the mask's anchor — the clip rect's center, carried through the clip's
 * pose so the outline sits where the compositor draws. Shows while the clip
 * is live under the playhead; the anchor point is a zero-size box, so the
 * gizmo's center-relative coordinates measure from it directly.
 */
function ClipMaskGizmo({ stage }: { stage: { w: number; h: number } }) {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const skimTime = useSkim();
  // A keyframed mask travels with the clock, so this one does follow every
  // frame — but only while a masked clip is the selection.
  const masked =
    selection?.kind === "clip" ? clips.find((c) => c.id === selection.id) ?? null : null;
  const armed = !!masked?.mask && masked.mask.kind !== "subject" && !masked.hidden;
  const tLocal = usePreviewSelector((t) => (armed && masked ? t - masked.start : -1));
  if (skimTime !== null) return null;
  const clip = masked;
  if (!armed || !clip?.mask) return null;
  const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
  const len = Math.max(0.1, (clip.out - clip.in) / speed);
  if (tLocal < 0 || tLocal >= len) return null;
  const rect = rectOf(clip);
  const pose = clipKeyed(clip) ? clipPoseAt(clip, tLocal) : null;
  const ax = pose ? pose.x : rect.x + rect.w / 2;
  const ay = pose ? pose.y : rect.y + rect.h / 2;
  const writeGeom = (patch: Partial<Omit<MaskKey, "t">>) => {
    const st = useEditor.getState();
    const cur = st.clips.find((c) => c.id === clip.id)?.mask;
    if (!cur) return;
    if (hasMaskKeys(cur)) return st.setClipMaskKey(clip.id, tLocal, patch, { transient: true });
    st.updateClipTransient(clip.id, { mask: { ...cur, ...patch } });
  };
  return (
    <div
      className="absolute"
      style={{
        left: ax * stage.w,
        top: ay * stage.h,
        width: 0,
        height: 0,
        transform: pose ? `rotate(${pose.rotation}deg) scale(${pose.scale})` : undefined,
      }}
    >
      <MaskGizmoCore
        mask={clip.mask}
        stageWidth={stage.w}
        stageHeight={stage.h}
        tLocal={tLocal}
        rotation={pose?.rotation ?? 0}
        poseScale={pose?.scale ?? 1}
        writeGeom={writeGeom}
        begin={() => useEditor.getState().pushHistory()}
      />
    </div>
  );
}
