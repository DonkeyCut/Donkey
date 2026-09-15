"use client";

import type { PointerEvent } from "react";
import { startDrag } from "@/cut/lib/drag";
import { previewAt } from "@/cut/lib/playhead";
import { useEditor } from "@/cut/lib/store";
import { movePreviewSelection, previewSelectionSnapshot } from "@/cut/lib/previewSelection";

/** Selected items share one gesture and one undo checkpoint. */
export function startSelectionDrag(e: PointerEvent, width: number, height: number): boolean {
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
  });
  return true;
}
