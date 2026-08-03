"use client";

import { cn } from "@/lib/utils";

/**
 * A pickable square in a panel grid: a preview above, its name below. Clip
 * effects and overlay animations both choose from grids of these, so the
 * selected ring, hover and sizing are decided once.
 */
export function Tile({
  ref,
  selected,
  onClick,
  onHover,
  label,
  className,
  draggable,
  onDragStart,
  onDragEnd,
  title,
  children,
}: {
  /** For a grid that scrolls a tile into view. */
  ref?: React.Ref<HTMLButtonElement>;
  selected: boolean;
  onClick: () => void;
  /** Pointer entering or leaving — a tile whose preview only plays on hover. */
  onHover?: (inside: boolean) => void;
  label: string;
  className?: string;
  /** A tile that places something by being dragged onto the timeline. */
  draggable?: boolean;
  onDragStart?: React.DragEventHandler<HTMLButtonElement>;
  onDragEnd?: React.DragEventHandler<HTMLButtonElement>;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      className={cn(
        "flex flex-col items-center gap-1.5 rounded-lg border border-border p-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
        selected && "bg-primary/10 text-foreground ring-2 ring-[#0a84ff] ring-offset-1 ring-offset-card",
        className
      )}
      onClick={onClick}
    >
      {children}
      <span className="leading-none">{label}</span>
    </button>
  );
}
