"use client";

import { useEffect, useRef, type RefObject } from "react";
import { dialogOnTop, isDeleteKey, isTextEntry, menuOnTop } from "@/cut/lib/shortcutGate";

/**
 * ⌫ or Delete over a page of tiles asks for the pick to go. The page keeps
 * the keystroke only while it is the one on screen — the router leaves a page
 * you navigated away from mounted and hidden — and stands aside for a text
 * field, a dialog, or an open menu. `onDelete` is null while nothing is
 * picked.
 */
export function useDeleteKey(
  root: RefObject<HTMLElement | null>,
  onDelete: (() => void) | null
): void {
  const latest = useRef(onDelete);
  useEffect(() => {
    latest.current = onDelete;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!latest.current || e.defaultPrevented || !isDeleteKey(e)) return;
      if (isTextEntry(e.target) || dialogOnTop() || menuOnTop()) return;
      if (!root.current?.checkVisibility()) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [root]);
}
