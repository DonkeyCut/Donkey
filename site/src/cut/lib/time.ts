/** Whole days left until an ISO timestamp, floored at zero — anything inside
 * the last day reads as 0, so "today" means today. */
export function daysUntil(iso: string): number {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000));
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
