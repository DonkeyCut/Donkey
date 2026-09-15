import type { ExportRange } from "./exportDelivery";
import { laneCues, laneHidden, subtitleLaneCount, trackLocale } from "./subtitles";
import type { SubtitleCue, SubtitlesBlock } from "./types";

// Captions as a file of their own, for the platforms that take one beside
// the video. SRT is the one they all read: numbered cues, a time span with a
// comma before the milliseconds, the text, a blank line.

/** `01:02:03,450` for 3723.45 seconds. */
function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const frac = ms % 1000;
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(h)}:${two(m)}:${two(s)},${String(frac).padStart(3, "0")}`;
}

/**
 * One track's cues as SRT text. With a range, only the cues inside it, timed
 * from the range's start, so the file lines up with a range export. A cue
 * that crosses an edge is cut at it.
 */
export function srtOf(cues: SubtitleCue[], range?: ExportRange): string {
  const from = range ? Math.max(0, range.start) : 0;
  const to = range ? range.end : Infinity;
  const lines: string[] = [];
  let n = 0;
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const start = Math.max(c.start, from);
    const end = Math.min(c.end, to);
    const text = c.text.trim();
    if (!(end > start) || !text) continue;
    n++;
    lines.push(String(n), `${srtTime(start - from)} --> ${srtTime(end - from)}`, text, "");
  }
  return lines.join("\n");
}

/** A caption file for each track the export burns in: its name carries the
 * track's language when the project has more than one. Empty when nothing
 * would be written. */
export function subtitleFiles(
  subs: SubtitlesBlock,
  baseName: string,
  range?: ExportRange
): { name: string; text: string }[] {
  const files: { name: string; text: string }[] = [];
  const lanes = subtitleLaneCount(subs);
  for (let lane = 0; lane < lanes; lane++) {
    if (laneHidden(subs, lane)) continue;
    const text = srtOf(laneCues(subs, lane), range);
    if (!text) continue;
    const suffix = lanes > 1 ? `.${trackLocale(subs, lane)}` : "";
    files.push({ name: `${baseName}${suffix}.srt`, text });
  }
  return files;
}
