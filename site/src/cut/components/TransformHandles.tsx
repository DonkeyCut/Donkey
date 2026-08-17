"use client";

import type { CSSProperties } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The selection frame every resizable thing on the stage wears: a grip at each
 * corner, one on each side, and a rotate button above the top edge that reads
 * out the angle while it turns. The frame draws and routes gestures; what a
 * drag means belongs to the caller, which gets the grabbed handle and decides
 * what it resizes.
 */

/** Which grip a gesture grabbed. Corners pull both axes, the side pair pulls
 * width, the top/bottom pair pulls height. */
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** The default set: four corners and the two side grips. */
export const BOX_HANDLES: ResizeHandle[] = ["nw", "ne", "se", "sw", "w", "e"];
/** Corners alone, for a box whose axes are locked together. */
export const CORNER_HANDLES: ResizeHandle[] = ["nw", "ne", "se", "sw"];

/** Which way a grip pulls, in the box's own space: -1/0/1 per axis, which is
 * also its position on the frame (0 = the middle of that axis). */
export const HANDLE_AXIS: Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

const CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

/** The cursor for a grip on a box turned by `rotation`: the direction it pulls
 * on screen, rounded to the nearest of the four resize cursors. */
export function resizeCursor(handle: ResizeHandle, rotation = 0): string {
  const a = HANDLE_AXIS[handle];
  const deg = (Math.atan2(a.y, a.x) * 180) / Math.PI + rotation;
  return CURSORS[((Math.round(deg / 45) % 4) + 4) % 4];
}

export function TransformHandles({
  color = "#0a84ff",
  handles = BOX_HANDLES,
  rotation = 0,
  angle = null,
  onResize,
  onRotate,
  frame,
  className,
  rotateGap = 32,
  rotateCursor,
  resizeTitle = "Drag to resize",
  rotateTitle = "Drag to rotate",
}: {
  /** Ring color on every grip; the chrome it belongs to picks it. */
  color?: string;
  /** Which grips to draw. */
  handles?: ResizeHandle[];
  /** The box's on-screen angle: cursors point the way a drag pulls, and the
   * rotate button counter-turns so its readout stays upright. */
  rotation?: number;
  /** Degrees to show in the readout; null while nothing is turning. */
  angle?: number | null;
  onResize?: (handle: ResizeHandle, e: React.PointerEvent) => void;
  onRotate?: (e: React.PointerEvent) => void;
  /** Absolute placement for the frame; absent means the parent's own box. */
  frame?: CSSProperties;
  className?: string;
  /** Screen px between the top edge and the rotate button. */
  rotateGap?: number;
  /** Cursor CSS for the rotate button. */
  rotateCursor?: string;
  resizeTitle?: string;
  rotateTitle?: string;
}) {
  return (
    <div
      className={cn("pointer-events-none absolute", !frame && "inset-0", className)}
      style={frame}
    >
      {onRotate && (
        <div className="absolute left-1/2 top-0">
          <div
            className="relative"
            style={{ transform: `translate(-50%, -50%) rotate(${-rotation}deg)`, top: -rotateGap }}
          >
            {angle !== null && (
              <span className="absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white">
                {Math.round(angle)}°
              </span>
            )}
            <span
              title={rotateTitle}
              onPointerDown={onRotate}
              style={{ cursor: rotateCursor ?? "grab" }}
              className="pointer-events-auto grid size-[22px] place-items-center rounded-full bg-white text-neutral-700 shadow-[0_1px_4px_rgba(0,0,0,0.4)]"
            >
              <RefreshCw className="size-3" strokeWidth={2.25} />
            </span>
          </div>
        </div>
      )}
      {onResize &&
        handles.map((h) => {
          const a = HANDLE_AXIS[h];
          const side = a.x === 0 || a.y === 0;
          return (
            <span
              key={h}
              title={resizeTitle}
              onPointerDown={(e) => onResize(h, e)}
              className={cn(
                "pointer-events-auto absolute rounded-full border-[2.5px] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.4)]",
                !side && "size-[13px]",
                side && (a.x === 0 ? "h-[9px] w-[20px]" : "h-[20px] w-[9px]")
              )}
              style={{
                left: `${(a.x + 1) * 50}%`,
                top: `${(a.y + 1) * 50}%`,
                transform: "translate(-50%, -50%)",
                borderColor: color,
                cursor: resizeCursor(h, rotation),
              }}
            />
          );
        })}
    </div>
  );
}
