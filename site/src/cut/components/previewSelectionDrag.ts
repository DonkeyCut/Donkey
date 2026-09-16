"use client";

import type { PointerEvent } from "react";
import { startDrag } from "@/cut/lib/drag";
import { previewAt } from "@/cut/lib/playhead";
import { useEditor } from "@/cut/lib/store";
import { movePreviewSelection, previewSelectionSnapshot } from "@/cut/lib/previewSelection";
import type { Selection } from "@/cut/lib/types";

export function isPreviewSelectionModifier(e: Pick<PointerEvent, "metaKey" | "ctrlKey" | "shiftKey">): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey;
}

/** Own the whole press so its generated click cannot select a second time. */
export function togglePreviewSelection(e: PointerEvent, item: NonNullable<Selection>): boolean {
  if (e.button !== 0 || !isPreviewSelectionModifier(e)) return false;
  startDrag(e, { onMove: () => {} });
  useEditor.getState().toggleSelect(item);
  return true;
}

/** Selected items share one gesture and one undo checkpoint. A press on one
 * member that never travels narrows the selection to that member, the way a
 * plain click anywhere does. */
export function startSelectionDrag(e: PointerEvent, width: number, height: number, item?: NonNullable<Selection>): boolean {
  const s = useEditor.getState();
  if (s.multiSelection.length < 2) return false;
  const positions = previewSelectionSnapshot(s, previewAt());
  if (!positions.length) return false;
  let began = false;
  startDrag(e, {
    onMove: (dx, dy) => {
      if (!began) {
        if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
        useEditor.getState().pushHistory();
        began = true;
      }
      movePreviewSelection(useEditor.getState(), positions, dx / width, dy / height);
    },
    onUp: (_dx, _dy, moved) => {
      if (!moved && item) useEditor.getState().select(item);
    },
  });
  return true;
}
