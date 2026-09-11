/**
 * Preview guides: lines and keep-out regions drawn over the stage so titles,
 * stickers and captions land where a phone will show them. Geometry is in
 * frame fractions (0..1 of width and height), so one preset serves every
 * frame size. Guides draw in the editor only; exports and captured frames
 * never carry them. The short-form preset is measured on a phone and dated,
 * so a change in an app's UI is one edit here.
 */

import { aspectOrientation, type Aspect } from "./types";

export type GuideId = "thirds" | "center" | "margins" | "shortform" | "custom";

/** The user's own lines, frame fractions per axis: v is x positions, h is y. */
export interface GuideLines {
  v: number[];
  h: number[];
}

/** A region the platform's own UI covers, as frame fractions. */
export interface GuideBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

/** Lines (frame fractions along one axis) and keep-out boxes to draw. The
 * custom lines come separately: they draw in their own color and drag. */
export interface GuideGeometry {
  v: number[];
  h: number[];
  boxes: GuideBox[];
  custom: GuideLines;
}

/** The rectangle left for graphics once every keep-out box is removed. */
export interface SafeArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GuidePreset {
  id: GuideId;
  name: string;
  sublabel?: string;
  /** Phone UI is measured on a phone, so the preset fits portrait frames. */
  portraitOnly?: boolean;
  geometry: Omit<GuideGeometry, "custom">;
}

/** Safe-margin inset, fraction of the frame. */
export const MARGIN_INSET = 0.05;

const phone = (px: number, of: 1080 | 1920) => px / of;

export const GUIDE_PRESETS: readonly GuidePreset[] = [
  {
    id: "thirds",
    name: "Thirds",
    geometry: { v: [1 / 3, 2 / 3], h: [1 / 3, 2 / 3], boxes: [] },
  },
  {
    id: "center",
    name: "Center",
    geometry: { v: [0.5], h: [0.5], boxes: [] },
  },
  {
    id: "margins",
    name: "Safe margins",
    sublabel: "5% inset",
    geometry: {
      v: [MARGIN_INSET, 1 - MARGIN_INSET],
      h: [MARGIN_INSET, 1 - MARGIN_INSET],
      boxes: [],
    },
  },
  // The phone UI of TikTok, Instagram Reels and YouTube Shorts, merged into
  // one keep-out: each region is the widest of the three. Measured September
  // 2026 on a 1170×2532 phone, mapped onto the 1080×1920 frame. Reels and
  // Shorts scale a 9:16 frame to fill the player and crop 4.4% off each
  // side; TikTok crops 1.4%. The top band covers the status bar and the
  // search row under it, the rail the actions from the avatar down, the
  // bottom band the username, caption and music line.
  {
    id: "shortform",
    name: "Short form",
    sublabel: "TikTok, Instagram, YouTube",
    portraitOnly: true,
    geometry: {
      v: [],
      h: [],
      boxes: [
        { x: 0, y: 0, w: 1, h: phone(215, 1920), label: "Top bar" },
        { x: 0, y: 0, w: phone(50, 1080), h: 1, label: "Cropped" },
        { x: 1 - phone(50, 1080), y: 0, w: phone(50, 1080), h: 1, label: "Cropped" },
        { x: phone(895, 1080), y: phone(730, 1920), w: phone(185, 1080), h: phone(730, 1920), label: "Actions" },
        { x: 0, y: phone(1460, 1920), w: 1, h: phone(460, 1920), label: "Caption · music · nav" },
      ],
    },
  },
  // The user's own lines, held in the project's guideLines and dragged on
  // the preview.
  {
    id: "custom",
    name: "Custom",
    sublabel: "Drag lines on the preview",
    geometry: { v: [], h: [], boxes: [] },
  },
];

export const EMPTY_GUIDE_LINES: GuideLines = { v: [], h: [] };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A stored line list with every position a number in 0..1. */
export function sanitizeGuideLines(v: unknown): GuideLines {
  const axis = (a: unknown) =>
    Array.isArray(a) ? a.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).map(clamp01) : [];
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return { v: axis(o.v), h: axis(o.h) };
}

export const GUIDE_IDS = GUIDE_PRESETS.map((p) => p.id) as GuideId[];

export function isGuideId(v: unknown): v is GuideId {
  return typeof v === "string" && (GUIDE_IDS as string[]).includes(v);
}

/** The known guide ids in a stored list, in registry order, each once. */
export function sanitizeGuides(v: unknown): GuideId[] {
  if (!Array.isArray(v)) return [];
  return GUIDE_IDS.filter((id) => v.includes(id));
}

export function guidePreset(id: GuideId): GuidePreset {
  return GUIDE_PRESETS.find((p) => p.id === id)!;
}

/** Whether a preset applies to the frame: platform chrome fits portrait frames. */
export function guideFits(id: GuideId, aspect: Aspect): boolean {
  return !guidePreset(id).portraitOnly || aspectOrientation(aspect) === "portrait";
}

/** Every line and box of the guides that are on and fit the frame, merged;
 * the custom lines ride along when the custom set is on. */
export function guideGeometry(
  ids: readonly GuideId[],
  aspect: Aspect,
  lines: GuideLines = EMPTY_GUIDE_LINES
): GuideGeometry {
  const out: GuideGeometry = { v: [], h: [], boxes: [], custom: EMPTY_GUIDE_LINES };
  for (const id of ids) {
    if (!guideFits(id, aspect)) continue;
    if (id === "custom") {
      out.custom = lines;
      continue;
    }
    const g = guidePreset(id).geometry;
    out.v.push(...g.v);
    out.h.push(...g.h);
    out.boxes.push(...g.boxes);
  }
  return out;
}

/** The snap lines the guides offer a dragged element: every drawn line plus
 * the inner edge of every keep-out box. */
export function guideSnapLines(
  ids: readonly GuideId[],
  aspect: Aspect,
  lines: GuideLines = EMPTY_GUIDE_LINES
): GuideLines {
  const g = guideGeometry(ids, aspect, lines);
  const v = [...g.v, ...g.custom.v];
  const h = [...g.h, ...g.custom.h];
  for (const b of g.boxes) {
    if (b.w >= 0.99) h.push(b.y <= 0.01 ? b.y + b.h : b.y);
    else if (b.x + b.w >= 0.99) v.push(b.x);
    else if (b.x <= 0.01) v.push(b.x + b.w);
  }
  return { v, h };
}

/** The frame minus every keep-out box and inside the safe margins, as one
 * rectangle; null when no active guide bounds anything. */
export function safeAreaOf(ids: readonly GuideId[], aspect: Aspect): SafeArea | null {
  let left = 0;
  let top = 0;
  let right = 1;
  let bottom = 1;
  let bounded = false;
  if (ids.includes("margins")) {
    left = top = MARGIN_INSET;
    right = bottom = 1 - MARGIN_INSET;
    bounded = true;
  }
  for (const b of guideGeometry(ids, aspect).boxes) {
    bounded = true;
    if (b.w >= 0.99) {
      if (b.y <= 0.01) top = Math.max(top, b.y + b.h);
      else bottom = Math.min(bottom, b.y);
    } else if (b.x + b.w >= 0.99) right = Math.min(right, b.x);
    else if (b.x <= 0.01) left = Math.max(left, b.x + b.w);
  }
  if (!bounded) return null;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
}
