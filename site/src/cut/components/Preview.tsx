"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { setPreviewCanvas } from "@/cut/lib/previewCanvas";
import { CLIP_MAX_ZOOM, clipCovers, clipKeyed, clipPoseAt, clipZoom, contentRect, frameOf, isFullRect, rectOf, REGION_MAX_SCALE, type Aspect, type ClipSpan, type FrameRect, type MediaAsset, type VideoClip } from "@/cut/lib/types";
import { hasMaskKeys, type MaskKey } from "@donkeycut/effects-kit";
import { cn } from "@/lib/utils";
import { MaskGizmoCore, OverlayLayer } from "./OverlayLayer";
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

/** Play or pause, rewinding first when the playhead is parked at the end. */
function togglePlayback() {
  const s = useEditor.getState();
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

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // The picture's box plus the empty room around it in the pane, which is where
  // the outline of an oversized picture gets to show.
  const [stage, setStage] = useState({ w: 270, h: 480, padX: 0, padY: 0 });
  const aspect = useEditor((s) => s.aspect);
  const frame = frameOf(aspect);

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
  const surface = useMemo(() => {
    const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.min(frame.w, Math.round(stage.w * dpr)));
    return { w, h: Math.max(2, Math.round((w * frame.h) / frame.w)) };
  }, [stage.w, frame.w, frame.h]);

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
      const w = Math.floor(scale * rw);
      const h = Math.floor(scale * rh);
      setStage({
        w,
        h,
        padX: Math.max(0, Math.floor((r.width - w) / 2)),
        padY: Math.max(0, Math.floor((r.height - h) / 2)),
      });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [aspect]);

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
    // a stationary press is a play/pause and leaves the selection alone.
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
      // pannable clip toggles playback here instead.
      onUp: (_dx, _dy, moved) => {
        if (!moved) togglePlayback();
      },
    });
    return true;
  };

  // The topmost regioned clip under a stage point at the playhead — clicking
  // its picture selects it, in the preview and the timeline alike. Full-frame
  // clips stay out: a click on the backdrop keeps playing and pausing.
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
    <section className="preview-pane flex min-h-0 min-w-0 flex-col bg-muted/40 select-none">
      <div
        ref={wrapRef}
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-3"
        // The empty room around the picture is the only part of the preview that
        // clears the selection; the picture itself just plays and pauses.
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) useEditor.getState().select(null);
        }}
      >
        {/* The selection handle mounts beside the stage, outside its clipping,
            so a box dragged past the frame edge stays visible and grabbable. */}
        <div className="relative" style={{ width: stage.w, height: stage.h }}>
        <div
          ref={stageRef}
          className={cn(
            "stage absolute inset-0 overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_36px_rgba(0,0,0,0.18)]"
          )}
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
              togglePlayback();
            }
          }}
        >
          <StagePictureFx>
          <canvas
            ref={canvasRef}
            width={surface.w}
            height={surface.h}
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
          <ClipMaskGizmo stage={stage} />
          {slices.map((slice) =>
            slice.kind === "elements" ? (
              <OverlayLayer
                key={slice.key}
                stageWidth={stage.w}
                gradeAbove={slice.gradeAbove}
                from={slice.from}
                to={slice.to}
                captions={slice.captions}
              />
            ) : (
              <StageEffectPaint key={slice.key} lane={slice.lane} />
            )
          )}
        </div>
        <ClipTransformGizmo stage={stage} />
        </div>
      </div>
    </section>
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

/** The frame line nearest a resized trailing edge, within tolerance. */
function snapEdge(v: number, tol: number): number | null {
  let best: number | null = null;
  let bd = tol;
  for (const target of [0.5, 1]) {
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
   * interior. The history checkpoint waits for real travel, and a press that
   * never travels is a click on the picture, which plays and pauses.
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
        if (!moved) togglePlayback();
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
          const k = Math.max(
            0.05 / Math.min(r.w, r.h),
            Math.min(REGION_MAX_SCALE / Math.max(r.w, r.h), grow)
          );
          const w = r.w * k;
          const h = r.h * k;
          setGuides({ x: null, y: null });
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
        className="pointer-events-none absolute overflow-hidden rounded-xl"
        style={{ left: stage.padX, top: stage.padY, width: stage.w, height: stage.h }}
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
