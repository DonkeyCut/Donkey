"use client";

import { useEffect, useState, type RefObject } from "react";

/**
 * Which rows of a long table are on screen.
 *
 * A table of every account, sixty cells a row, is tens of thousands of nodes;
 * React builds all of them on arrival and again on every sort, and the page
 * holds the thread for seconds each time. This keeps the rows to the ones in
 * view plus a margin: a spacer above and below stands in for the rest, so the
 * scrollbar and the sticky column read as if the table were whole.
 *
 * Rows are one height, measured from the first data row rendered (marked
 * data-row, so the spacer above it is skipped). The scroll
 * handler books one animation frame and reads layout once inside it.
 */
export interface RowWindow {
  start: number;
  end: number;
  /** Pixels standing in for the rows left out above and below. */
  above: number;
  below: number;
}

const ROW_HEIGHT_GUESS = 44;
const OVERSCAN = 16;

// The nearest ancestor that scrolls vertically. Overflow set on one axis
// computes to auto on the other, so the table's own sideways wrapper reads
// as a vertical scroller too; asking for real vertical overflow skips it.
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

export function useRowWindow(
  count: number,
  body: RefObject<HTMLTableSectionElement | null>,
): RowWindow {
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_GUESS);
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, 40) }));

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const scroller = scrollParentOf(el);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const probe = el.querySelector<HTMLTableRowElement>("tr[data-row]");
      const h = probe?.offsetHeight;
      if (h && h !== rowHeight) {
        setRowHeight(h);
        return;
      }
      const viewTop = scroller
        ? scroller.getBoundingClientRect().top - el.getBoundingClientRect().top
        : -el.getBoundingClientRect().top;
      const viewHeight = scroller ? scroller.clientHeight : window.innerHeight;
      const start = Math.min(count, Math.max(0, Math.floor(viewTop / rowHeight) - OVERSCAN));
      const end = Math.min(
        count,
        Math.max(start, Math.ceil((viewTop + viewHeight) / rowHeight) + OVERSCAN),
      );
      setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const target: EventTarget = scroller ?? window;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [body, count, rowHeight]);

  const start = Math.min(range.start, count);
  const end = Math.min(range.end, count);
  return { above: start * rowHeight, below: (count - end) * rowHeight, end, start };
}
