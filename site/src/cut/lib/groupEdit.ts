import { clampOverlayPos, isEffectOverlay, isShapeOverlay, isTextOverlay, type AudioClip, type Overlay, type VideoClip } from "./types";

/**
 * A multi-selection edits one field across every item it holds. A field reads
 * as one value when every item agrees and as mixed when they differ; a write
 * lands the same value on all of them.
 */
export type Shared<T> = { value: T; mixed: boolean };

export function sharedValue<T>(values: readonly T[], same: (a: T, b: T) => boolean = Object.is): Shared<T> {
  const first = values[0];
  return { value: first, mixed: values.some((v) => !same(v, first)) };
}

/** A mixed number shows its mean, so a slider thumb sits where the set sits. */
export function sharedNumber(values: readonly number[]): Shared<number> {
  if (!values.length) return { value: 0, mixed: false };
  const shared = sharedValue(values, (a, b) => Math.abs(a - b) < 1e-6);
  if (!shared.mixed) return shared;
  return { value: values.reduce((sum, v) => sum + v, 0) / values.length, mixed: true };
}

/** The selection's center: the middle of the box its item centers span. */
export function selectionCenter(items: readonly { x: number; y: number }[]): { x: number; y: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const it of items) {
    minX = Math.min(minX, it.x); maxX = Math.max(maxX, it.x);
    minY = Math.min(minY, it.y); maxY = Math.max(maxY, it.y);
  }
  return items.length ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 } : { x: 0.5, y: 0.5 };
}

/**
 * Move the whole selection so its center lands at the target, every item
 * keeping its offset. The move stops where the first item reaches the edge
 * an element can sit at, so the set never folds in on itself.
 */
export function selectionTranslation(
  items: readonly { x: number; y: number }[], target: { x: number; y: number },
): { dx: number; dy: number } {
  if (!items.length) return { dx: 0, dy: 0 };
  const center = selectionCenter(items);
  const lo = clampOverlayPos(0), hi = clampOverlayPos(1);
  const xs = items.map((it) => it.x), ys = items.map((it) => it.y);
  const dx = Math.max(lo - Math.min(...xs), Math.min(hi - Math.max(...xs), target.x - center.x));
  const dy = Math.max(lo - Math.min(...ys), Math.min(hi - Math.max(...ys), target.y - center.y));
  return { dx, dy };
}

/** "5 shapes · 4 titles": what a selection holds, by kind, in selection order. */
export function selectionSummary(items: { overlays: readonly Overlay[]; clips: readonly VideoClip[]; audios: readonly AudioClip[] }): string {
  const counts = new Map<string, number>();
  const bump = (name: string) => counts.set(name, (counts.get(name) ?? 0) + 1);
  for (let i = 0; i < items.clips.length; i++) bump("clip");
  for (const o of items.overlays) bump(isTextOverlay(o) ? "title" : isShapeOverlay(o) ? "shape" : isEffectOverlay(o) ? "effect" : "sticker");
  for (let i = 0; i < items.audios.length; i++) bump("audio clip");
  return [...counts].map(([name, n]) => `${n} ${name}${n === 1 ? "" : "s"}`).join(" · ");
}
