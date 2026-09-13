"use client";

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
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
  const nodes = useRef(new Map<string, HTMLElement>());
  const session = useRef<{
    slots: { id: T; rect: DOMRect }[];
    scroll: { el: HTMLElement; x: number; y: number }[];
  } | null>(null);
  // The list keeps living during a drag — a queue drains, a card arrives — so
  // the preview is reconciled against it: ids that left drop out, ids that
  // arrived land at the end.
  const shown = drag
    ? [
        ...drag.preview.filter((id) => order.includes(id)),
        ...order.filter((id) => !drag.preview.includes(id)),
      ]
    : (order as T[]);
  const nodeRef = useSlide(drag !== null, nodes);

  // Drop slots keep their starting geometry through every preview reorder.
  // Animated cards can cross the pointer without changing its destination.
  const hover = (e: React.DragEvent) => {
    const active = session.current;
    if (!drag || !active) return;
    let x = e.clientX;
    let y = e.clientY;
    for (const origin of active.scroll) {
      x += origin.el.scrollLeft - origin.x;
      y += origin.el.scrollTop - origin.y;
    }
    let distance = Infinity;
    let to = -1;
    let index = 0;
    for (const slot of active.slots) {
      if (!order.includes(slot.id)) continue;
      const dx = Math.max(slot.rect.left - x, 0, x - slot.rect.right);
      const dy = Math.max(slot.rect.top - y, 0, y - slot.rect.bottom);
      const next = dx * dx + dy * dy;
      if (next < distance) {
        distance = next;
        to = index;
      }
      index++;
    }
    const from = shown.indexOf(drag.id);
    if (from < 0 || to < 0 || from === to) return;
    const preview = shown.slice();
    preview.splice(to, 0, ...preview.splice(from, 1));
    setDrag({ id: drag.id, preview });
  };

  const land = () => {
    if (!session.current) return;
    session.current = null;
    if (drag && order.includes(drag.id)) commit(shown);
    setDrag(null);
  };

  const cancel = () => {
    session.current = null;
    setDrag(null);
  };

  const itemProps = (
    id: T,
  ): { dragging: boolean; ref: (el: HTMLElement | null) => void } & ItemHandlers => ({
    dragging: drag?.id === id,
    ref: nodeRef(id),
    onDragEnd: cancel,
    onDragOver: (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      hover(e);
    },
    onDragStart: (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(SORT_MIME, id);
      const slots = order.flatMap((item) => {
        const el = nodes.current.get(item);
        return el ? [{ id: item, rect: el.getBoundingClientRect() }] : [];
      });
      const scroll = [];
      for (let el = e.currentTarget.parentElement; el; el = el.parentElement) {
        scroll.push({ el, x: el.scrollLeft, y: el.scrollTop });
      }
      session.current = { slots, scroll };
      setDrag({ id, preview: [...order] });
    },
    onDrop: (e) => {
      if (!drag) return;
      e.preventDefault();
      e.stopPropagation();
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
      hover(e);
    },
    onDrop: (e: React.DragEvent) => {
      if (!drag) return;
      e.preventDefault();
      land();
    },
  };

  return { containerProps, dragging: drag?.id ?? null, itemProps, order: shown };
}

/** Animate from each card's current visual position when its layout moves. */
function useSlide(
  live: boolean,
  nodes: RefObject<Map<string, HTMLElement>>,
) {
  const callbacks = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const last = useRef(new Map<string, { x: number; y: number }>());
  const animations = useRef(new Map<string, Animation>());
  const wasLive = useRef(false);

  useLayoutEffect(() => {
    const running = animations.current;
    return () => {
      running.forEach((animation) => animation.cancel());
      running.clear();
    };
  }, []);

  useLayoutEffect(() => {
    for (const id of callbacks.current.keys()) {
      if (nodes.current.has(id)) continue;
      callbacks.current.delete(id);
      animations.current.get(id)?.cancel();
      animations.current.delete(id);
    }
    const now = new Map<string, { x: number; y: number }>();
    const moves: { id: string; el: HTMLElement; dx: number; dy: number }[] = [];
    const animate =
      (live || wasLive.current) &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Finish all measurements before starting animations.
    nodes.current.forEach((el, id) => {
      const pos = { x: el.offsetLeft, y: el.offsetTop };
      now.set(id, pos);
      const was = last.current.get(id);
      if (!animate || !was || (was.x === pos.x && was.y === pos.y)) return;
      const transform = getComputedStyle(el).transform;
      const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
      moves.push({
        id,
        el,
        dx: was.x - pos.x + (matrix?.m41 ?? 0),
        dy: was.y - pos.y + (matrix?.m42 ?? 0),
      });
    });
    if (!animate) {
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    }
    for (const { id, el, dx, dy } of moves) {
      animations.current.get(id)?.cancel();
      const animation = el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
        { duration: SLIDE_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
      animations.current.set(id, animation);
      animation.onfinish = () => {
        if (animations.current.get(id) === animation) animations.current.delete(id);
      };
    }
    last.current = now;
    wasLive.current = live;
  });

  return (id: string) => {
    let cb = callbacks.current.get(id);
    if (!cb) {
      cb = (el: HTMLElement | null) => {
        if (el) nodes.current.set(id, el);
        else nodes.current.delete(id);
      };
      callbacks.current.set(id, cb);
    }
    return cb;
  };
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
