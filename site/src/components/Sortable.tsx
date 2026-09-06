"use client";

import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";

import { cn } from "@/lib/utils";

/** How long a displaced item takes to slide into its new slot. */
const SLIDE_MS = 180;

/** A private drag type. Firefox refuses to start a drag with an empty
 * dataTransfer, and a private type keeps a sort drag invisible to the file and
 * asset drop zones the same page may be running. */
const SORT_MIME = "application/x-sort-item";

type ItemHandlers = {
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
};

/**
 * Drag-to-sort with a live preview: while a drag is in flight the list renders
 * in the order it would land in, so the other items slide out of the way and
 * the hole under the cursor is the drop zone. Letting go commits that order;
 * cancelling the drag slides everything back.
 *
 * The hook owns order and animation only. Each surface decides what makes an
 * item draggable — a grip, the whole row — and spreads the handlers where it
 * wants them.
 */
export function useDragSort<T extends string>(
  order: readonly T[],
  commit: (next: T[]) => void,
) {
  const [drag, setDrag] = useState<{ id: T; preview: T[] } | null>(null);
  // The list keeps living during a drag — a queue drains, a card arrives — so
  // the preview is reconciled against it: ids that left drop out, ids that
  // arrived land at the end.
  const shown = drag
    ? [
        ...drag.preview.filter((id) => order.includes(id)),
        ...order.filter((id) => !drag.preview.includes(id)),
      ]
    : (order as T[]);
  const nodeRef = useSlide(drag !== null);

  // Hovering another item moves the dragged one into that slot: forward past
  // the hovered item, backward in front of it — so it lands where the pointer
  // is. After the shift the pointer sits over the dragged item's own hole,
  // which is ignored, so the preview settles instead of oscillating.
  const hover = (id: T) => {
    if (!drag || drag.id === id) return;
    const from = shown.indexOf(drag.id);
    const to = shown.indexOf(id);
    if (from < 0 || to < 0) return;
    const preview = shown.slice();
    preview.splice(to, 0, ...preview.splice(from, 1));
    setDrag({ id: drag.id, preview });
  };

  const land = () => {
    if (drag) commit(shown);
    setDrag(null);
  };

  const itemProps = (
    id: T,
  ): { dragging: boolean; ref: (el: HTMLElement | null) => void } & ItemHandlers => ({
    dragging: drag?.id === id,
    ref: nodeRef(id),
    onDragEnd: () => setDrag(null),
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      hover(id);
    },
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(SORT_MIME, id);
      setDrag({ id, preview: [...order] });
    },
    onDrop: (e) => {
      e.preventDefault();
      land();
    },
  });

  // The gaps between items belong to the list too, so a release that lands
  // between two cards keeps the arrangement instead of snapping back.
  const containerProps = {
    onDragOver: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      land();
    },
  };

  return { containerProps, dragging: drag?.id ?? null, itemProps, order: shown };
}

/**
 * Slides items between layout positions. Every commit records where the
 * registered nodes sit; while a drag is live, a commit that moved them puts
 * each one back where it was with a transform and then releases it, so the
 * reordering reads as movement rather than a jump. Layout offsets stand in for
 * viewport rects, so scrolling mid-drag does not register as movement.
 *
 * Measuring on every commit — rather than only when the order changes — is
 * what makes the first drag animate: the list is often laid out after the hook
 * first runs, and a stale record would have nothing to move from.
 */
function useSlide(live: boolean) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const callbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const last = useRef(new Map<string, { x: number; y: number }>());
  // The commit that ends a drag animates too: the list either settles into the
  // dropped order or slides back from a cancel.
  const wasLive = useRef(false);

  useLayoutEffect(() => {
    const now = new Map<string, { x: number; y: number }>();
    nodes.current.forEach((el, id) => now.set(id, { x: el.offsetLeft, y: el.offsetTop }));
    const animate =
      (live || wasLive.current) &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animate)
      now.forEach((pos, id) => {
        const was = last.current.get(id);
        const el = nodes.current.get(id);
        if (!was || !el) return;
        const dx = was.x - pos.x;
        const dy = was.y - pos.y;
        if (!dx && !dy) return;
        el.style.transition = "none";
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        requestAnimationFrame(() => {
          el.style.transition = `transform ${SLIDE_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
          el.style.transform = "";
        });
      });
    last.current = now;
    wasLive.current = live;
  });

  return useCallback((id: string) => {
    let cb = callbacks.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) nodes.current.set(id, el);
        else nodes.current.delete(id);
      };
      callbacks.current.set(id, cb);
    }
    return cb;
  }, []);
}

/** Longest side of a drag ghost, px. */
const GHOST_MAX = 260;

/**
 * The item itself as the drag ghost, snapshotted before it turns into a hole.
 * A large card shrinks so the thing in hand does not blanket the list it is
 * carried across.
 */
export function setSortDragImage(e: React.DragEvent, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const scale = Math.min(1, GHOST_MAX / Math.max(rect.width, rect.height));
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.width = `${rect.width}px`;
  clone.style.height = `${rect.height}px`;
  clone.style.margin = "0";
  clone.style.opacity = "0.9";
  clone.style.transform = `scale(${scale})`;
  clone.style.transformOrigin = "top left";
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;top:-1000px;left:-1000px;pointer-events:none;" +
    `width:${rect.width * scale}px;height:${rect.height * scale}px;`;
  wrap.appendChild(clone);
  document.body.appendChild(wrap);
  e.dataTransfer.setDragImage(
    wrap,
    Math.min(Math.max(e.clientX - rect.left, 0), rect.width) * scale,
    Math.min(Math.max(e.clientY - rect.top, 0), rect.height) * scale,
  );
  setTimeout(() => wrap.remove(), 0);
}

/**
 * One card in a sorted grid. The card becomes draggable only while its grip is
 * held, so charts keep their own pointer handling, and it empties to a dashed
 * outline for the length of the drag — the hole travels with the pointer and
 * shows where the card lands.
 */
export function SortCard({
  children,
  className,
  dragging,
  onDragEnd,
  onDragStart,
  ref,
  ...handlers
}: {
  children: ReactNode;
  className?: string;
  dragging: boolean;
  ref: (el: HTMLElement | null) => void;
} & ItemHandlers) {
  const host = useRef<HTMLDivElement | null>(null);
  const [armed, setArmed] = useState(false);
  return (
    <div
      {...handlers}
      draggable={armed}
      ref={(el) => {
        host.current = el;
        ref(el);
      }}
      onDragEnd={() => {
        setArmed(false);
        onDragEnd();
      }}
      onDragStart={(e) => {
        if (host.current) setSortDragImage(e, host.current);
        onDragStart(e);
      }}
      className={cn(
        "group relative h-full min-w-0 rounded-xl [&>div]:h-full",
        dragging &&
          "bg-muted/40 outline-2 outline-dashed -outline-offset-2 outline-muted-foreground/30 [&>*]:invisible",
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
