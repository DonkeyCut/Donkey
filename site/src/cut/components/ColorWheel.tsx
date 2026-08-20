"use client";

import { useRef } from "react";
import { GRADE_MAX } from "@donkeycut/effects-kit";

/**
 * One color wheel of the Wheels tool: a hue disc with a draggable puck whose
 * position is the wheel's chroma offset ([dx, dy], each -50..50). The disc's
 * hue layout matches the renderer's angle-to-hue mapping, so the puck sits on
 * the color it pushes toward. Double-click recenters.
 */
export function ColorWheel({
  label,
  value,
  onDraft,
  onCommit,
  className,
}: {
  label: string;
  /** [dx, dy] of the wheel's tuple; luminance rides its own slider row. */
  value: [number, number];
  onDraft: (v: [number, number]) => void;
  onCommit: (v: [number, number]) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = useRef<[number, number]>(value);

  const fromEvent = (e: React.PointerEvent): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    let dx = ((e.clientX - r.left) / r.width - 0.5) * 2 * GRADE_MAX;
    let dy = ((e.clientY - r.top) / r.height - 0.5) * 2 * GRADE_MAX;
    const m = Math.hypot(dx, dy);
    if (m > GRADE_MAX) {
      dx *= GRADE_MAX / m;
      dy *= GRADE_MAX / m;
    }
    return [Math.round(dx), Math.round(dy)];
  };

  return (
    <div className={className}>
      <p className="mb-1 text-center text-[11px] text-muted-foreground">{label}</p>
      <div
        ref={ref}
        role="slider"
        aria-label={`${label} color`}
        aria-valuemin={0}
        aria-valuemax={GRADE_MAX}
        aria-valuenow={Math.round(Math.hypot(value[0], value[1]))}
        aria-valuetext={`${value[0]}, ${value[1]}`}
        className="relative mx-auto aspect-square w-full max-w-[84px] cursor-pointer touch-none rounded-full"
        style={{
          background:
            // The angle-to-hue map the renderer uses: 0° (right) red, 90°
            // (down) spring green — a conic sweep from the +x axis.
            "conic-gradient(from 90deg, hsl(0 80% 60%), hsl(60 80% 60%), hsl(120 80% 60%), hsl(180 80% 60%), hsl(240 80% 60%), hsl(300 80% 60%), hsl(0 80% 60%))",
        }}
        onPointerDown={(e) => {
          dragging.current = true;
          ref.current?.setPointerCapture(e.pointerId);
          last.current = fromEvent(e);
          onDraft(last.current);
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          last.current = fromEvent(e);
          onDraft(last.current);
        }}
        onPointerUp={() => {
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(last.current);
        }}
        onPointerCancel={() => {
          // A cancelled drag still ends the gesture: commit where the puck was
          // left, or the checkpoint stays open and swallows the next drag's.
          if (!dragging.current) return;
          dragging.current = false;
          onCommit(last.current);
        }}
        onDoubleClick={() => onCommit([0, 0])}
      >
        {/* Saturation falls toward the center, like the offset it maps to. */}
        <div
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            background:
              "radial-gradient(circle, var(--card) 0%, color-mix(in srgb, var(--card) 55%, transparent) 55%, transparent 100%)",
          }}
        />
        <div
          className="pointer-events-none absolute size-3 rounded-full border-2 border-neutral-800 bg-white shadow-sm"
          style={{
            left: `calc(${50 + (value[0] / GRADE_MAX) * 44}% - 6px)`,
            top: `calc(${50 + (value[1] / GRADE_MAX) * 44}% - 6px)`,
          }}
        />
      </div>
    </div>
  );
}
