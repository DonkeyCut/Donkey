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
import { clipKeyed, clipPoseAt, frameOf, isFullRect, rectOf, REGION_MAX_SCALE, type Aspect, type ClipSpan, type FrameRect, type MediaAsset, type VideoClip } from "@/cut/lib/types";
import { hasMaskKeys, type MaskKey } from "@donkeycut/effects-kit";
import { cn } from "@/lib/utils";
import { Grip, MaskGizmoCore, OverlayLayer } from "./OverlayLayer";
import {
  StageEffectPaint,
  StagePictureFx,
  stageSliceStructure,
  useEffectLanes,
} from "./StageEffects";

/** The clip under the playhead, when it overflows the frame in fill mode. */
function pannableSpan(
  s: { clips: VideoClip[]; assets: MediaAsset[]; aspect: Aspect },
  t: number
): ClipSpan | null {
  const spans = getClipSpans(s.clips, s.assets);
  const span = spans.find((sp) => t >= sp.start && sp.start + sp.len > t) ?? spans[spans.length - 1];
  // Pan only makes sense for a full-frame fill clip; a regioned clip is moved
  // with its own preview handle instead.
  if (!span || span.clip.fit !== "fill" || !isFullRect(rectOf(span.clip))) return null;
  const { width, height } = span.asset;
  if (!width || !height) return null;
  const frame = frameOf(s.aspect);
  const scale = Math.max(frame.w / width, frame.h / height);
  const ox = width * scale - frame.w;
  const oy = height * scale - frame.h;
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
  const [stage, setStage] = useState({ w: 270, h: 480 });
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
      setStage({ w: Math.floor(scale * rw), h: Math.floor(scale * rh) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [aspect]);

  const togglePlayback = () => {
    const s = useEditor.getState();
    const total = projectDuration(s);
    if (!total) return;
    if (!s.playing && playheadAt() >= total - 0.01) s.seek(0);
    s.setPlaying(!s.playing);
  };

  // Drag a fill-mode clip inside the frame to choose the visible crop.
  const panDrag = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const span = pannableSpan(s, previewAt());
    if (!span) return false;
    const fr = frameOf(s.aspect);
    const { width = 1, height = 1 } = span.asset;
    const scale = Math.max(fr.w / width, fr.h / height);
    const ox = width * scale - fr.w;
    const oy = height * scale - fr.h;
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
        <OverlayPipHandle stage={stage} />
        </div>
      </div>
    </section>
  );
}

/**
 * Direct-manipulation handle for the selected video layer's frame region: drag
 * the box to reposition, drag the corner to resize (both update the clip's
 * `frame` rect). Works for a regioned track-0 clip (split-screen half) or an
 * overlay clip, and only while that clip is live under the playhead so it lines
 * up with the compositor. A full-frame layer needs no handle.
 */
/** How close (screen px) a box edge pulls onto a snap line while dragging. */
const SNAP_PX = 8;

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

function OverlayPipHandle({ stage }: { stage: { w: number; h: number } }) {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const aspect = useEditor((s) => s.aspect);
  const skimTime = useSkim();
  // The handle only cares whether its clip is on screen, so it subscribes to
  // that answer instead of to the clock: one render when the clip comes and
  // goes, rather than one per frame while it stays.
  const selectedClip = selection?.kind === "clip" ? clips.find((c) => c.id === selection.id) : null;
  const live = usePreviewSelector((t) => {
    if (!selectedClip) return false;
    const speed = selectedClip.speed && selectedClip.speed > 0 ? selectedClip.speed : 1;
    const len = Math.max(0.1, (selectedClip.out - selectedClip.in) / speed);
    return t >= selectedClip.start && t < selectedClip.start + len;
  });
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  // While hover-scrubbing the preview shows the skimmer's frame, where the
  // selected clip may not even be on screen — selection stays, the handle hides.
  if (skimTime !== null) return null;

  // Resolve the selected, live, regioned clip (any track) plus how to patch its
  // rect. A clip's own footprint equals its span length, so one path serves
  // every track.
  let rect: FrameRect | null = null;
  let apply: ((frame: FrameRect) => void) | null = null;
  // A fill clip whose content overflows the box can pan its crop window: how
  // far the scaled picture overhangs the box (frame px), and the pan to start
  // the gesture from.
  let pan: { id: string; ox: number; oy: number; panX0: number; panY0: number } | null = null;
  {
    const clip = selectedClip;
    if (clip && !clip.hidden) {
      if (live) {
        rect = rectOf(clip);
        apply = (frame) => useEditor.getState().updateClipTransient(clip.id, { frame });
        const asset = assets.find((a) => a.id === clip.assetId);
        if (clip.fit === "fill" && asset?.width && asset?.height) {
          const fr = frameOf(aspect);
          const bw = rect.w * fr.w;
          const bh = rect.h * fr.h;
          const sc = Math.max(bw / asset.width, bh / asset.height);
          const ox = asset.width * sc - bw;
          const oy = asset.height * sc - bh;
          if (ox > 1 || oy > 1) {
            pan = { id: clip.id, ox, oy, panX0: clip.panX ?? 0, panY0: clip.panY ?? 0 };
          }
        }
      }
    }
  }
  if (!rect || !apply || isFullRect(rect)) return null;
  const r = rect;
  const patch = apply;

  // The box may leave the frame — oversize it to focus on an area, or park it
  // partly off screen — as long as a sliver stays inside to grab.
  const onMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    useEditor.getState().pushHistory();
    startDrag(e, {
      onMove: (dx, dy) => {
        const sx = snapAxis(r.x + dx / stage.w, r.w, SNAP_PX / stage.w);
        const sy = snapAxis(r.y + dy / stage.h, r.h, SNAP_PX / stage.h);
        setGuides({ x: sx.guide, y: sy.guide });
        patch({
          ...r,
          x: Math.max(0.05 - r.w, Math.min(0.95, sx.v)),
          y: Math.max(0.05 - r.h, Math.min(0.95, sy.v)),
        });
      },
      onUp: () => setGuides({ x: null, y: null }),
    });
  };

  const onResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    useEditor.getState().pushHistory();
    startDrag(e, {
      onMove: (dx, dy) => {
        let w = Math.max(0.1, Math.min(REGION_MAX_SCALE, r.w + dx / stage.w));
        let h = Math.max(0.1, Math.min(REGION_MAX_SCALE, r.h + dy / stage.h));
        const gx = snapEdge(r.x + w, SNAP_PX / stage.w);
        const gy = snapEdge(r.y + h, SNAP_PX / stage.h);
        if (gx !== null && gx - r.x >= 0.1) w = gx - r.x;
        if (gy !== null && gy - r.y >= 0.1) h = gy - r.y;
        setGuides({ x: gx !== null && gx - r.x >= 0.1 ? gx : null, y: gy !== null && gy - r.y >= 0.1 ? gy : null });
        patch({ ...r, w, h });
      },
      onUp: () => setGuides({ x: null, y: null }),
    });
  };

  const panContent = pan;
  const onPanContent = (e: React.PointerEvent) => {
    if (!panContent) return;
    e.stopPropagation();
    useEditor.getState().pushHistory();
    const toFrame = frameOf(aspect).w / stage.w; // screen px → frame px
    startDrag(e, {
      onMove: (dx, dy) => {
        // Content follows the pointer; pan is the crop-window position.
        useEditor.getState().updateClipTransient(panContent.id, {
          panX:
            panContent.ox > 1
              ? Math.max(-1, Math.min(1, panContent.panX0 - (dx * toFrame) / (panContent.ox / 2)))
              : 0,
          panY:
            panContent.oy > 1
              ? Math.max(-1, Math.min(1, panContent.panY0 - (dy * toFrame) / (panContent.oy / 2)))
              : 0,
        });
      },
    });
  };

  const box = {
    left: r.x * stage.w,
    top: r.y * stage.h,
    width: r.w * stage.w,
    height: r.h * stage.h,
  };
  // The dashed box draws the full extent; the frame-clipped solid ring paints
  // over it, so dashes show only where the box leaves the frame.
  return (
    <>
      <div
        className="absolute cursor-move rounded-[3px] border-2 border-dashed border-[#0a84ff]"
        style={box}
        onPointerDown={onMove}
      >
        {/* Overflowing fill content pans from the interior; the ring at the
            border moves the box, the corner resizes it. */}
        {panContent && (
          <div
            className="absolute inset-2 cursor-grab active:cursor-grabbing"
            onPointerDown={onPanContent}
          />
        )}
        <Grip
          color="#0a84ff"
          className="absolute -right-2 -bottom-2 z-20 cursor-nwse-resize"
          onPointerDown={onResize}
        />
      </div>
      <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-xl">
        <div
          className="absolute rounded-[3px] shadow-[inset_0_0_0_2px_#0a84ff]"
          style={box}
        />
        {guides.x !== null && (
          <div className="absolute inset-y-0 w-px bg-[#0a84ff]" style={{ left: guides.x * stage.w }} />
        )}
        {guides.y !== null && (
          <div className="absolute inset-x-0 h-px bg-[#0a84ff]" style={{ top: guides.y * stage.h }} />
        )}
      </div>
    </>
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
