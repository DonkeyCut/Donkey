"use client";

import { useRef, useState } from "react";
import { curveLut, type CurvePoint, type GradeCurves } from "@donkeycut/effects-kit";
import { cn } from "@/lib/utils";

/**
 * The tone-curve editor: one editable spline per channel (master, R, G, B),
 * drawn by sampling the same monotone spline the renderer bakes, so the line
 * on screen is the mapping the export applies. Drag a point to move it, click
 * the curve to add one, double-click a middle point to remove it. Drags
 * stream through onDraft and settle with onCommit, matching the sliders'
 * checkpoint discipline.
 */

type Channel = "m" | "r" | "g" | "b";

const CHANNELS: { id: Channel; label: string; color: string }[] = [
  { id: "m", label: "Master", color: "var(--foreground)" },
  { id: "r", label: "Red", color: "#ff453a" },
  { id: "g", label: "Green", color: "#32d74b" },
  { id: "b", label: "Blue", color: "#0a84ff" },
];

const IDENTITY: CurvePoint[] = [
  [0, 0],
  [255, 255],
];

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function CurveEditor({
  curves,
  onDraft,
  onCommit,
}: {
  curves: GradeCurves | undefined;
  onDraft: (curves: GradeCurves) => void;
  onCommit: (curves: GradeCurves) => void;
}) {
  const [channel, setChannel] = useState<Channel>("m");
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ index: number; points: CurvePoint[] } | null>(null);
  const points = curves?.[channel] ?? IDENTITY;
  const color = CHANNELS.find((c) => c.id === channel)!.color;

  const withChannel = (pts: CurvePoint[] | undefined): GradeCurves => {
    const next: GradeCurves = { ...curves };
    if (pts) next[channel] = pts;
    else delete next[channel];
    return next;
  };

  /** Pointer position in curve coordinates: x 0..255, y 0..255 bottom-up. */
  const curvePos = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [
      clampByte(((e.clientX - r.left) / r.width) * 255),
      clampByte((1 - (e.clientY - r.top) / r.height) * 255),
    ];
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!svgRef.current) return;
    const [x, y] = curvePos(e);
    const pts = points.map((p) => [...p] as CurvePoint);
    // Grab the nearest existing point when it is within reach; otherwise add
    // a point at the pointer.
    let index = -1;
    let best = Infinity;
    pts.forEach((p, i) => {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < best) {
        best = d;
        index = i;
      }
    });
    if (best > 18) {
      const insert: CurvePoint = [x, y];
      index = pts.findIndex((p) => p[0] > x);
      if (index < 0) index = pts.length;
      pts.splice(index, 0, insert);
    }
    drag.current = { index, points: pts };
    svgRef.current.setPointerCapture(e.pointerId);
    onDraft(withChannel(pts));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = curvePos(e);
    const pts = d.points;
    const p = pts[d.index];
    p[1] = y;
    // Endpoints hold their input; middle points slide between neighbors.
    if (d.index > 0 && d.index < pts.length - 1) {
      p[0] = Math.max(pts[d.index - 1][0] + 1, Math.min(pts[d.index + 1][0] - 1, x));
    }
    onDraft(withChannel(pts.map((q) => [...q] as CurvePoint)));
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d) onCommit(withChannel(d.points));
  };

  const removePoint = (i: number) => {
    if (i <= 0 || i >= points.length - 1) return;
    const pts = points.filter((_, k) => k !== i);
    onCommit(withChannel(pts));
  };

  // The drawn line samples the renderer's own spline.
  const lut = curveLut(points);
  let path = "";
  for (let x = 0; x <= 255; x += 4) {
    const y = 255 - lut[x] * 255;
    path += `${path ? " L" : "M"} ${x} ${y.toFixed(1)}`;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={cn(
              "flex-1 rounded-md px-1 py-0.5 text-[11.5px] font-medium transition-colors",
              channel === c.id
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground",
              !!curves?.[c.id] && channel !== c.id && "text-foreground"
            )}
            onClick={() => setChannel(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <svg
        ref={svgRef}
        viewBox="0 0 256 256"
        className="clip-grade-curves aspect-square w-full cursor-crosshair touch-none rounded-md bg-secondary/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {[64, 128, 192].map((g) => (
          <g key={g} className="stroke-border">
            <line x1={g} y1={0} x2={g} y2={256} strokeWidth={1} />
            <line x1={0} y1={g} x2={256} y2={g} strokeWidth={1} />
          </g>
        ))}
        <line
          x1={0}
          y1={256}
          x2={256}
          y2={0}
          strokeWidth={1}
          strokeDasharray="4 4"
          className="stroke-muted-foreground/40"
        />
        <path d={path} fill="none" stroke={color} strokeWidth={2.5} />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p[0]}
            cy={255 - p[1]}
            r={7}
            fill="var(--card)"
            stroke={color}
            strokeWidth={2}
            onDoubleClick={() => removePoint(i)}
          />
        ))}
      </svg>
    </div>
  );
}
