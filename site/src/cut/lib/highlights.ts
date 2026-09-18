import { askJudgeChunked, noul, score } from "./judge";
import type { Entry, NoulAnswer, ScoreAnswer } from "./judge";
import type { PostFn } from "./pi/donkeyStream";
import type { Settings } from "@/lib/config/registry";

export type CutClipSettings = Settings["cutClip"];

/** Finding the moments in a long source worth cutting a short from.
 *
 * A talk holds a handful of stretches that stand on their own and an hour of
 * material that only makes sense in place. Which is which is a judgment about
 * meaning, so it goes to the judge; everything around it — where a sentence
 * ends, which windows are worth asking about, how the winners are picked so
 * they do not overlap — is arithmetic and stays in code.
 *
 * The pass is a cascade, because asking about every window of an hour would
 * be thousands of questions: a wide cheap sweep scores one window per stride,
 * then the shortlist earns the expensive questions (does it stand alone, does
 * the opening hold, does it land) and a few boundary variants each. Code
 * composes the weights and picks the non-overlapping winners, so changing what
 * "best" means is a settings change, not another round of inference.
 *
 * A clip does not have to be one stretch. Two moments that belong together
 * cut together, and the judge says which pairs those are; the spans come back
 * in source seconds for the caller to place.
 */

export interface SpeechSegment {
  start: number;
  end: number;
  text: string;
}

/** A stretch of the source, with what is said over it. */
export interface HighlightSpan {
  from: number;
  to: number;
  text: string;
}

export interface ScoredHighlight extends HighlightSpan {
  /** The composite under the settings' weights, 0..1. */
  rank: number;
  /** Stands on its own with nothing before it, 0..1. */
  standalone: number;
  /** How hard the opening holds someone who just landed on it, 0..1. */
  hook: number;
  /** Lands a complete thought by the end, 0..1. */
  payoff: number;
}

/** A clip, in the order its parts play. One span is the ordinary case; more
 * than one is two moments that belong together with the middle dropped. */
export interface HighlightClip {
  spans: HighlightSpan[];
  rank: number;
  seconds: number;
}

// A sentence break: terminal punctuation, then white space, then something
// that starts a sentence. The look-ahead is what keeps "4.5%" and "U.S." in
// one piece. A pause long enough to start something new breaks a unit too.
// Both are structure, and structure is all this does — the judge does the
// meaning. What is left over when the words run out is the last unit.
const SENTENCE_BREAK = /[.!?]["')\]]?\s+(?=[A-Z0-9"'(\[])/g;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Transcript segments folded into sentences. A recognizer cuts its segments
 * where it pleases — mid-clause, mid-breath, and often with two sentences
 * inside one — and a clip cut on one of those edges opens or closes
 * mid-thought.
 *
 * A sentence that ends inside a segment takes its time from where it ends in
 * the words: within one segment, time runs with the characters. That is an
 * approximation of a word clock, and it is the one a caption track is drawn
 * on anyway. */
export function sentences(segs: SpeechSegment[], pauseBreak: number): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  // The running text, with each segment's char range and the time it covers.
  let buf = "";
  let spans: { at: number; len: number; start: number; end: number }[] = [];

  const timeAt = (i: number): number => {
    for (const sp of spans) {
      if (i <= sp.at + sp.len)
        return sp.start + ((Math.max(i, sp.at) - sp.at) / Math.max(1, sp.len)) * (sp.end - sp.start);
    }
    const last = spans[spans.length - 1];
    return last ? last.end : 0;
  };
  const emit = (upTo: number) => {
    const text = buf.slice(0, upTo).trim();
    if (text) out.push({ start: timeAt(buf.length - buf.trimStart().length), end: timeAt(upTo), text });
    buf = buf.slice(upTo);
    const shift = upTo;
    spans = spans
      .map((sp) => ({ ...sp, at: sp.at - shift }))
      .filter((sp) => sp.at + sp.len > 0);
  };

  let prevEnd: number | null = null;
  for (const s of segs) {
    const text = s.text.trim();
    if (!text || !(s.end > s.start)) continue;
    if (prevEnd !== null && s.start - prevEnd >= pauseBreak) emit(buf.length);
    if (buf && !buf.endsWith(" ")) buf += " ";
    spans.push({ at: buf.length, len: text.length, start: s.start, end: s.end });
    buf += text;
    prevEnd = s.end;
    // Every finished sentence in the buffer comes out; the unfinished tail
    // stays for the next segment to continue.
    for (;;) {
      SENTENCE_BREAK.lastIndex = 0;
      const m = SENTENCE_BREAK.exec(buf);
      if (!m) break;
      emit(m.index + m[0].length);
    }
  }
  emit(buf.length);
  return out;
}

const textOf = (units: SpeechSegment[], i: number, j: number) =>
  units
    .slice(i, j + 1)
    .map((u) => u.text)
    .join(" ");

/** The window starting at unit `i` that runs closest to `target` seconds
 * without passing `max`, ending on a sentence. Null when what is left is
 * shorter than `min`. */
function windowAt(
  units: SpeechSegment[],
  i: number,
  min: number,
  target: number,
  max: number
): { i: number; j: number; from: number; to: number } | null {
  const from = units[i].start;
  let best = -1;
  for (let j = i; j < units.length; j++) {
    const len = units[j].end - from;
    if (len > max) break;
    if (len >= min) {
      best = j;
      if (len >= target) break;
    }
  }
  if (best < 0) return null;
  return { i, j: best, from, to: units[best].end };
}

/** One window per stride across the whole source, each opening and closing on
 * a sentence. The stride is what keeps an hour's worth of starts down to a
 * sweep the judge can answer in a few requests; the shortlist gets its
 * boundaries refined afterwards. */
export function highlightCandidates(
  segs: SpeechSegment[],
  settings: CutClipSettings
): HighlightSpan[] {
  const units = sentences(segs, settings.pauseBreakSeconds);
  const out: HighlightSpan[] = [];
  let lastStart = -Infinity;
  for (let i = 0; i < units.length; i++) {
    if (units[i].start - lastStart < settings.strideSeconds) continue;
    const w = windowAt(units, i, settings.minSeconds, settings.targetSeconds, settings.maxSeconds);
    if (!w) continue;
    lastStart = w.from;
    out.push({ from: round2(w.from), to: round2(w.to), text: textOf(units, w.i, w.j) });
  }
  return out;
}

// Where a clip starts decides whether anyone stays for it, and the stride
// that found the window was never aimed at that. The start reaches further
// back than forward: a stretch that opens mid-answer is rescued by the
// question in front of it, and nothing later can stand in for that.
const START_SHIFTS = [0, -1, -2, 1];
const END_SHIFTS = [0, -1, 1];

/** The variants of a shortlisted window worth asking about: the same stretch
 * opened and closed a sentence or two either side of where the sweep put it. */
function variantsOf(
  units: SpeechSegment[],
  span: HighlightSpan,
  settings: CutClipSettings
): HighlightSpan[] {
  const i = units.findIndex((u) => Math.abs(u.start - span.from) < 0.05);
  const j = units.findIndex((u) => Math.abs(u.end - span.to) < 0.05);
  if (i < 0 || j < 0) return [span];
  const out: HighlightSpan[] = [];
  const seen = new Set<string>();
  for (const di of START_SHIFTS) {
    for (const dj of END_SHIFTS) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b >= units.length || b < a) continue;
      const len = units[b].end - units[a].start;
      if (len < settings.minSeconds || len > settings.maxSeconds) continue;
      const key = `${a}:${b}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        from: round2(units[a].start),
        to: round2(units[b].end),
        text: textOf(units, a, b),
      });
    }
  }
  return out.length > 0 ? out : [span];
}

const TEXT_CAP = 3000;
const SWEEP_CHUNK = 50;

/** The judgments this pass is built on, in one place so the eval asks exactly
 * what the tool asks. Each takes the index of the item it is about, because a
 * fan-out names every candidate in one request. */
export const CLIP_QUESTIONS = {
  standsAlone: () => STANDS_ALONE,
  alone: (i: number) =>
    noul(`Does variant ${i} in \`variants\` make sense to someone who sees nothing before or after it?`, {
      true: "It introduces whatever it talks about and resolves it inside the clip.",
      false:
        "It opens on a pronoun, a name or an idea the listener has not been given, or answers a question that was asked before it starts.",
    }),
  hook: (i: number) =>
    noul(`Would the first sentence of variant ${i} in \`variants\` hold someone who is scrolling?`, {
      true: "It opens on a claim, a number, a turn of phrase or a question that makes the next sentence worth hearing.",
      false: "It opens on throat-clearing, an aside, a transition, or a setup whose point is far away.",
    }),
  lands: (i: number) =>
    noul(`Is variant ${i} in \`variants\` over by the time it ends — is its last sentence the end of the thing it was about?`, {
      true: "It closes on the point it was making: the conclusion, the turn, the last beat of the idea it opened with.",
      false:
        "By the end the speaker has moved on to something else, or it breaks off mid-argument. Ending on a complete sentence is not the same as being over.",
    }),
  follows: (i: number) =>
    noul(
      `In \`pairs\`, does part B of pair ${i} belong with part A as the second half of one clip, with everything between them cut out?`,
      {
        true: "B carries A further — the example after the claim, the answer after the question, the turn after the setup — and the jump between them reads as an edit.",
        false:
          "B repeats A, contradicts its footing, or is about something else, so the two together read as two clips stuck end to end.",
      },
    ),
} as const;

const STANDS_ALONE = score(
  "How well does the stretch of talk in `candidate` work as a short clip on its own, for someone who lands on it with no idea what came before?",
  [
    "It cannot be understood alone: it opens on a pronoun or a reference to something said earlier, answers a question nobody heard, or is the middle of an argument.",
    "It is followable but flat: accurate, unremarkable, the kind of stretch that fills the space between the parts people quote.",
    "It holds one clear idea from beginning to end and would read as deliberate to someone who saw nothing else.",
    "It is the part people quote: one sharp idea, stated plainly, that pays off inside the clip itself.",
  ]
);

/** The levels that score runs over, so a caller can turn a position on it back
 * into 0..1 the way the sweep does. */
export const STANDS_ALONE_LEVELS = STANDS_ALONE.criteria.length;

/** The wide sweep: one question per candidate, over the whole source. */
async function sweep(
  post: PostFn,
  candidates: HighlightSpan[],
  signal?: AbortSignal
): Promise<number[]> {
  if (candidates.length === 0) return [];
  const questions = Object.fromEntries(candidates.map((_, i) => [`clip::${i}`, STANDS_ALONE]));
  const state = (keys: string[]): Entry => ({
    candidates: keys.map((k) => {
      const i = Number(k.slice("clip::".length));
      return { i, seconds: round2(candidates[i].to - candidates[i].from), said: candidates[i].text.slice(0, TEXT_CAP) };
    }),
  });
  const answers = (await askJudgeChunked(post, state, questions, SWEEP_CHUNK, signal)) as Record<
    string,
    ScoreAnswer
  >;
  // A score's levels are ordered, so its position maps straight onto 0..1.
  const top = STANDS_ALONE_LEVELS - 1;
  return candidates.map((_, i) => (answers[`clip::${i}`]?.score ?? 0) / top);
}

/** Non-overlapping winners, best first. A source gives up a handful of real
 * moments; the rest of a ranked list is the same moment shifted by a sentence. */
function pickDistinct<T extends HighlightSpan & { rank: number }>(scored: T[], count: number): T[] {
  const out: T[] = [];
  for (const s of [...scored].sort((a, b) => b.rank - a.rank)) {
    if (out.length >= count) break;
    if (out.some((k) => s.from < k.to && k.from < s.to)) continue;
    out.push(s);
  }
  return out;
}

/** The close read of one shortlisted window and its boundary variants: does it
 * stand alone, does the opening hold, does it land. */
async function judgeVariants(
  post: PostFn,
  variants: HighlightSpan[],
  signal?: AbortSignal
): Promise<ScoredHighlight[]> {
  const questions: Record<string, ReturnType<typeof noul>> = {};
  for (let i = 0; i < variants.length; i++) {
    questions[`alone::${i}`] = CLIP_QUESTIONS.alone(i);
    questions[`hook::${i}`] = CLIP_QUESTIONS.hook(i);
    questions[`lands::${i}`] = CLIP_QUESTIONS.lands(i);
  }
  // Each request carries only the variants its own questions are about. The
  // fan-out splits by question, and three of them share one variant, so a
  // state built from every variant would ship the whole shortlist's words in
  // every chunk — a shortlist of a long talk, eleven times over.
  const state = (keys: string[]): Entry => {
    const wanted = [...new Set(keys.map((k) => Number(k.split("::")[1])))].sort((a, b) => a - b);
    return {
      variants: wanted.map((i) => ({
        i,
        seconds: round2(variants[i].to - variants[i].from),
        said: variants[i].text.slice(0, TEXT_CAP),
      })),
    };
  };
  const answers = (await askJudgeChunked(post, state, questions, SWEEP_CHUNK, signal)) as Record<
    string,
    NoulAnswer
  >;
  return variants.map((v, i) => ({
    ...v,
    standalone: answers[`alone::${i}`]?.noul ?? 0,
    hook: answers[`hook::${i}`]?.noul ?? 0,
    payoff: answers[`lands::${i}`]?.noul ?? 0,
    rank: 0,
  }));
}

/** The composite. Weights live in settings, so what "best" means is tuned
 * without asking anything again. */
export function rankOf(h: Omit<ScoredHighlight, "rank">, settings: CutClipSettings): number {
  const w = settings.standaloneWeight + settings.hookWeight + settings.payoffWeight;
  if (w <= 0) return 0;
  return (
    (h.standalone * settings.standaloneWeight +
      h.hook * settings.hookWeight +
      h.payoff * settings.payoffWeight) /
    w
  );
}

/** Pairs worth cutting together: a second beat that belongs with the first,
 * with whatever sat between them dropped. */
async function judgePairs(
  post: PostFn,
  picked: ScoredHighlight[],
  pool: ScoredHighlight[],
  settings: CutClipSettings,
  signal?: AbortSignal
): Promise<Map<number, ScoredHighlight>> {
  const pairs: { a: number; b: ScoredHighlight }[] = [];
  for (let a = 0; a < picked.length; a++) {
    const others = pool
      .filter((p) => p.from >= picked[a].to || p.to <= picked[a].from)
      .filter((p) => picked[a].to - picked[a].from + (p.to - p.from) <= settings.maxSeconds)
      .sort((x, y) => y.rank - x.rank)
      .slice(0, settings.pairsPerClip);
    for (const b of others) pairs.push({ a, b });
  }
  if (pairs.length === 0) return new Map();
  const questions = Object.fromEntries(pairs.map((_, i) => [`pair::${i}`, CLIP_QUESTIONS.follows(i)]));
  const state = (keys: string[]): Entry => ({
    pairs: keys.map((k) => {
      const i = Number(k.slice("pair::".length));
      return {
        i,
        A: picked[pairs[i].a].text.slice(0, TEXT_CAP),
        B: pairs[i].b.text.slice(0, TEXT_CAP),
      };
    }),
  });
  const answers = (await askJudgeChunked(post, state, questions, SWEEP_CHUNK, signal)) as Record<
    string,
    NoulAnswer
  >;
  const best = new Map<number, { p: number; span: ScoredHighlight }>();
  pairs.forEach((pair, i) => {
    const p = answers[`pair::${i}`]?.noul ?? 0;
    if (p < settings.followsFloor) return;
    const cur = best.get(pair.a);
    if (!cur || p > cur.p) best.set(pair.a, { p, span: pair.b });
  });
  return new Map([...best].map(([a, v]) => [a, v.span]));
}

/** The whole pass: every window scored cheaply, the shortlist read closely
 * with its boundaries refined, the winners picked apart from one another, and
 * each offered a second beat. Source seconds throughout. */
export async function findHighlights(
  post: PostFn,
  segs: SpeechSegment[],
  settings: CutClipSettings,
  count: number,
  signal?: AbortSignal
): Promise<HighlightClip[]> {
  const units = sentences(segs, settings.pauseBreakSeconds);
  const candidates = highlightCandidates(segs, settings);
  if (candidates.length === 0) return [];
  const coarse = await sweep(post, candidates, signal);
  const shortlist = pickDistinct(
    candidates.map((c, i) => ({ ...c, rank: coarse[i] })),
    Math.max(count, settings.shortlist)
  );
  const variants = shortlist.flatMap((s) => variantsOf(units, s, settings));
  const judged = (await judgeVariants(post, variants, signal)).map((h) => ({
    ...h,
    rank: rankOf(h, settings),
  }));
  // Two of the three judgments are gates, not weights. A stretch that leans on
  // what came before it, or that stops rather than finishes, is not a clip —
  // and a strong opening is exactly what would otherwise carry one past the
  // composite, because an opening is what a hook measures.
  const picked = pickDistinct(
    judged.filter(
      (h) =>
        h.standalone >= settings.standaloneFloor &&
        h.payoff >= settings.payoffFloor &&
        h.rank >= settings.rankFloor
    ),
    count
  );
  const seconds = (spans: HighlightSpan[]) => round2(spans.reduce((n, s) => n + s.to - s.from, 0));
  if (picked.length === 0) return [];
  const partners = await judgePairs(post, picked, judged, settings, signal);
  return picked.map((p, i) => {
    const b = partners.get(i);
    const spans = b ? [p, b].sort((x, y) => x.from - y.from) : [p];
    return { spans, rank: round2(p.rank), seconds: seconds(spans) };
  });
}
