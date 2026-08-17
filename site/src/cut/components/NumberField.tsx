"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { snapNear } from "@/lib/snap";

/**
 * A numeric setting as one compact box: a glyph that scrubs on drag, a field
 * that takes a typed value, and an optional chevron holding the common values
 * for the setting. It carries what a label + slider + readout used to, in a
 * third of the width, so several settings fit one row.
 *
 * `onDraft` streams a drag (pair it with a transient updater that checkpoints
 * history on the first call); `onCommit` closes it.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step,
  snap,
  format,
  parse,
  onDraft,
  onCommit,
  presets,
  icon,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Detent values a drag lands on exactly. Typed and picked values stay exact. */
  snap?: number[];
  format: (v: number) => string;
  parse: (raw: string) => number | null;
  onDraft: (v: number) => void;
  onCommit: (v: number) => void;
  /** Offered under the chevron. Omit for a field with no menu. */
  presets?: number[];
  /** Drag handle. Omit for a field that only takes typed and picked values. */
  icon?: React.ReactNode;
  className?: string;
}) {
  const [entry, setEntry] = useState({ value, draft: format(value) });
  const [open, setOpen] = useState(false);
  const drag = useRef<{ startX: number; startValue: number; last: number } | null>(null);
  // A drag rewrites the value under the field; the box follows it, and any
  // value it did not author (a preset pick, an undo) resets the draft.
  if (entry.value !== value) setEntry({ value, draft: format(value) });

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const commitDraft = () => {
    const parsed = parse(entry.draft);
    if (parsed != null && Number.isFinite(parsed)) onCommit(clamp(parsed));
    else setEntry({ value, draft: format(value) });
  };

  const stepBy = (dir: number, coarse: boolean) => {
    const parsed = parse(entry.draft);
    const base = parsed != null && Number.isFinite(parsed) ? parsed : value;
    onCommit(clamp(base + dir * step * (coarse ? 10 : 1)));
  };

  return (
    <div
      className={cn(
        "number-field flex h-7 min-w-0 items-center gap-1 rounded-md bg-secondary/60 pr-0.5 pl-1.5 focus-within:ring-1 focus-within:ring-primary/60",
        className
      )}
    >
      {icon && (
        <span
          aria-hidden
          title="Drag to adjust"
          className="grid shrink-0 cursor-ew-resize touch-none place-items-center text-muted-foreground [&_svg]:size-3.5"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = { startX: e.clientX, startValue: value, last: value };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            // 2px per step; Shift coarsens to ×10.
            let next = clamp(d.startValue + ((e.clientX - d.startX) / 2) * step * (e.shiftKey ? 10 : 1));
            if (snap) next = clamp(snapNear(next, snap, min, max));
            d.last = next;
            onDraft(next);
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            e.currentTarget.releasePointerCapture(e.pointerId);
            if (d) onCommit(d.last);
          }}
          onPointerCancel={() => {
            const d = drag.current;
            drag.current = null;
            if (d) onCommit(d.last);
          }}
        >
          {icon}
        </span>
      )}
      <input
        aria-label={label}
        value={entry.draft}
        inputMode="decimal"
        spellCheck={false}
        className="w-full min-w-0 bg-transparent font-mono text-[11.5px] tabular-nums outline-none"
        onChange={(e) => setEntry({ value, draft: e.target.value })}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitDraft();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setEntry({ value, draft: format(value) });
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            stepBy(e.key === "ArrowUp" ? 1 : -1, e.shiftKey);
          }
        }}
      />
      {presets && presets.length > 0 && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            aria-label={`${label} presets`}
            className="grid size-6 shrink-0 place-items-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <ChevronDown className="size-3.5" />
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" sideOffset={6} className="w-28 p-1">
            <div className="max-h-64 overflow-y-auto">
              {presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="flex h-7 w-full items-center rounded-md px-2 font-mono text-[11.5px] tabular-nums transition-colors hover:bg-secondary"
                  onClick={() => {
                    onCommit(clamp(p));
                    setOpen(false);
                  }}
                >
                  {format(p)}
                  {Math.abs(p - value) < step / 2 && (
                    <Check className="ml-auto size-3.5 text-muted-foreground" />
                  )}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
