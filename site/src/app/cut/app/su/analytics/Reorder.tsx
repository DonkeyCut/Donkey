"use client";

import { useMemo, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

import { useLocalPref } from "@/cut/lib/uiState";
import { cn } from "@/lib/utils";

/**
 * Drag-to-reorder for a grid of dashboard blocks. localStorage keeps a list of
 * block ids; ids the page no longer renders drop out of it and blocks the page
 * gained land in their default position, so the saved order survives the
 * dashboard growing new cards.
 */
export function useReorder<T extends string>(key: string, ids: readonly T[]) {
  const [saved, setSaved] = useLocalPref<string[]>(
    key,
    [],
    (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  );
  const [dragId, setDragId] = useState<T | null>(null);
  const [overId, setOverId] = useState<T | null>(null);

  const order = useMemo(() => {
    const kept = saved.filter((id): id is T => (ids as readonly string[]).includes(id));
    return [...kept, ...ids.filter((id) => !kept.includes(id))];
  }, [saved, ids]);

  // Dropping onto a block ahead of the dragged one lands after it, behind it
  // lands before — the block ends up where the pointer let go.
  const move = (from: T, to: T) => {
    if (from === to) return;
    const forward = order.indexOf(from) < order.indexOf(to);
    const next = order.filter((id) => id !== from);
    next.splice(next.indexOf(to) + (forward ? 1 : 0), 0, from);
    setSaved(next);
  };

  const blockProps = (id: T) => ({
    dragging: dragId === id,
    over: overId === id && dragId !== null && dragId !== id,
    onDragEnd: () => {
      setDragId(null);
      setOverId(null);
    },
    onDragLeave: () => setOverId((prev) => (prev === id ? null : prev)),
    onDragOver: (e: React.DragEvent) => {
      if (dragId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setOverId(id);
    },
    onDragStart: (e: React.DragEvent) => {
      setDragId(id);
      e.dataTransfer.effectAllowed = "move";
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragId !== null) move(dragId, id);
      setDragId(null);
      setOverId(null);
    },
  });

  return { blockProps, customized: saved.length > 0, order, reset: () => setSaved([]) };
}

/**
 * One block in a reordered grid. The card only becomes draggable while its
 * grip is held, so charts keep their own pointer handling.
 */
export function DragBlock({
  dragging,
  over,
  className,
  children,
  onDragEnd,
  ...handlers
}: {
  dragging: boolean;
  over: boolean;
  className?: string;
  children: ReactNode;
  onDragEnd: () => void;
  onDragLeave: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <div
      {...handlers}
      draggable={armed}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      className={cn(
        "group relative h-full rounded-xl [&>div]:h-full",
        dragging && "opacity-40",
        over && "outline-2 outline-offset-2 outline-[var(--chart-1)]",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        onPointerDown={() => setArmed(true)}
        onPointerUp={() => setArmed(false)}
        onPointerCancel={() => setArmed(false)}
        className="absolute top-2 right-2 z-20 cursor-grab rounded-md p-1 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 active:cursor-grabbing group-hover:opacity-100"
      >
        <GripVertical className="size-4" />
      </button>
      {children}
    </div>
  );
}
