/** Fused frame/transcript timeline: kept frame times woven into the caption
 * cues on one clock, so the model reads precomputed alignment — each speech
 * span lists the frames that fall inside it, and longer silences become
 * frame-only spans. Matching frames to lines by eye misaligns on long
 * ranges; this join is exact. All times are source seconds, the same numbers
 * stamped on the sheet cells. */

export interface FusedSpan {
  start: number;
  end: number;
  text?: string;
  frames: number[];
}

/** A silence between cues must reach this length to earn its own span. */
const MIN_SILENCE_SPAN = 1.5;

export function fuseTimeline(
  frameTimes: number[],
  cues: { start: number; end: number; text: string }[],
  range: { from: number; to: number }
): FusedSpan[] {
  const spans: FusedSpan[] = [];
  const inRange = cues
    .map((c) => ({
      start: Math.max(c.start, range.from),
      end: Math.min(c.end, range.to),
      text: c.text.trim(),
    }))
    .filter((c) => c.end > c.start && c.text.length > 0)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let cursor = range.from;
  for (const c of inRange) {
    if (c.start - cursor >= MIN_SILENCE_SPAN) spans.push({ start: cursor, end: c.start, frames: [] });
    spans.push({ start: c.start, end: Math.max(c.end, c.start), text: c.text, frames: [] });
    cursor = Math.max(cursor, c.end);
  }
  if (range.to - cursor >= MIN_SILENCE_SPAN || spans.length === 0)
    spans.push({ start: cursor, end: range.to, frames: [] });

  for (const t of [...frameTimes].sort((a, b) => a - b)) {
    const hit =
      spans.find((sp) => sp.start <= t && t < sp.end) ??
      // A frame in a crack between spans attaches to the closest one.
      spans.reduce((best, sp) =>
        Math.min(Math.abs(t - sp.start), Math.abs(t - sp.end)) <
        Math.min(Math.abs(t - best.start), Math.abs(t - best.end))
          ? sp
          : best
      );
    hit.frames.push(t);
  }
  return spans;
}

const sec = (t: number) => `${Math.round(t * 100) / 100}s`;

/** Render spans as the tool-result text block. Only spans that carry speech
 * or frames earn a line. */
export function renderFusedTimeline(spans: FusedSpan[]): string {
  const lines: string[] = [];
  for (const sp of spans) {
    if (!sp.text && sp.frames.length === 0) continue;
    const head = `[${sec(sp.start)}–${sec(sp.end)}]`;
    const body = sp.text ? ` "${sp.text}"` : " (no speech)";
    const frames = sp.frames.length > 0 ? `  frames: ${sp.frames.map(sec).join(", ")}` : "";
    lines.push(head + body + frames);
  }
  return lines.join("\n");
}
