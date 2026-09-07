"use client";

import type React from "react";
import { startDrag } from "@/cut/lib/drag";
import { useEditor } from "@/cut/lib/store";
import { guideGeometry } from "@/cut/lib/guides";

/** A custom line released this close to a frame edge drops. */
const EDGE_DROP = 0.01;

/**
 * The preview guides: thin lines and shaded keep-out regions drawn over the
 * stage in an SVG sized to it. The layer sits beside the stage in the chrome
 * host, outside the picture, so it never enters the frame loop, a captured
 * frame, or an export. It hides in a shared read-only view and under ⌘;.
 * Custom lines draw in blue and drag; a click on one, or a release at the
 * frame edge, removes it.
 */
export function GuideOverlay({ stage }: { stage: { w: number; h: number } }) {
  const guides = useEditor((s) => s.guides);
  const guideLines = useEditor((s) => s.guideLines);
  const hidden = useEditor((s) => s.guidesHidden);
  const readOnly = useEditor((s) => s.readOnly);
  const aspect = useEditor((s) => s.aspect);
  if (hidden || readOnly || guides.length === 0) return null;
  const geo = guideGeometry(guides, aspect, guideLines);
  if (
    geo.v.length === 0 &&
    geo.h.length === 0 &&
    geo.boxes.length === 0 &&
    geo.custom.v.length === 0 &&
    geo.custom.h.length === 0
  )
    return null;
  const { w, h } = stage;
  const label = Math.max(9, Math.min(12, w / 36));

  const dragLine = (axis: "v" | "h", index: number, from: number) => (e: React.PointerEvent) => {
    const size = axis === "v" ? w : h;
    const st = useEditor.getState();
    st.beginHistoryBatch();
    let raw = from;
    startDrag(e, {
      cursor: () => (axis === "v" ? "col-resize" : "row-resize"),
      onMove: (dx, dy) => {
        raw = from + (axis === "v" ? dx : dy) / size;
        useEditor.getState().moveGuideLine(axis, index, raw);
      },
      onUp: (_dx, _dy, moved) => {
        const s = useEditor.getState();
        if (!moved || raw <= EDGE_DROP || raw >= 1 - EDGE_DROP) s.removeGuideLine(axis, index);
        s.endHistoryBatch();
      },
    });
  };

  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
    >
      <defs>
        <pattern id="cut-guide-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(239,68,68,0.45)" strokeWidth="1.5" />
        </pattern>
      </defs>
      {geo.boxes.map((b, i) => {
        const x = b.x * w;
        const y = b.y * h;
        const bw = b.w * w;
        const bh = b.h * h;
        // A full-width band names itself at its inner edge; a side rail at
        // its top, so the label sits where the keep-out meets the picture.
        const labelY = b.w >= 0.99 && b.y <= 0.01 ? y + bh - 5 : y + label + 4;
        return (
          <g key={`box-${i}`}>
            <rect x={x} y={y} width={bw} height={bh} fill="rgba(239,68,68,0.12)" />
            <rect x={x} y={y} width={bw} height={bh} fill="url(#cut-guide-hatch)" />
            <rect
              x={x + 0.5}
              y={y + 0.5}
              width={Math.max(0, bw - 1)}
              height={Math.max(0, bh - 1)}
              fill="none"
              stroke="rgba(239,68,68,0.8)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            {bw > 40 && bh > label * 2 && (
              <text
                x={x + 6}
                y={labelY}
                fontSize={label}
                fontWeight={600}
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(0,0,0,0.5)"
                strokeWidth="2.5"
                paintOrder="stroke"
                style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif" }}
              >
                {b.label}
              </text>
            )}
          </g>
        );
      })}
      {geo.v.map((f, i) => (
        <g key={`v-${i}`}>
          <line x1={f * w} y1={0} x2={f * w} y2={h} stroke="rgba(0,0,0,0.45)" strokeWidth="3" />
          <line x1={f * w} y1={0} x2={f * w} y2={h} stroke="rgba(255,255,255,0.9)" strokeWidth="1" />
        </g>
      ))}
      {geo.h.map((f, i) => (
        <g key={`h-${i}`}>
          <line x1={0} y1={f * h} x2={w} y2={f * h} stroke="rgba(0,0,0,0.45)" strokeWidth="3" />
          <line x1={0} y1={f * h} x2={w} y2={f * h} stroke="rgba(255,255,255,0.9)" strokeWidth="1" />
        </g>
      ))}
      {geo.custom.v.map((f, i) => (
        <g key={`cv-${i}`}>
          <line x1={f * w} y1={0} x2={f * w} y2={h} stroke="rgba(0,0,0,0.45)" strokeWidth="3" />
          <line x1={f * w} y1={0} x2={f * w} y2={h} stroke="rgb(96,165,250)" strokeWidth="1" />
          <line
            x1={f * w}
            y1={0}
            x2={f * w}
            y2={h}
            stroke="transparent"
            strokeWidth="12"
            className="cursor-col-resize" style={{ pointerEvents: "stroke" }}
            onPointerDown={dragLine("v", i, f)}
          />
        </g>
      ))}
      {geo.custom.h.map((f, i) => (
        <g key={`ch-${i}`}>
          <line x1={0} y1={f * h} x2={w} y2={f * h} stroke="rgba(0,0,0,0.45)" strokeWidth="3" />
          <line x1={0} y1={f * h} x2={w} y2={f * h} stroke="rgb(96,165,250)" strokeWidth="1" />
          <line
            x1={0}
            y1={f * h}
            x2={w}
            y2={f * h}
            stroke="transparent"
            strokeWidth="12"
            className="cursor-row-resize" style={{ pointerEvents: "stroke" }}
            onPointerDown={dragLine("h", i, f)}
          />
        </g>
      ))}
    </svg>
  );
}
