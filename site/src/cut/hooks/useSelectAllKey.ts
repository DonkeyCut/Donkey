"use client";

import { useEffect, useRef, type RefObject } from "react";
import { dialogOnTop, isSelectAllKey, isTextEntry, menuOnTop } from "@/cut/lib/shortcutGate";

/**
 * ⌘A over a page of tiles picks every tile on screen. The page takes the
 * chord while it is the one shown, so the browser's own select-all never
 * paints the text of the pages the router keeps mounted and hidden; a text
 * field, a dialog, or an open menu keeps it.
 */
export function useSelectAllKey(root: RefObject<HTMLElement | null>, onSelectAll: () => void): void {
  const latest = useRef(onSelectAll);
  useEffect(() => {
    latest.current = onSelectAll;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isSelectAllKey(e)) {
        return;
      }
      if (isTextEntry(e.target) || dialogOnTop() || menuOnTop()) {
        return;
      }
      if (!root.current?.checkVisibility()) {
        return;
      }
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);
}
