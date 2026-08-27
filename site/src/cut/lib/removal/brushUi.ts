"use client";

/**
 * The custom-removal brush session: which clip is being painted on, the tool
 * in hand, and the brush size. View state shared by the removal panel (the
 * tool buttons) and the stage gizmo (the pointer) — never saved; the strokes
 * themselves land in the doc as `removal.seeds`.
 */

import { create } from "zustand";

export type BrushTool = "quick" | "brush" | "quickErase" | "erase";

/** Brush diameter bounds, as a fraction of the frame's short side. */
export const BRUSH_SIZE_MIN = 0.02;
export const BRUSH_SIZE_MAX = 0.25;
export const BRUSH_SIZE_DEFAULT = 0.07;

interface BrushUi {
  /** The clip being painted, or null when no brush session is open. */
  clipId: string | null;
  tool: BrushTool;
  size: number;
  open: (clipId: string) => void;
  close: () => void;
  setTool: (tool: BrushTool) => void;
  setSize: (size: number) => void;
}

export const useBrushUi = create<BrushUi>((set) => ({
  clipId: null,
  tool: "quick",
  size: BRUSH_SIZE_DEFAULT,
  open: (clipId) => set({ clipId, tool: "quick" }),
  close: () => set({ clipId: null }),
  setTool: (tool) => set({ tool }),
  setSize: (size) => set({ size: Math.min(BRUSH_SIZE_MAX, Math.max(BRUSH_SIZE_MIN, size)) }),
}));
