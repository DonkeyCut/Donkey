"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { usePlayback } from "@/cut/hooks/usePlayback";
import { clearAssetDrag, setAssetDragData } from "@/cut/lib/assetDrag";
import { startDrag } from "@/cut/lib/drag";
import { getClipSpans, useEditor } from "@/cut/lib/store";
import {
  capturePoster,
  capturePosterWhenReady,
  paintPoster,
  readPoster,
} from "@/cut/lib/posterCache";
import { setPreviewCanvas } from "@/cut/lib/previewCanvas";
import { frameOf, isFullRect, rectOf, type Aspect, type ClipSpan, type FrameRect, type MediaAsset, type VideoClip } from "@/cut/lib/types";
import { cn } from "@/lib/utils";
import { OverlayLayer } from "./OverlayLayer";

/** The clip under the playhead, when it overflows the frame in fill mode. */
function pannableSpan(s: {
  clips: VideoClip[];
  assets: MediaAsset[];
  currentTime: number;
  aspect: Aspect;
}): ClipSpan | null {
  const spans = getClipSpans(s.clips, s.assets);
  const span =
    spans.find((sp) => s.currentTime >= sp.start && sp.start + sp.len > s.currentTime) ??
    spans[spans.length - 1];
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
  const [stage, setStage] = useState({ w: 270, h: 480 });
  const pannable = useEditor((s) => pannableSpan(s) !== null);
  const aspect = useEditor((s) => s.aspect);
  const frame = frameOf(aspect);

  usePlayback(canvasRef);

  useEffect(() => {
    setPreviewCanvas(canvasRef.current);
    return () => setPreviewCanvas(null);
  }, []);

  useCachedFirstFrame(canvasRef);

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

  // Drag a fill-mode clip inside the frame to choose the visible crop.
  const panDrag = (e: React.PointerEvent) => {
    const s = useEditor.getState();
    const span = pannableSpan(s);
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
    s.select({ kind: "clip", id: clipId });
    s.pushHistory();
    startDrag(e, {
      onMove: (dx, dy) => {
        // Content follows the pointer; pan is the crop-window position.
        useEditor.getState().updateClipTransient(clipId, {
          panX: ox > 1 ? Math.max(-1, Math.min(1, panX0 - (dx * toFrame) / (ox / 2))) : 0,
          panY: oy > 1 ? Math.max(-1, Math.min(1, panY0 - (dy * toFrame) / (oy / 2))) : 0,
        });
      },
    });
    return true;
  };

  return (
    <section className="preview-pane flex min-h-0 min-w-0 flex-col bg-muted/40 select-none">
      <div ref={wrapRef} className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-3">
        <div
          className={cn(
            "stage relative overflow-hidden rounded-xl bg-black shadow-[0_0_0_1px_rgba(0,0,0,0.08),0_12px_36px_rgba(0,0,0,0.18)]",
            pannable && "cursor-grab active:cursor-grabbing"
          )}
          style={{ width: stage.w, height: stage.h }}
          onPointerDown={(e) => {
            if (
              e.target === e.currentTarget ||
              (e.target as HTMLElement).tagName === "CANVAS"
            ) {
              if (!panDrag(e)) useEditor.getState().select(null);
            }
          }}
        >
          <canvas
            ref={canvasRef}
            width={frame.w}
            height={frame.h}
            className="block size-full"
            // Drag the viewport to reference what's on screen: the clip under
            // the playhead travels as a media drag (timeline placement, chat
            // attachment, generation reference). Pan on a fill clip wins —
            // its pointerdown cancels the native drag.
            draggable
            onDragStart={(e) => {
              const s = useEditor.getState();
              const spans = getClipSpans(s.clips, s.assets);
              const t = s.currentTime;
              const span =
                spans.find((sp) => t >= sp.start && sp.start + sp.len > t) ??
                spans[spans.length - 1];
              if (!span) return e.preventDefault();
              setAssetDragData(e, span.asset.id);
            }}
            onDragEnd={clearAssetDrag}
          />
          <OverlayPipHandle stage={stage} />
          <OverlayLayer stageWidth={stage.w} />
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
function OverlayPipHandle({ stage }: { stage: { w: number; h: number } }) {
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const currentTime = useEditor((s) => s.currentTime);

  // Resolve the selected, live, regioned clip (any track) plus how to patch its
  // rect. A clip's own footprint equals its span length, so one path serves
  // every track.
  let rect: FrameRect | null = null;
  let apply: ((frame: FrameRect) => void) | null = null;
  if (selection?.kind === "clip") {
    const clip = clips.find((c) => c.id === selection.id);
    if (clip && !clip.hidden) {
      const speed = clip.speed && clip.speed > 0 ? clip.speed : 1;
      const len = Math.max(0.1, (clip.out - clip.in) / speed);
      if (currentTime >= clip.start && currentTime < clip.start + len) {
        rect = rectOf(clip);
        apply = (frame) => useEditor.getState().updateClipTransient(clip.id, { frame });
      }
    }
  }
  if (!rect || !apply || isFullRect(rect)) return null;
  const r = rect;
  const patch = apply;

  const onMove = (e: React.PointerEvent) => {
    e.stopPropagation();
    useEditor.getState().pushHistory();
    startDrag(e, {
      onMove: (dx, dy) =>
        patch({
          ...r,
          x: Math.max(0, Math.min(1 - r.w, r.x + dx / stage.w)),
          y: Math.max(0, Math.min(1 - r.h, r.y + dy / stage.h)),
        }),
    });
  };

  const onResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    useEditor.getState().pushHistory();
    startDrag(e, {
      onMove: (dx, dy) =>
        patch({
          ...r,
          w: Math.max(0.1, Math.min(1 - r.x, r.w + dx / stage.w)),
          h: Math.max(0.1, Math.min(1 - r.y, r.h + dy / stage.h)),
        }),
    });
  };

  return (
    <div
      className="absolute cursor-move rounded-[3px] shadow-[inset_0_0_0_2px_#a855f7]"
      style={{ left: r.x * stage.w, top: r.y * stage.h, width: r.w * stage.w, height: r.h * stage.h }}
      onPointerDown={onMove}
    >
      <span
        className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-full bg-violet-500 shadow-[0_0_0_2px_white]"
        onPointerDown={onResize}
      />
    </div>
  );
}
