"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { startDrag } from "@/cut/lib/drag";
import { previewAt, usePreviewTime, useSkim } from "@/cut/lib/playhead";
import { clipLen, useEditor } from "@/cut/lib/store";
import {
  normDeg,
  pictureGroupSelected,
  previewSelectionSnapshot,
  rotatePreviewSelection,
  scalePreviewSelection,
} from "@/cut/lib/previewSelection";
import { clipKeyed, clipPoseAt, rectOf } from "@/cut/lib/types";
import { HANDLE_AXIS, TransformHandles, type ResizeHandle } from "@/cut/components/TransformHandles";

type Rect = { x: number; y: number; w: number; h: number };
const ROTATE_SNAP_DEG = 6;

/**
 * One frame around a multi-selection on the stage: the box every selected
 * item fits in, with the grips and the rotate button a single item wears.
 * A grip scales the set about the opposite edge, the button turns it about
 * its center, and every member keeps its place in the set. The ring itself
 * takes no press: a member moves the whole set from its own box, and the
 * room between members stays the stage's. Members draw only their thin
 * outline underneath. The frame rests while the cut plays or the skimmer is
 * out, when the picture is what matters.
 */
export function SelectionFrame({ stage }: { stage: { w: number; h: number } }) {
  const multi = useEditor((s) => s.multiSelection);
  const overlays = useEditor((s) => s.overlays);
  const clips = useEditor((s) => s.clips);
  const playing = useEditor((s) => s.playing);
  const readOnly = useEditor((s) => s.readOnly);
  const t = usePreviewTime();
  const skim = useSkim();
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [spin, setSpin] = useState<number | null>(null);
  const active = pictureGroupSelected(multi) && !playing && skim === null && !readOnly;

  // The box is read from what is on screen: each element's laid-out box,
  // and a clip's frame turned by its angle. One read per change, off the
  // frame loop.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!active || !root) {
      setRect(null);
      return;
    }
    const origin = root.getBoundingClientRect();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = (x: number, y: number) => {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    const scope = root.parentElement ?? root;
    for (const m of multi) {
      if (m?.kind === "overlay") {
        const el = scope.querySelector<HTMLElement>(`.overlay-item[data-preview-id="${CSS.escape(m.id)}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        add(r.left - origin.left, r.top - origin.top);
        add(r.right - origin.left, r.bottom - origin.top);
      } else if (m?.kind === "clip") {
        const clip = clips.find((c) => c.id === m.id);
        if (!clip || clip.hidden || t < clip.start || t >= clip.start + clipLen(clip)) continue;
        const resting = rectOf(clip);
        const pose = clipKeyed(clip) ? clipPoseAt(clip, Math.max(0, t - clip.start)) : null;
        const r = pose
          ? { x: pose.x - (resting.w * pose.scale) / 2, y: pose.y - (resting.h * pose.scale) / 2, w: resting.w * pose.scale, h: resting.h * pose.scale }
          : resting;
        const deg = pose?.rotation ?? clip.rotation ?? 0;
        const cx = (r.x + r.w / 2) * stage.w, cy = (r.y + r.h / 2) * stage.h;
        const hw = (r.w * stage.w) / 2, hh = (r.h * stage.h) / 2;
        const a = (deg * Math.PI) / 180;
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          add(cx + sx * hw * Math.cos(a) - sy * hh * Math.sin(a), cy + sx * hw * Math.sin(a) + sy * hh * Math.cos(a));
        }
      }
    }
    setRect(Number.isFinite(x0) && x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null);
  }, [active, multi, overlays, clips, t, stage.w, stage.h]);

  const st = () => useEditor.getState();

  // A grip scales about the opposite edge or corner: a corner pulls both axes
  // together along its diagonal, a side pulls its own axis alone.
  const onResize = (handle: ResizeHandle, e: React.PointerEvent) => {
    if (!rect) return;
    e.stopPropagation();
    st().pushHistory();
    const snapshot = previewSelectionSnapshot(st(), previewAt());
    const axis = HANDLE_AXIS[handle];
    const corner = axis.x !== 0 && axis.y !== 0;
    const at = (ax: -1 | 0 | 1, ay: -1 | 0 | 1) => ({
      x: rect.x + rect.w * (ax === 0 ? 0.5 : ax > 0 ? 1 : 0),
      y: rect.y + rect.h * (ay === 0 ? 0.5 : ay > 0 ? 1 : 0),
    });
    const grip = at(axis.x, axis.y);
    const anchor = at(-axis.x as -1 | 0 | 1, -axis.y as -1 | 0 | 1);
    const arm = { x: grip.x - anchor.x, y: grip.y - anchor.y };
    startDrag(e, {
      onMove: (dx, dy) => {
        const p = { x: grip.x + dx - anchor.x, y: grip.y + dy - anchor.y };
        let kx = 1, ky = 1;
        if (corner) kx = ky = (p.x * arm.x + p.y * arm.y) / (arm.x * arm.x + arm.y * arm.y);
        else if (axis.x !== 0) kx = p.x / arm.x;
        else ky = p.y / arm.y;
        scalePreviewSelection(st(), snapshot, { x: anchor.x / stage.w, y: anchor.y / stage.h }, kx, ky);
      },
    });
  };

  const onRotate = (e: React.PointerEvent) => {
    if (!rect) return;
    e.stopPropagation();
    st().pushHistory();
    const snapshot = previewSelectionSnapshot(st(), previewAt());
    const origin = ref.current!.getBoundingClientRect();
    const cx = origin.left + rect.x + rect.w / 2;
    const cy = origin.top + rect.y + rect.h / 2;
    const angleAt = (ev: { clientX: number; clientY: number }) => (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI;
    const start0 = angleAt(e);
    setSpin(0);
    startDrag(e, {
      onMove: (_dx, _dy, ev) => {
        let delta = normDeg(angleAt(ev) - start0);
        for (const q of [-180, -90, 0, 90, 180]) if (Math.abs(delta - q) < ROTATE_SNAP_DEG) delta = q;
        setSpin(Math.round(delta));
        rotatePreviewSelection(st(), snapshot, { x: (rect.x + rect.w / 2) / stage.w, y: (rect.y + rect.h / 2) / stage.h }, delta, stage.h / stage.w);
      },
      onUp: () => setSpin(null),
    });
  };

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      {rect && (
        <div
          className="pointer-events-none absolute rounded-[3px] border-[1.5px] border-dashed border-[#0a84ff]"
          style={{ left: rect.x - 4, top: rect.y - 4, width: rect.w + 8, height: rect.h + 8 }}
          data-preview-selection=""
        >
          <TransformHandles color="#0a84ff" angle={spin} onResize={onResize} onRotate={onRotate} />
        </div>
      )}
    </div>
  );
}
