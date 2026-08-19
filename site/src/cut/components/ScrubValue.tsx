"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { snapNear } from "@/lib/snap";

/**
 * Hot-text numeric value: reads as the plain mono readout it replaces, drag
 * horizontally to scrub (Shift = ×10 steps), click to type an exact value.
 * Enter/blur commits, Escape cancels, arrow keys nudge by `keyStep` (defaults
 * to `step` — time fields set 1s so arrows move whole seconds).
 *
 * With `onScrub` the drag streams live values (pair it with a draft/transient
 * updater like the sliders use); without it the drag previews in place and
 * `onCommit` fires once on release, so actions that checkpoint history
 * internally stay one undo step.
 */
export function ScrubValue({
  value,
  min,
  max,
  step,
  keyStep,
  snap,
  format,
  parse,
  onScrub,
  onCommit,
  disabled,
  className,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  keyStep?: number;
  /** Detent values: a drag passing within reach lands exactly on one.
   * Arrow keys and typed entries stay exact. */
  snap?: number[];
  format: (v: number) => string;
  parse: (raw: string) => number | null;
  onScrub?: (v: number) => void;
  onCommit: (v: number) => void;
  /** Nothing to write: the readout still shows the value and takes no drag,
   * no keystroke and no click. */
  disabled?: boolean;
  className?: string;
  label: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The readout's rendered width, held while the editor is open so swapping
  // the button for an input never reflows the row around it.
  const [editWidth, setEditWidth] = useState(0);
  const skipBlur = useRef(false);
  // Arrow keys inside the editor apply live through onScrub; these carry the
  // pre-edit value so Escape (or garbage text) can put it back.
  const editStart = useRef(0);
  const liveArrowed = useRef(false);
  const drag = useRef<{ startX: number; startValue: number; moved: boolean; last: number } | null>(
    null
  );

  const clamp = (v: number) => Math.min(max, Math.max(min, quantize(v, step)));
  const arrowStep = keyStep ?? step;

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const openEditor = () => {
    skipBlur.current = false;
    liveArrowed.current = false;
    setEditWidth(buttonRef.current?.offsetWidth ?? 0);
    editStart.current = value;
    setDraft(format(value));
    setEditing(true);
  };

  const commitDraft = () => {
    setEditing(false);
    const parsed = parse(draft.trim());
    if (parsed != null && Number.isFinite(parsed)) {
      // Unconditional (even when unchanged): commit is also what clears the
      // caller's scrub draft after live arrow steps.
      onCommit(clamp(parsed));
    } else if (liveArrowed.current) {
      // Arrow steps applied live, then the text turned unparseable: restore.
      onCommit(clamp(editStart.current));
    }
    liveArrowed.current = false;
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        autoFocus
        value={draft}
        aria-label={label}
        // At least as wide as the readout it replaced (so the row holds
        // still); mono font, so ch grows it with what the user types. The
        // underline is a shadow — a border would add a pixel of height.
        style={{ width: `${Math.max(draft.length, 3) + 1}ch`, minWidth: editWidth }}
        className={cn(
          "bg-transparent text-right font-mono text-[11.5px] tabular-nums text-foreground shadow-[0_1px_0_0] shadow-primary/60 outline-none",
          className
        )}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (skipBlur.current) {
            skipBlur.current = false;
            return;
          }
          commitDraft();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            skipBlur.current = true;
            commitDraft();
          } else if (e.key === "Escape") {
            skipBlur.current = true;
            setEditing(false);
            if (liveArrowed.current) {
              liveArrowed.current = false;
              onCommit(clamp(editStart.current));
            }
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = parse(draft.trim());
            const base = cur != null && Number.isFinite(cur) ? cur : value;
            const dir = e.key === "ArrowUp" ? 1 : -1;
            const next = clamp(base + dir * arrowStep * (e.shiftKey ? 10 : 1));
            setDraft(format(next));
            if (onScrub) {
              onScrub(next);
              liveArrowed.current = true;
            }
          }
        }}
      />
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      disabled={disabled}
      aria-label={label}
      title={disabled ? undefined : "Drag to adjust · click to type"}
      className={cn(
        "touch-none select-none text-right font-mono text-[11.5px] tabular-nums underline decoration-transparent decoration-dotted underline-offset-3 transition-colors",
        disabled
          ? "cursor-default opacity-50"
          : "cursor-ew-resize hover:text-foreground hover:decoration-current",
        className
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = { startX: e.clientX, startValue: value, moved: false, last: value };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        if (!d.moved && Math.abs(dx) < 3) return;
        d.moved = true;
        // 2px per step; Shift coarsens to ×10.
        let next = clamp(d.startValue + (dx / 2) * step * (e.shiftKey ? 10 : 1));
        if (snap) next = clamp(snapNear(next, snap, min, max));
        d.last = next;
        if (onScrub) onScrub(d.last);
        else setPreview(d.last);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        if (!d) return;
        if (d.moved) {
          setPreview(null);
          // Unconditional: with onScrub the value prop already tracks the
          // drag, so an equality guard would swallow the closing commit.
          onCommit(d.last);
        } else {
          openEditor();
        }
      }}
      onPointerCancel={() => {
        const d = drag.current;
        drag.current = null;
        setPreview(null);
        if (d?.moved) onCommit(d.last);
      }}
      onKeyDown={(e) => {
        // Keyboard path: Enter/Space opens the editor; arrows step the value
        // directly, each press one commit.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEditor();
        } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const dir = e.key === "ArrowUp" ? 1 : -1;
          onCommit(clamp(value + dir * arrowStep * (e.shiftKey ? 10 : 1)));
        }
      }}
    >
      {format(preview ?? value)}
    </button>
  );
}

/** Snap to the step grid so scrubbed values stay clean (step 0.1 → one decimal). */
function quantize(v: number, step: number) {
  return Number((Math.round(v / step) * step).toFixed(4));
}

/** "1:30", "1:30.5", "90", "0:06.5" → seconds. */
export function parseTimeInput(raw: string): number | null {
  const m = raw.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) : 0) * 60 + Number(m[2]);
}

/** "1.25", "1.25x", "1.25×", "125%" → playback rate. */
export function parseSpeedInput(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");
  const pct = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (pct) return Number(pct[1]) / 100;
  const m = s.match(/^(\d*\.?\d+)[x×]?$/);
  return m ? Number(m[1]) : null;
}

/** "0.5", "0.5s", "off" → seconds. */
export function parseSecondsInput(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");
  if (s === "off") return 0;
  const m = s.match(/^(\d*\.?\d+)s?$/);
  return m ? Number(m[1]) : null;
}

/** "80", "80%" → fraction 0.8. */
export function parsePercentInput(raw: string): number | null {
  const m = raw.trim().match(/^(\d*\.?\d+)%?$/);
  return m ? Number(m[1]) / 100 : null;
}

/** Plain or signed number, degree sign allowed: "64", "-12", "12°". */
export function parseNumberInput(raw: string): number | null {
  const m = raw.trim().replace(/°$/, "").match(/^-?\d*\.?\d+$/);
  return m ? Number(m[0]) : null;
}
