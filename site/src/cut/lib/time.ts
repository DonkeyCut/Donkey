import type { Locale } from "@/i18n/locales";

/** Whole days left until an ISO timestamp, floored at zero — anything inside
 * the last day reads as 0, so "today" means today. */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

// English reads the narrow style ("5m ago"); elsewhere the narrow style can
// drop the words entirely (French "-5 min"), so the other languages read the
// short one ("il y a 5 min").
const RELATIVE_STYLE: Partial<Record<Locale, Intl.RelativeTimeFormatStyle>> = { en: "narrow" };
const RELATIVE = new Map<Locale, Intl.RelativeTimeFormat>();

function relativeFormats(locale: Locale) {
  let formats = RELATIVE.get(locale);
  if (!formats) {
    formats = new Intl.RelativeTimeFormat(locale, { style: RELATIVE_STYLE[locale] ?? "short" });
    RELATIVE.set(locale, formats);
  }
  return formats;
}

/** A moment as a shelf reads it: `justNow` (the caller's catalog line) for the
 * last minute, minutes and hours while it is recent, then the calendar date,
 * with the year only once it is not this one. */
export function formatDate(ts: number, locale: Locale, justNow: string) {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60000);
  const relative = relativeFormats(locale);
  if (mins < 1) return justNow;
  if (mins < 60) return relative.format(-mins, "minute");
  if (mins < 60 * 24) return relative.format(-Math.floor(mins / 60), "hour");
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Elapsed wall-clock as "m:ss" — 63400ms -> "1:03". */
export function formatElapsed(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** 63.4 -> "1:03.4"  |  8.02 -> "0:08.0" */
export function formatTime(t: number) {
  const clamped = Math.max(0, t);
  const m = Math.floor(clamped / 60);
  const s = clamped - m * 60;
  const whole = Math.floor(s);
  const tenth = Math.floor((s - whole) * 10);
  return `${m}:${String(whole).padStart(2, "0")}.${tenth}`;
}

/** Full timecode for the transport readout: "0:14.23" (hundredths). */
export function formatTimecode(t: number) {
  const clamped = Math.max(0, t);
  const m = Math.floor(clamped / 60);
  const s = clamped - m * 60;
  const whole = Math.floor(s);
  const hund = Math.floor((s - whole) * 100);
  return `${m}:${String(whole).padStart(2, "0")}.${String(hund).padStart(2, "0")}`;
}
