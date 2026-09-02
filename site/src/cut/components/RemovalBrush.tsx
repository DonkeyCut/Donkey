"use client";

import { retimeOf } from "@donkeycut/effects-kit";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBrushUi } from "@/cut/lib/removal/brushUi";
import { BrushSession } from "@/cut/lib/removal/brushSession";
import { usePreviewSelector } from "@/cut/lib/playhead";
import { decodeRasterImageUrl } from "@/cut/lib/raster";
import { useEditor } from "@/cut/lib/store";
import {
  clipCovers,
  clipKeyed,
  clipPoseAt,
  clipZoom,
  contentRect,
  rectOf,
  type MediaAsset,
  type RemovalSeeds,
  type VideoClip,
} from "@/cut/lib/types";

/**
 * The custom-removal brush on the stage: a pointer surface laid over the
 * selected clip's picture while its brush session is open. Strokes paint the
 * mask directly. The selection shows as a red overlay, a loupe magnifies the
 * pixels being worked, and every finished stroke lands in the doc as a seed
 * record — the paint the hosted tracker replays across the whole clip. A
 * size ring rides the pointer over
 * the picture, and over the panel's Size row so the slider shows the
 * diameter it is setting.
 */

const LOUPE_PX = 128;
const LOUPE_ZOOM = 3;
/** Pointer samples closer than this (frame fractions) fold into one point. */
const MIN_STEP = 0.008;

type Frac = { x: number; y: number };

const decodeSeed = async (url: string) => {
  const img = await decodeRasterImageUrl(url).catch(() => null);
  return img ? img.source : null;
};

export function RemovalBrush({ stage }: { stage: { w: number; h: number } }) {
  const brushClipId = useBrushUi((s) => s.clipId);
  const selection = useEditor((s) => s.selection);
  const clips = useEditor((s) => s.clips);
  const assets = useEditor((s) => s.assets);
  const clip =
    brushClipId && selection?.kind === "clip" && selection.id === brushClipId
      ? clips.find((c) => c.id === brushClipId) ?? null
      : null;
  const armed = !!clip && clip.removal?.mode === "custom" && !clip.hidden;
  // Preview time follows the skimmer, so the surface stays up while the
  // pointer rides the timeline and the overlay tracks the frame on screen.
  const tLocal = usePreviewSelector((t) => (armed && clip ? t - clip.start : -1));
  if (!armed || !clip) return null;
  const len = Math.max(0.1, retimeOf(clip).len);
  if (tLocal < 0 || tLocal >= len) return null;
  const asset = assets.find((a) => a.id === clip.assetId);
  if (!asset?.width || !asset?.height) return null;
  return <BrushSurface clip={clip} asset={asset} stage={stage} tLocal={tLocal} />;
}

function BrushSurface({
  clip,
  asset,
  stage,
  tLocal,
}: {
  clip: VideoClip;
  asset: MediaAsset;
  stage: { w: number; h: number };
  tLocal: number;
}) {
  const tool = useBrushUi((s) => s.tool);
  const size = useBrushUi((s) => s.size);
  const sessionRef = useRef<BrushSession | null>(null);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const loupeRef = useRef<HTMLCanvasElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const ringGeom = useRef({ w: 0, h: 0, px: 0 });
  const [loupeRight, setLoupeRight] = useState(false);
  const [painting, setPainting] = useState(false);

  /** Hover tracking rides refs and direct style writes — a pointer move must
   * never re-render the stage. The loupe's side flip is the one piece of
   * state, and React bails when the boolean holds. */
  const updatePointer = (p: Frac | null) => {
    const ring = ringRef.current;
    if (ring) {
      const g = ringGeom.current;
      ring.style.display = p ? "block" : "none";
      if (p) {
        ring.style.left = `${p.x * g.w - g.px / 2}px`;
        ring.style.top = `${p.y * g.h - g.px / 2}px`;
      }
    }
    setLoupeRight(!!p && p.x < 0.4 && p.y < 0.4);
  };
  /** The seeds object this surface last wrote, so the replay effect only
   * rebuilds the mask for outside writes — undo, redo, the panel's Reset. */
  const lastWritten = useRef<RemovalSeeds | undefined | null>(null);
  const gesture = useRef<{ points: Frac[]; erase: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    void BrushSession.open().then((s) => {
      if (!alive) return;
      sessionRef.current = s;
      setSessionEpoch((e) => e + 1);
    });
    return () => {
      alive = false;
      sessionRef.current = null;
      gesture.current = null;
    };
  }, [clip.id]);

  const paintOverlay = () => {
    const s = sessionRef.current;
    const c = overlayRef.current;
    if (!s || !c) return;
    if (c.width !== s.width || c.height !== s.height) {
      c.width = s.width;
      c.height = s.height;
    }
    const ctx = c.getContext("2d");
    if (ctx) s.paintOverlay(ctx, c.width, c.height);
  };

  const srcT = () => retimeOf(clip).srcAt(Math.max(0, tLocal));

  // The overlay shows the strokes recorded on the frame the preview shows:
  // the mask rebuilds when the seeds change from outside (undo, redo, the
  // panel's Reset) and when the displayed frame moves onto or off a stroke
  // frame — parking on a painted frame brings its strokes back, any other
  // frame clears them. Playback keeps the overlay down; replay decodes the
  // stored paint, which has no place inside a frame tick.
  const seeds = clip.removal?.seeds;
  const playing = useEditor((s) => s.playing);
  const srcNow = retimeOf(clip).srcAt(Math.max(0, tLocal));
  const activeT = playing
    ? null
    : ((seeds?.paint ?? []).find((p) => Math.abs(p.t - srcNow) < 0.05)?.t ?? null);
  const lastActiveT = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || gesture.current) return;
    if (lastWritten.current === seeds && lastActiveT.current === activeT) return;
    if (!s.refreshFrame(clip.id)) return;
    lastWritten.current = seeds;
    lastActiveT.current = activeT;
    void s.replaySeeds(seeds, decodeSeed, srcNow).then(paintOverlay);
    // srcNow reads the frame the rebuild runs against; within one stroke
    // bucket a playhead move alone must not re-replay, and the activeT dep
    // holds that line.
  }, [seeds, activeT, sessionEpoch, clip.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const paintLoupe = (p: Frac) => {
    const s = sessionRef.current;
    const c = loupeRef.current;
    if (!s || !c) return;
    const side = LOUPE_PX / LOUPE_ZOOM;
    const sx = p.x * s.width - side / 2;
    const sy = p.y * s.height - side / 2;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, LOUPE_PX, LOUPE_PX);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(s.frame(), sx, sy, side, side, 0, 0, LOUPE_PX, LOUPE_PX);
    const ov = overlayRef.current;
    if (ov && ov.width > 2) ctx.drawImage(ov, sx, sy, side, side, 0, 0, LOUPE_PX, LOUPE_PX);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(
      LOUPE_PX / 2,
      LOUPE_PX / 2,
      (size / 2) * Math.min(s.width, s.height) * LOUPE_ZOOM,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  };

  /** Merge one stroke into the clip's stored seeds under one undo step. */
  const writeSeeds = (mutate: (next: RemovalSeeds) => void) => {
    const st = useEditor.getState();
    const cur = st.clips.find((c) => c.id === clip.id)?.removal;
    if (!cur || cur.mode !== "custom") return;
    const next: RemovalSeeds = {
      prompts: [...(cur.seeds?.prompts ?? [])],
      ...(cur.seeds?.paint ? { paint: [...cur.seeds.paint] } : {}),
    };
    mutate(next);
    st.pushHistory();
    lastWritten.current = next;
    // A new stroke reopens the selection: the bake waits for the next Apply.
    st.updateClipTransient(clip.id, { removal: { ...cur, seeds: next, requested: undefined } });
  };

  const finishStroke = (g: NonNullable<typeof gesture.current>) => {
    const s = sessionRef.current;
    if (!s) return;
    const t = srcT();
    paintOverlay();
    // An erase that leaves the frame blank drops the frame's stored records
    // whole — the timeline's stroke tabs leave with the paint, and no erase
    // bitmap piles up over strokes that no longer exist.
    if (g.erase && !s.hasSelection()) {
      const cur = useEditor.getState().clips.find((c) => c.id === clip.id)?.removal;
      const at = (ts: number) => Math.abs(ts - t) < 0.02;
      const had =
        !!cur?.seeds &&
        (cur.seeds.prompts.some((p) => at(p.t)) || (cur.seeds.paint ?? []).some((p) => at(p.t)));
      if (had) {
        writeSeeds((next) => {
          next.prompts = next.prompts.filter((p) => !at(p.t));
          const paint = (next.paint ?? []).filter((p) => !at(p.t));
          if (paint.length) next.paint = paint;
          else delete next.paint;
        });
      }
      return;
    }
    void s.paintSeed(g.points, size / 2).then((url) => {
      writeSeeds((next) => {
        const field = g.erase ? "erase" : "add";
        const at = (next.paint ?? []).findIndex((p) => Math.abs(p.t - t) < 0.02 && !p[field]);
        const paint = [...(next.paint ?? [])];
        if (at >= 0) paint[at] = { ...paint[at], [field]: url };
        else paint.push({ t, [field]: url });
        next.paint = paint;
      });
    });
  };

  // Pointer → picture fraction, measured from the anchor's client position.
  // A 0×0 element's rect stays pinned under its own rotate/scale, so the
  // anchor reads true through the stage's zoom pan, where offsetX drifts.
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const localPoint = (e: React.PointerEvent<HTMLDivElement>): Frac => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return { x: 0, y: 0 };
    let vx = e.clientX - a.left;
    let vy = e.clientY - a.top;
    if (rot) {
      const rad = (-rot * Math.PI) / 180;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      const rx = vx * c - vy * s;
      const ry = vx * s + vy * c;
      vx = rx;
      vy = ry;
    }
    if (scl !== 1) {
      vx /= scl;
      vy /= scl;
    }
    return {
      x: Math.min(1, Math.max(0, (vx - (pic.x - ax)) / Math.max(1, pic.w))),
      y: Math.min(1, Math.max(0, (vy - (pic.y - ay)) / Math.max(1, pic.h))),
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = sessionRef.current;
    if (!s) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    s.refreshFrame(clip.id);
    const p = localPoint(e);
    const erase = tool === "erase";
    gesture.current = { points: [p], erase };
    s.paintStroke([p], size / 2, erase);
    paintOverlay();
    updatePointer(p);
    setPainting(true);
    paintLoupe(p);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = localPoint(e);
    updatePointer(p);
    const g = gesture.current;
    const s = sessionRef.current;
    if (!g || !s) return;
    const last = g.points[g.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP) return;
    g.points.push(p);
    s.paintStroke([last, p], size / 2, g.erase);
    paintOverlay();
    paintLoupe(p);
  };

  const endGesture = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    setPainting(false);
    if (!g) return;
    if (commit) finishStroke(g);
  };

  // The same geometry the compositor draws: the picture's rect inside the
  // clip's box in stage pixels, hung on the pose anchor so a keyed clip's
  // surface travels with its picture.
  const r = rectOf(clip);
  const boxPx = { x: r.x * stage.w, y: r.y * stage.h, w: r.w * stage.w, h: r.h * stage.h };
  const pic = contentRect(
    boxPx,
    asset.width!,
    asset.height!,
    clipCovers(clip),
    clipZoom(clip),
    clip.panX ?? 0,
    clip.panY ?? 0
  );
  const pose = clipKeyed(clip) ? clipPoseAt(clip, tLocal) : null;
  const ax = (pose ? pose.x : r.x + r.w / 2) * stage.w;
  const ay = (pose ? pose.y : r.y + r.h / 2) * stage.h;
  const rot = pose ? pose.rotation : clip.rotation ?? 0;
  const scl = pose ? pose.scale : 1;
  const brushPx = size * Math.min(pic.w, pic.h);
  // The cursor ring is positioned by direct style writes on pointer moves;
  // this keeps the geometry those writes use in step with the layout.
  useEffect(() => {
    ringGeom.current = { w: pic.w, h: pic.h, px: brushPx };
  });
  // Over the panel's Size row the ring follows the pointer too — positioned
  // in viewport pixels from a window listener — so the slider shows the
  // diameter it is setting; everywhere else off the picture it hides.
  const freeRingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = freeRingRef.current;
      if (!el) return;
      const onSize = e.target instanceof Element && !!e.target.closest(".clip-brush-size-row");
      el.style.display = onSize ? "block" : "none";
      if (onSize) {
        el.style.left = `${e.clientX - brushPx / 2}px`;
        el.style.top = `${e.clientY - brushPx / 2}px`;
      }
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [brushPx]);

  return (
    <>
      <div
        ref={anchorRef}
        className="pointer-events-none absolute"
        style={{
          left: ax,
          top: ay,
          width: 0,
          height: 0,
          transform: rot || scl !== 1 ? `rotate(${rot}deg) scale(${scl})` : undefined,
        }}
      >
        <div
          className="clip-removal-brush pointer-events-auto absolute cursor-crosshair touch-none"
          style={{
            left: pic.x - ax,
            top: pic.y - ay,
            width: pic.w,
            height: pic.h,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => endGesture(true)}
          onPointerCancel={() => endGesture(false)}
          onPointerLeave={() => {
            if (!gesture.current) updatePointer(null);
          }}
        >
          <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 size-full" />
          <div
            ref={ringRef}
            className="pointer-events-none absolute rounded-full border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
            style={{ display: "none", width: brushPx, height: brushPx }}
          />
        </div>
      </div>
      {createPortal(
        <div
          ref={freeRingRef}
          className="pointer-events-none fixed z-50 rounded-full border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
          style={{ display: "none", width: brushPx, height: brushPx }}
        />,
        document.body
      )}
      {painting && (
        <canvas
          ref={loupeRef}
          width={LOUPE_PX}
          height={LOUPE_PX}
          className="clip-removal-loupe pointer-events-none absolute top-2 z-20 rounded-lg border border-white/40 shadow-lg"
          style={loupeRight ? { right: 8 } : { left: 8 }}
        />
      )}
    </>
  );
}
