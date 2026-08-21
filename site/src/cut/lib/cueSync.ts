/**
 * Re-timing what is already on the timeline onto the speech in the cut's mix.
 *
 * The transcriber's clock is only checked once, when captions are written. Everything
 * after that — a lyric sync's interpolated lines, a run of text cards built from
 * those cues, captions the user dragged, a track retimed by hand — carries times
 * nobody measured against the audio. This is the measurement: the same envelope
 * pass captions are snapped with (cueAlign.ts), run over any list of timed items,
 * with a report of what moved so the caller can say it out loud.
 *
 * The audio decides, and it declines often: a mix with no readable quiet, or one
 * whose speech doesn't line up with these times at all, moves nothing and says so.
 * A caller that can't tell "aligned, nothing needed moving" from "the audio had
 * nothing to say" would report a silent no-op as a fix.
 */

import { alignCues, type AlignCue } from "./cueAlign";

/** A move worth reporting. Below this the edge was already on the speech. */
const MOVED = 0.02;

export interface CueMove {
  index: number;
  start: number;
  end: number;
  /** How far the start travelled; negative is earlier. */
  shift: number;
}

export interface SyncReport<T extends AlignCue> {
  items: T[];
  /** False when the audio had nothing to testify to — digital silence, a wall
   * of music with no quiet in it, or speech that does not describe these times.
   * Nothing moved, and nothing about the timing was confirmed either. */
  evidence: boolean;
  moved: CueMove[];
  /** Seconds, over the items that moved. */
  medianShift: number;
  maxShift: number;
}

/**
 * `items` re-timed onto the speech in `samples`. Order, ids and every other
 * field ride through untouched; word timings follow the edge that moved.
 *
 * `reach` widens how far an edge may travel backward to meet a speech edge —
 * times that are guesses (interpolated lyric lines, a hand-dragged cue) earn a
 * wider one than a transcriber's own word ranges.
 */
export function syncToSpeech<T extends AlignCue>(
  items: T[],
  samples: ArrayLike<number>,
  rate: number,
  opts: { reach?: number } = {}
): SyncReport<T> {
  const empty = { items, evidence: false, moved: [], medianShift: 0, maxShift: 0 };
  if (items.length === 0 || rate <= 0) return empty;
  const aligned = alignCues(items, samples, rate, { snap: opts.reach });
  // alignCues hands back the very array it was given when the audio offers no
  // usable edges; anything else means it read the envelope and applied it.
  if (aligned === items) return empty;

  const moved: CueMove[] = [];
  aligned.forEach((next, i) => {
    const before = items[i];
    const shift = next.start - before.start;
    if (Math.abs(shift) >= MOVED || Math.abs(next.end - before.end) >= MOVED)
      moved.push({
        index: i,
        start: round2(next.start),
        end: round2(next.end),
        shift: round2(shift),
      });
  });
  const sizes = moved.map((m) => Math.abs(m.shift)).sort((a, b) => a - b);
  return {
    items: aligned,
    evidence: true,
    moved,
    medianShift: sizes.length > 0 ? round2(sizes[Math.floor(sizes.length / 2)]) : 0,
    maxShift: sizes.length > 0 ? round2(sizes[sizes.length - 1]) : 0,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The least room a re-timed item may be squeezed into before the move is
 * abandoned as not worth making. */
const MIN_LEN = 0.12;

/**
 * The subset of an aligned run that is safe to write on its own.
 *
 * A caller may align a whole row and write only part of it — the model named
 * a few ids. Each side of that is internally sound: the aligned run does not
 * overlap itself and neither does the run already on the timeline. The mix of
 * the two can, and items sharing a row may never overlap, so a partial write
 * is fitted to the neighbours it is landing between: the ones also being
 * written by their new times, the ones left alone by their old ones. What
 * still does not fit stays where it is rather than landing on top of a line
 * nobody asked to move.
 */
export function partialWrites<T extends AlignCue & { id: string }>(
  aligned: readonly T[],
  before: readonly { id: string; start: number; end: number }[],
  chosen: (item: T) => boolean
): T[] {
  const old = new Map(before.map((b) => [b.id, b]));
  const order = [...aligned].sort((a, b) => a.start - b.start);
  const out: T[] = [];
  // Where each item ends up: its aligned times when it is being written, the
  // times it already has when it is not.
  const settled = order.map((item) => {
    const prev = old.get(item.id);
    return chosen(item) || !prev ? { item, start: item.start, end: item.end, write: true } : { item, start: prev.start, end: prev.end, write: false };
  });
  for (const [i, row] of settled.entries()) {
    if (!row.write) continue;
    const floor = i > 0 ? settled[i - 1].end : 0;
    const ceil = i + 1 < settled.length ? settled[i + 1].start : Infinity;
    const start = Math.max(row.start, floor, 0);
    const end = Math.min(row.end, ceil);
    if (end - start < MIN_LEN) {
      // No room between the neighbours: leave this one where it was, and let
      // the ones after it fit against that.
      const prev = old.get(row.item.id);
      row.start = prev?.start ?? row.item.start;
      row.end = prev?.end ?? row.item.end;
      row.write = false;
      continue;
    }
    row.start = start;
    row.end = end;
    // Word timings follow the window they live in, so a cue squeezed by a
    // neighbour never highlights past its own edges.
    const words = row.item.words?.map((w) => ({
      ...w,
      t0: Math.min(Math.max(w.t0, start), end),
      t1: Math.min(Math.max(w.t1, start), end),
    }));
    out.push({ ...row.item, start, end, ...(words ? { words } : {}) });
  }
  return out;
}
