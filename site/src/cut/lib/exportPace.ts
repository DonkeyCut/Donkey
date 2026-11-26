// How fast this device renders an export in the tab, learned from its own
// finished renders, and the time estimate the export dialog reads from it.

import type { ExportSettings } from "./exportClient";
import type { RenderTiming } from "./exportRender";

/** Where the device's pace is kept between sessions. The name changes with
 * the renderer's speed, so a pace learned from another renderer never sets
 * the estimate. */
const PACE_KEY = "cut-export-pace-2";

/** How much a new render moves the stored pace: half, so one odd render
 * (a tab in the background) fades after the next. */
const PACE_BLEND = 0.5;

const PIXELS_PER_MEGAPIXEL = 1_000_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** Estimates under a minute round to this many seconds ("~35 sec"). */
const SECOND_STEP = 5;

type FrameShape = Pick<ExportSettings, "width" | "height">;

const megapixels = (shape: FrameShape) => (shape.width * shape.height) / PIXELS_PER_MEGAPIXEL;

/** A finished render's pace: milliseconds per megapixel of one frame, across
 * every stage of the render. Null when the render drew nothing. */
export function paceOf(timing: RenderTiming, shape: FrameShape): number | null {
  const work = timing.frames * megapixels(shape);
  if (!(work > 0)) {
    return null;
  }

  const total = timing.audioMs + timing.prepareMs + timing.drawMs + timing.encodeMs + timing.finalizeMs;
  return total > 0 ? total / work : null;
}

/** The stored pace after a new render: the new one alone the first time, a
 * blend with the old one after. */
export function blendPace(stored: number | null, fresh: number): number {
  return stored === null ? fresh : stored * (1 - PACE_BLEND) + fresh * PACE_BLEND;
}

/** This device's pace, or null before its first tab render. */
export function readPace(): number | null {
  try {
    const pace = Number(localStorage.getItem(PACE_KEY));
    return Number.isFinite(pace) && pace > 0 ? pace : null;
  } catch {
    return null;
  }
}

/** Fold a finished tab render into this device's pace. */
export function recordPace(timing: RenderTiming, shape: FrameShape): void {
  const fresh = paceOf(timing, shape);
  if (fresh === null) {
    return;
  }

  try {
    localStorage.setItem(PACE_KEY, String(blendPace(readPace(), fresh)));
  } catch {
    // Storage is blocked or full; the dialog shows no time estimate.
  }
}

/** Milliseconds a tab render of `spanSec` seconds takes at this pace. */
export function estimateRenderMs(
  settings: Pick<ExportSettings, "width" | "height" | "fps">,
  spanSec: number,
  pace: number
): number {
  return Math.max(0, spanSec) * settings.fps * megapixels(settings) * pace;
}

/** A render time as the dialog shows it, in the reader's locale: "~35 sec",
 * "~2 min", "~1.5 hr". */
export function formatTimeEstimate(ms: number, locale: string): string {
  if (!(ms > 0)) {
    return "";
  }

  const time = (value: number, unit: "second" | "minute" | "hour", digits: number) =>
    `~${new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short", maximumFractionDigits: digits }).format(value)}`;
  const seconds = ms / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE - SECOND_STEP / 2) {
    return time(Math.max(SECOND_STEP, Math.round(seconds / SECOND_STEP) * SECOND_STEP), "second", 0);
  }

  const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return time(minutes, "minute", 0);
  }
  return time(minutes / MINUTES_PER_HOUR, "hour", 1);
}
