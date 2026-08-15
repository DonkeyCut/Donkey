import { parkedTransitions, totalDuration, track0Clips, useEditor } from "../store";

const r1 = (x: number) => Math.round(x * 10) / 10;

/** The project's current debris, one line each: transition bars playing
 * nothing, and items stranded past the end of the video. Read from the live
 * editor store, so it serves the page and a headless session alike. */
export function currentDebris(): string[] {
  const s = useEditor.getState();
  const lines: string[] = [];
  for (const t of parkedTransitions(s.clips, s.transitions)) {
    lines.push(
      `parked transition ${t.id} (${t.style}, ${r1(t.seconds)}s) at ${r1(t.start)}s — lines up with no cut, plays nothing`
    );
  }
  const end = totalDuration(track0Clips(s.clips));
  if (end > 0) {
    for (const o of s.overlays) {
      if (o.start >= end)
        lines.push(`overlay ${o.id} ("${"text" in o && o.text ? String(o.text).slice(0, 30) : o.kind}") starts at ${r1(o.start)}s, past the video's end at ${r1(end)}s`);
    }
    for (const a of s.audioClips) {
      if (a.start >= end)
        lines.push(`soundtrack clip ${a.id} starts at ${r1(a.start)}s, past the video's end at ${r1(end)}s`);
    }
  }
  return lines;
}
