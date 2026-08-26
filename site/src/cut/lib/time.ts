/** Whole days left until an ISO timestamp, floored at zero — anything inside
 * the last day reads as 0, so "today" means today. */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

/** A moment as a shelf reads it: minutes and hours while it is recent, then
 * the calendar date, with the year only once it is not this one. */
export function formatDate(ts: number) {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, {
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
