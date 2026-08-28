"use client";

import { useRef } from "react";
import { Info, RotateCcw } from "lucide-react";
import { useEditor } from "@/cut/lib/store";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The Inspector's shared row furniture, in a module of its own so the panels
 * that grew out of the Inspector (the color panel) build rows the same way
 * without importing the whole file.
 */

/**
 * One undo checkpoint per slider drag: capture the pre-drag state on the first
 * change, then feed live changes through the transient updater so the whole
 * drag collapses to a single ⌘Z. Reset when the interaction commits.
 */
export function useSliderCheckpoint() {
  const active = useRef(false);
  return {
    begin() {
      if (active.current) return;
      active.current = true;
      useEditor.getState().pushHistory();
    },
    end() {
      active.current = false;
    },
  };
}

export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className="grid size-4 place-items-center text-muted-foreground/70 transition-colors hover:text-foreground"
          aria-label={`About ${label.toLowerCase()}`}
        >
          <Info className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-60">
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function Row({
  label,
  info,
  grow,
  children,
}: {
  label: string;
  /** Hoverable (i) after the label explaining what the control does. */
  info?: React.ReactNode;
  /** Stretch the control over the row's free width; the default hugs the
   * control to the right edge at its own size. */
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-2.5">
      <span className="flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
        {label}
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </span>
      <div className={cn("flex min-w-0 items-center gap-2", grow && "grow")}>{children}</div>
    </div>
  );
}

export const Value = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("font-mono text-[11.5px] tabular-nums", className)}>{children}</span>
);

/** Sits at the right end of a row, visible once its value has moved off the
 * default. Always occupies its slot so the row doesn't shift when it appears. */
export function ResetButton({ title, show, onClick }: { title: string; show: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-hidden={!show}
      tabIndex={show ? undefined : -1}
      className={cn(
        "grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground",
        !show && "invisible",
      )}
      onClick={onClick}
    >
      <RotateCcw className="size-3" />
    </button>
  );
}

/**
 * A named group of rows under a hairline. A section that owns a feature carries
 * the switch that turns it on and holds its rows back until it is, so the panel
 * reads as a short list of what the element actually has and grows only where
 * it was asked to. Pass no `onEnabledChange` for a group that is always open.
 */
export function Section({
  title,
  info,
  enabled,
  onEnabledChange,
  aside,
  children,
}: {
  title: string;
  info?: React.ReactNode;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  /** Controls that belong to the group as a whole, sat at the end of its title. */
  aside?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const gated = !!onEnabledChange;
  return (
    <section className="mt-1.5 border-t border-border pt-1.5 first:mt-0 first:border-t-0">
      <div className="flex min-h-9 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium">
          <span className="truncate">{title}</span>
          {info && <InfoTip label={title}>{info}</InfoTip>}
        </span>
        {aside}
        {gated && (
          <Switch checked={!!enabled} onCheckedChange={onEnabledChange} aria-label={title} />
        )}
      </div>
      {(!gated || enabled) && children}
    </section>
  );
}
