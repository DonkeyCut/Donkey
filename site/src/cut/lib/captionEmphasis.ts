/**
 * Which words of a caption are emphasized, and how that survives edits.
 *
 * A cue keeps its emphasis as indices into its display words — the text split
 * on whitespace, the same indexing the word timings and the word effects use.
 * A timing change never moves a word, so retiming and alignment carry the
 * indices untouched. A change to the words themselves is where an index could
 * end up on the wrong word, so every path that rewrites a cue's text runs it
 * through one of the functions here: a split takes a slice, a merge appends,
 * and a rewrite lines the old words up against the new ones and keeps the
 * emphasis on every word that is still there.
 *
 * The indices live on the cue and the word timings stay optional, so a caption
 * with no measured words (a rewrite, a translation, a hand-typed line) can
 * still have a word set apart.
 */

import { displayWords } from "@donkeycut/effects-kit";
import type { SubtitleCue } from "./types";

/** A cue's emphasized word indices, ascending, each one a word the text still
 * has. */
export function cueEmphasis(cue: Pick<SubtitleCue, "text" | "emphasis">): number[] {
  const marked = cue.emphasis;
  if (!marked?.length) return [];
  const n = displayWords(cue.text).length;
  const out: number[] = [];
  for (const i of [...marked].sort((a, b) => a - b)) {
    if (Number.isInteger(i) && i >= 0 && i < n && out[out.length - 1] !== i) out.push(i);
  }
  return out;
}

/** The cue with `indices` set on or off; `on` absent flips each one. */
export function toggleEmphasis(
  cue: SubtitleCue,
  indices: readonly number[],
  on?: boolean
): SubtitleCue {
  const marked = new Set(cueEmphasis(cue));
  for (const i of indices) {
    const want = on ?? !marked.has(i);
    if (want) marked.add(i);
    else marked.delete(i);
  }
  return withEmphasis(cue, cueEmphasis({ text: cue.text, emphasis: [...marked] }));
}

/** The cue carrying exactly `marked`, the field absent when nothing is. */
export function withEmphasis(cue: SubtitleCue, marked: readonly number[]): SubtitleCue {
  const out: SubtitleCue = { ...cue };
  delete out.emphasis;
  if (marked.length > 0) out.emphasis = [...marked];
  return out;
}

/** The emphasis of words [from, to) of a cue, re-indexed from 0. */
function sliceEmphasis(marked: readonly number[], from: number, to: number): number[] {
  return marked.filter((i) => i >= from && i < to).map((i) => i - from);
}

/** A split's two halves of `cue`'s emphasis: the left takes the marks of its
 * first words, the right those of its last. A word cut in two is in both
 * halves, so both pieces keep its mark. */
export function splitEmphasis(
  cue: Pick<SubtitleCue, "text" | "emphasis">,
  leftText: string,
  rightText: string
): [number[], number[]] {
  const marked = cueEmphasis(cue);
  const from = Math.max(0, displayWords(cue.text).length - displayWords(rightText).length);
  return [sliceEmphasis(marked, 0, displayWords(leftText).length), sliceEmphasis(marked, from, Infinity)];
}

/** A merge's emphasis: `first`'s marks, then `second`'s after its words. */
export function mergeEmphasis(
  first: Pick<SubtitleCue, "text" | "emphasis">,
  second: Pick<SubtitleCue, "text" | "emphasis">
): number[] {
  const count = displayWords(first.text).length;
  return [...cueEmphasis(first), ...cueEmphasis(second).map((i) => i + count)];
}

/** A cue's emphasized words as [index, word] pairs. */
export function emphasizedWords(cue: Pick<SubtitleCue, "text" | "emphasis">): [number, string][] {
  const marked = cueEmphasis(cue);
  if (marked.length === 0) return [];
  const words = displayWords(cue.text);
  return marked.map((i) => [i, words[i]]);
}

/** What a toggle over characters [from, to) of `typed` — the caption's text
 * as it is on screen, maybe not yet saved — would do: the words it names,
 * whether it turns them on, and their label. The cue's saved emphasis is
 * carried onto the typed words first, so the answer is about the words the
 * person sees. Null when the range touches no word. */
export function typedToggle(
  cue: Pick<SubtitleCue, "text" | "emphasis">,
  typed: string,
  from: number,
  to: number
): { indices: number[]; on: boolean; label: string } | null {
  const indices = wordIndicesIn(typed, from, to);
  if (indices.length === 0) return null;
  const marked = new Set(remapEmphasis(cue.text, typed, cueEmphasis(cue)));
  const words = displayWords(typed);
  return {
    indices,
    on: !indices.every((i) => marked.has(i)),
    label: indices.map((i) => words[i]).join(" "),
  };
}

/** A word reduced to what identifies it across a rewrite: case and the
 * punctuation hugging it are dropped, so "Figma," still lines up with
 * "figma". */
const tokenKey = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/**
 * The emphasis carried from `before` to `after`: the two word lists are lined
 * up by their longest common run of words, and each emphasized word that is
 * still there keeps its emphasis at its new index. A word that was replaced or
 * removed loses it; a word that was added has none.
 */
export function remapEmphasis(
  before: string,
  after: string,
  marked: readonly number[]
): number[] {
  if (marked.length === 0) return [];
  const a = displayWords(before).map(tokenKey);
  const b = displayWords(after).map(tokenKey);
  // Longest common subsequence over the words: lcs[i][j] is the match length
  // of a[i..] against b[j..]. Captions are a dozen words, so the table is tiny.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0)
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const want = new Set(marked);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      if (want.has(i)) out.push(j);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/** The word indices `words` names inside a cue, matched against that cue's
 * own display words exactly as stored (case and hugging punctuation aside).
 * A word that appears more than once matches every occurrence. Unknown words
 * come back in `missing`. */
export function emphasisIndicesOf(
  cue: Pick<SubtitleCue, "text">,
  words: readonly string[]
): { indices: number[]; missing: string[] } {
  const tokens = displayWords(cue.text).map(tokenKey);
  const indices: number[] = [];
  const missing: string[] = [];
  for (const w of words) {
    const key = tokenKey(w);
    let hit = false;
    tokens.forEach((t, i) => {
      if (key && t === key) {
        indices.push(i);
        hit = true;
      }
    });
    if (!hit) missing.push(w);
  }
  return { indices, missing };
}

/** Where each display word of `text` starts and ends, in characters. */
function wordSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/** The display words a character range of `text` touches — a selection in
 * the transcript editor. A collapsed range names the word the caret is in or
 * against, and the next word when it sits in the space between two. */
export function wordIndicesIn(text: string, from: number, to: number): number[] {
  const spans = wordSpans(text);
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  if (a === b) {
    const hit = spans.findIndex((s) => a >= s.start && a <= s.end);
    if (hit >= 0) return [hit];
    const next = spans.findIndex((s) => s.start > a);
    return next >= 0 ? [next] : spans.length > 0 ? [spans.length - 1] : [];
  }
  return spans.flatMap((s, i) => (s.start < b && s.end > a ? [i] : []));
}

/** The caption's text cut into runs for drawing it with its emphasized words
 * marked: whitespace and plain words in plain runs, each emphasized word in a
 * run of its own. Joined back together the runs are the text exactly. */
export function emphasisRuns(
  text: string,
  marked: readonly number[]
): { text: string; em: boolean }[] {
  if (marked.length === 0) return [{ text, em: false }];
  const want = new Set(marked);
  const out: { text: string; em: boolean }[] = [];
  let at = 0;
  wordSpans(text).forEach((s, i) => {
    if (!want.has(i)) return;
    if (s.start > at) out.push({ text: text.slice(at, s.start), em: false });
    out.push({ text: text.slice(s.start, s.end), em: true });
    at = s.end;
  });
  if (at < text.length) out.push({ text: text.slice(at), em: false });
  return out;
}
