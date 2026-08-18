/**
 * Syncing known text to a recording: the user has the lyrics (or the script)
 * and the audio, and wants the words on screen at the moment they are sung.
 *
 * The transcript says WHEN with good timing and WHAT with poor accuracy —
 * singing, doubled vocals and music defeat a recognizer. The user's text says
 * WHAT exactly. So the two are aligned word by word, the user's text is kept
 * verbatim, and the transcript is used only for its clock. Words the
 * recognizer missed take interpolated times between the words around them,
 * which is why a line still lands even when half of it went unheard.
 */

export interface TimedWord {
  t0: number;
  t1: number;
  w: string;
}

export interface TimedLine {
  start: number;
  end: number;
  text: string;
  words?: TimedWord[];
}

/** Comparison form of a word: letters, digits and nothing else. Apostrophes
 * go too, so "don't" and "dont" are the same word. */
const norm = (w: string): string =>
  w
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]/gu, "");

const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;

/**
 * Word-for-word alignment of `a` onto `b` (Needleman–Wunsch), returning for
 * each index of `a` the index it matched in `b`, or -1. Only real matches
 * (equal normalized words) are reported, so a mismatched pair the aligner
 * carried through for the sake of the path never claims a time.
 */
export function alignWords(a: string[], b: string[]): number[] {
  const n = a.length;
  const m = b.length;
  const out = new Array<number>(n).fill(-1);
  if (n === 0 || m === 0) return out;
  // Score matrix in one flat array: (n+1) x (m+1).
  const w = m + 1;
  const score = new Float32Array((n + 1) * w);
  for (let i = 1; i <= n; i++) score[i * w] = i * GAP;
  for (let j = 1; j <= m; j++) score[j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * w + (j - 1)] + (a[i - 1] === b[j - 1] ? MATCH : MISMATCH);
      const up = score[(i - 1) * w + j] + GAP;
      const left = score[i * w + (j - 1)] + GAP;
      score[i * w + j] = Math.max(diag, up, left);
    }
  }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = score[i * w + j];
    const diag = score[(i - 1) * w + (j - 1)] + (a[i - 1] === b[j - 1] ? MATCH : MISMATCH);
    if (here === diag) {
      if (a[i - 1] === b[j - 1]) out[i - 1] = j - 1;
      i--;
      j--;
    } else if (here === score[(i - 1) * w + j] + GAP) {
      i--;
    } else {
      j--;
    }
  }
  return out;
}

const MIN_LINE_S = 0.4;

/**
 * The user's lines, timed against a transcript of the same audio. Lines come
 * back in order, non-overlapping, inside [from, to], each carrying per-word
 * times so a karaoke highlight has something to follow.
 */
export function syncLines(
  lines: string[],
  transcript: TimedWord[],
  span: { from: number; to: number }
): TimedLine[] {
  const kept = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (kept.length === 0) return [];
  const from = Math.max(0, Math.min(span.from, span.to));
  const to = Math.max(span.from, span.to);

  // Every lyric word, flat, remembering the line it came from.
  const flat: { line: number; raw: string; key: string }[] = [];
  kept.forEach((line, li) => {
    for (const raw of line.split(/\s+/)) {
      const key = norm(raw);
      if (key.length > 0) flat.push({ line: li, raw, key });
    }
  });
  const heard = transcript
    .filter((x) => x.t1 > x.t0 - 1e-6 && norm(x.w).length > 0)
    .sort((x, y) => x.t0 - y.t0);
  const matched = alignWords(
    flat.map((f) => f.key),
    heard.map((h) => norm(h.w))
  );

  // Anchored times, then interpolation across the words nobody heard: the
  // gap between two anchors is split evenly, and the head and tail of the
  // song run off the span's own edges.
  const t0 = new Array<number>(flat.length).fill(NaN);
  const t1 = new Array<number>(flat.length).fill(NaN);
  for (let k = 0; k < flat.length; k++) {
    const j = matched[k];
    if (j >= 0) {
      t0[k] = heard[j].t0;
      t1[k] = Math.max(heard[j].t1, heard[j].t0 + 0.05);
    }
  }
  const anchors = t0.map((v, k) => (Number.isNaN(v) ? -1 : k)).filter((k) => k >= 0);
  if (anchors.length === 0) {
    // Nothing was recognized: spread the lines evenly over the span so the
    // user still gets a timed draft to nudge.
    const each = Math.max(MIN_LINE_S, (to - from) / kept.length);
    return kept.map((text, i) => ({
      start: round2(from + i * each),
      end: round2(Math.min(to, from + (i + 1) * each)),
      text,
    }));
  }
  const fill = (loK: number, hiK: number, loT: number, hiT: number) => {
    const steps = hiK - loK;
    if (steps <= 0) return;
    const step = (hiT - loT) / steps;
    for (let k = loK + 1; k < hiK; k++) {
      t0[k] = loT + step * (k - loK);
      t1[k] = t0[k] + step * 0.9;
    }
  };
  fill(-1, anchors[0], from, t0[anchors[0]]);
  for (let a = 0; a + 1 < anchors.length; a++)
    fill(anchors[a], anchors[a + 1], t1[anchors[a]], t0[anchors[a + 1]]);
  const last = anchors[anchors.length - 1];
  fill(last, flat.length, t1[last], to);
  if (Number.isNaN(t0[flat.length - 1])) {
    t0[flat.length - 1] = t1[last];
    t1[flat.length - 1] = to;
  }

  // Words back into their lines.
  const out: TimedLine[] = kept.map((text) => ({ start: NaN, end: NaN, text }));
  // Whether a line's last word was actually heard. A line that ends on
  // interpolated time has no real end — it would otherwise run to wherever
  // the interpolation reached, which on a source that outlasts the text is
  // the far end of the recording.
  const heardTail = kept.map(() => false);
  for (let k = 0; k < flat.length; k++) heardTail[flat[k].line] = matched[k] >= 0;
  for (let k = 0; k < flat.length; k++) {
    const line = out[flat[k].line];
    const wordT0 = clamp(t0[k], from, to);
    const wordT1 = clamp(Math.max(t1[k], wordT0 + 0.05), from, to);
    line.start = Number.isNaN(line.start) ? wordT0 : Math.min(line.start, wordT0);
    line.end = Number.isNaN(line.end) ? wordT1 : Math.max(line.end, wordT1);
    (line.words ??= []).push({ t0: round2(wordT0), t1: round2(wordT1), w: flat[k].raw });
  }

  // Order, no overlap, nothing shorter than a beat, nothing past the span.
  // The span itself is the outer bound: a line crowded against the end holds
  // for whatever room is left rather than running past `to`.
  let cursor = from;
  for (let i = 0; i < out.length; i++) {
    const line = out[i];
    if (Number.isNaN(line.start)) line.start = cursor;
    line.start = clamp(Math.max(line.start, cursor), from, Math.max(from, to - MIN_LINE_S));
    const nextStart = out[i + 1]?.start;
    const ceiling = Number.isNaN(nextStart ?? NaN) ? to : Math.min(to, nextStart ?? to);
    if (!(line.end > line.start)) line.end = line.start + MIN_LINE_S;
    // A line nobody was heard finishing holds for as long as it takes to
    // read, and no longer.
    if (!heardTail[i]) {
      const words = line.words?.length ?? line.text.split(/\s+/).length;
      line.end = Math.min(line.end, line.start + Math.max(1, 0.4 * words + 0.6));
    }
    line.end = clamp(
      Math.min(Math.max(line.end, line.start + MIN_LINE_S), Math.max(ceiling, line.start + MIN_LINE_S)),
      line.start,
      to
    );
    cursor = line.end;
    line.start = round2(line.start);
    line.end = round2(line.end);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
