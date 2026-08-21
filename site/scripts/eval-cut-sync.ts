#!/usr/bin/env bun
/**
 * Caption timing eval: when the words appear, do they appear on the voice?
 *
 * A caption's timing has one truth — the moment the speaker actually says the
 * word — and no eyeball on a preview settles whether a line is 200ms late.
 * So the truth is built rather than measured: a script of lines with exact
 * onsets renders to audio, a transcriber's answer is simulated on top of it
 * with the errors real transcribers make, and the production timing path runs
 * over both. Every number below is |reported − true| in seconds.
 *
 * Two paths, the two ways words get times:
 *   captions — a transcript grouped into cues (server/transcribe.ts), then
 *              re-timed against the mix (lib/cueSync.ts → lib/cueAlign.ts).
 *   lyrics   — the user's own text aligned to a degraded transcript
 *              (lib/lyricSync.ts), then re-timed the same way. This is the
 *              path where half the words are never recognized, so most line
 *              times start out interpolated between the ones that were.
 *
 * Each case reports before and after the alignment pass, because the pass is
 * the thing on trial: if `after` is not better than `before`, reading the
 * waveform bought nothing. Budgets are enforced by default — this is a
 * regression guard, and it runs in a couple of seconds with no model, no
 * network, and no credits.
 *
 *   npm run eval:cut-sync [--only <case>] [--out path] [--no-enforce] [--verbose]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { syncToSpeech } from "../src/cut/lib/cueSync";
import { syncLines, type TimedWord } from "../src/cut/lib/lyricSync";
import { groupWords } from "../src/cut/server/transcribe";

const SITE = path.resolve(import.meta.dir, "..");
const REPORT = path.resolve(SITE, "..", "evals", "cut-sync.latest-report.json");

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ONLY = arg("--only");
const OUT = arg("--out") ?? REPORT;
const ENFORCE = !argv.includes("--no-enforce");
const VERBOSE = argv.includes("--verbose");

const RATE = 16000;

// ── Deterministic noise ─────────────────────────────────────────────────────
// Nothing here may vary run to run: a budget that trips one time in five is
// worse than no budget.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
};

// ── The truth ───────────────────────────────────────────────────────────────

interface TrueWord {
  line: number;
  w: string;
  start: number;
  end: number;
}

interface Script {
  words: TrueWord[];
  lines: { text: string; start: number; end: number }[];
  duration: number;
}

const WORDS =
  "the light came down over the harbour and nobody moved a hand until morning broke again on every quiet street we knew".split(
    " "
  );

/**
 * A script of `lines` lines, each a few words long, laid out with real
 * cadence: syllable-length words, a breath between them, a longer beat
 * between lines. `lead` is the silence before anyone speaks.
 */
function script(opts: {
  lines: number;
  wordsPerLine: number;
  wordGap: number;
  lineGap: number;
  lead: number;
  seed: number;
}): Script {
  const rnd = rng(opts.seed);
  const words: TrueWord[] = [];
  const lines: Script["lines"] = [];
  let t = opts.lead;
  for (let li = 0; li < opts.lines; li++) {
    const start = t;
    const text: string[] = [];
    for (let wi = 0; wi < opts.wordsPerLine; wi++) {
      const dur = 0.22 + Math.abs(rnd()) * 0.34;
      const w = WORDS[(li * opts.wordsPerLine + wi) % WORDS.length];
      words.push({ line: li, w, start: t, end: t + dur });
      text.push(w);
      t += dur + (wi + 1 < opts.wordsPerLine ? opts.wordGap : 0);
    }
    lines.push({ text: text.join(" "), start, end: t });
    t += opts.lineGap;
  }
  return { words, lines, duration: t + 1 };
}

/**
 * The script as audio: a burst per word, shaped like a syllable rather than a
 * flat block, over whatever floor the condition asks for. `bed` lays a steady
 * music-like tone under the whole thing — the case where quiet between lines
 * is the only edge the envelope can read.
 */
function render(s: Script, opts: { floorDb: number; bedDb?: number; seed: number }): Float32Array {
  const rnd = rng(opts.seed);
  const out = new Float32Array(Math.ceil(s.duration * RATE));
  const floor = Math.pow(10, opts.floorDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * floor;
  if (opts.bedDb !== undefined) {
    const bed = Math.pow(10, opts.bedDb / 20);
    for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * 110 * i) / RATE) * bed;
  }
  for (const w of s.words) {
    const from = Math.round(w.start * RATE);
    const to = Math.min(out.length, Math.round(w.end * RATE));
    const len = Math.max(1, to - from);
    for (let i = from; i < to; i++) {
      const p = (i - from) / len;
      // Attack, hold, decay — a word does not start and stop square.
      const env = Math.min(1, p / 0.12) * Math.min(1, (1 - p) / 0.2);
      // Two syllables' worth of amplitude wobble inside the word.
      const wobble = 0.7 + 0.3 * Math.sin(p * Math.PI * 4);
      out[i] += rnd() * 0.55 * env * wobble;
    }
  }
  return out;
}

// ── The transcriber's answer ────────────────────────────────────────────────

type Flaw = "lag" | "leadin" | "drift" | "clean";

/**
 * What a recognizer hands back for this audio. Every flaw here is one real
 * transcribers make: a constant lag, the silence before a sentence handed to
 * its first word, and a clock that drifts as a long chunk runs on.
 */
function heard(s: Script, flaw: Flaw): TimedWord[] {
  const out: TimedWord[] = [];
  for (const [i, w] of s.words.entries()) {
    let t0 = w.start;
    let t1 = w.end;
    if (flaw === "lag") {
      t0 += 0.25;
      t1 += 0.25;
    }
    if (flaw === "drift") {
      const k = (i / s.words.length) * 0.6;
      t0 += k;
      t1 += k;
    }
    if (flaw === "leadin" && s.words[i - 1] && s.words[i - 1].line !== w.line) {
      // The pause before the line is billed to the line's first word.
      t0 = s.words[i - 1].end;
    }
    if (flaw === "leadin" && i === 0) t0 = 0;
    out.push({ t0, t1, w: w.w });
  }
  return out;
}

/** A recognizer on singing: words missed outright, words misheard. */
function degrade(words: TimedWord[], opts: { drop: number; wrong: number; seed: number }): TimedWord[] {
  const rnd = rng(opts.seed);
  const out: TimedWord[] = [];
  for (const w of words) {
    const r = Math.abs(rnd()) * 2;
    if (r < opts.drop) continue;
    out.push(r < opts.drop + opts.wrong ? { ...w, w: `${w.w}zz` } : w);
  }
  return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const abs = (n: number) => Math.abs(n);
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const quantile = (xs: number[], q: number) =>
  xs.length === 0 ? 0 : round3([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]);

interface Score {
  lines: number;
  medianStart: number;
  p90Start: number;
  worstStart: number;
  within100ms: number;
  within250ms: number;
}

function score(got: { start: number }[], truth: { start: number }[]): Score {
  const errs = truth.map((t, i) => (got[i] ? abs(got[i].start - t.start) : Infinity));
  const finite = errs.filter((e) => Number.isFinite(e));
  return {
    lines: truth.length,
    medianStart: quantile(finite, 0.5),
    p90Start: quantile(finite, 0.9),
    worstStart: round3(Math.max(0, ...finite)),
    within100ms: round3(errs.filter((e) => e <= 0.1).length / errs.length),
    within250ms: round3(errs.filter((e) => e <= 0.25).length / errs.length),
  };
}

// ── Cases ───────────────────────────────────────────────────────────────────

interface Case {
  name: string;
  what: string;
  run: () => { before: Score; after: Score; evidence: boolean };
  /** Budgets on the aligned result. A case that breaks one fails the eval. */
  budget: { medianStart: number; p90Start: number; within250ms: number };
}

const clean = { floorDb: -60, seed: 3 };
const noisy = { floorDb: -38, seed: 5 };
const bed = { floorDb: -58, bedDb: -30, seed: 9 };

/** The caption path: a transcript grouped into cues, then aligned. */
function captionCase(
  name: string,
  what: string,
  s: Script,
  audio: Float32Array,
  flaw: Flaw,
  budget: Case["budget"]
): Case {
  return {
    name,
    what,
    budget,
    run: () => {
      // The production grouping decides where the cue boundaries fall — a long
      // line becomes two cues — so the truth for each cue is read off the words
      // it actually carries, not off the line it came from.
      const cues = groupWords(heard(s, flaw).map((w) => ({ t0: w.t0, t1: w.t1, w: w.w })));
      let cursor = 0;
      const truth = cues.map((c) => {
        const count = c.words?.length ?? 1;
        const span = s.words.slice(cursor, cursor + count);
        cursor += count;
        return { start: span[0].start, end: span[span.length - 1].end };
      });
      const report = syncToSpeech(cues, audio, RATE, { reach: 0.6 });
      return {
        before: score(cues, truth),
        after: score(report.items, truth),
        evidence: report.evidence,
      };
    },
  };
}

/** The lyric path: the user's own words against a transcript that heard half
 * of them, then aligned. */
function lyricCase(
  name: string,
  what: string,
  s: Script,
  audio: Float32Array,
  opts: { drop: number; wrong: number },
  budget: Case["budget"]
): Case {
  return {
    name,
    what,
    budget,
    run: () => {
      const transcript = degrade(heard(s, "leadin"), { ...opts, seed: 11 });
      const timed = syncLines(
        s.lines.map((l) => l.text),
        transcript,
        { from: 0, to: s.duration }
      );
      const report = syncToSpeech(timed, audio, RATE, { reach: 0.6 });
      return {
        before: score(timed, s.lines),
        after: score(report.items, s.lines),
        evidence: report.evidence,
      };
    },
  };
}

const talk = script({ lines: 8, wordsPerLine: 5, wordGap: 0.07, lineGap: 0.55, lead: 0.9, seed: 1 });
const fast = script({ lines: 10, wordsPerLine: 4, wordGap: 0.05, lineGap: 0.28, lead: 0.4, seed: 2 });
const song = script({ lines: 8, wordsPerLine: 5, wordGap: 0.09, lineGap: 0.7, lead: 1.4, seed: 4 });

const CASES: Case[] = [
  captionCase(
    "captions/lead-in",
    "The silence before each sentence billed to its first word — the on-device transcriber's habit.",
    talk,
    render(talk, clean),
    "leadin",
    { medianStart: 0.1, p90Start: 0.15, within250ms: 1 }
  ),
  captionCase(
    "captions/lag",
    "Every cue a quarter second late; the shape is right, the placement is not.",
    talk,
    render(talk, clean),
    "lag",
    { medianStart: 0.1, p90Start: 0.15, within250ms: 1 }
  ),
  captionCase(
    "captions/drift",
    "A clock that slips as the chunk runs on, ending 0.6s out — the hosted transcriber's, unchunked. " +
      "The tail budget allows one cue: once the slip exceeds the line gap, a caption's true onset sits " +
      "mid-speech in the previous line's run, which no waveform can testify to. Chunking bounds real " +
      "drift far under that (cloudTranscribe.ts).",
    talk,
    render(talk, clean),
    "drift",
    { medianStart: 0.12, p90Start: 0.9, within250ms: 0.8 }
  ),
  captionCase(
    "captions/noisy-room",
    "The same lag over a room 22dB louder — a noise floor close enough to the voice to blur its edges.",
    talk,
    render(talk, noisy),
    "lag",
    { medianStart: 0.12, p90Start: 0.2, within250ms: 1 }
  ),
  captionCase(
    "captions/music-bed",
    "A steady bed under the whole cut: the gaps between lines are the only readable quiet.",
    talk,
    render(talk, bed),
    "lag",
    { medianStart: 0.15, p90Start: 0.3, within250ms: 0.9 }
  ),
  captionCase(
    "captions/fast-cadence",
    "Lines a quarter second apart, where a snap that overshoots lands on the wrong line.",
    fast,
    render(fast, clean),
    "leadin",
    { medianStart: 0.12, p90Start: 0.2, within250ms: 1 }
  ),
  lyricCase(
    "lyrics/half-heard",
    "The user's lyrics against a transcript that missed a third of the words and misheard a quarter.",
    song,
    render(song, clean),
    { drop: 0.35, wrong: 0.25 },
    { medianStart: 0.12, p90Start: 0.25, within250ms: 0.9 }
  ),
  lyricCase(
    "lyrics/mostly-unheard",
    "Singing the recognizer barely follows: two words in three unheard, so most line times are interpolated.",
    song,
    render(song, clean),
    { drop: 0.68, wrong: 0.2 },
    { medianStart: 0.15, p90Start: 0.35, within250ms: 0.85 }
  ),
];

// ── Run ─────────────────────────────────────────────────────────────────────

const cases = CASES.filter((c) => !ONLY || c.name.includes(ONLY));
if (cases.length === 0) {
  console.error(`No case matches ${ONLY}. Cases: ${CASES.map((c) => c.name).join(", ")}`);
  process.exit(2);
}

const results = cases.map((c) => {
  const { before, after, evidence } = c.run();
  const breaches: string[] = [];
  if (after.medianStart > c.budget.medianStart)
    breaches.push(`median ${after.medianStart}s > ${c.budget.medianStart}s`);
  if (after.p90Start > c.budget.p90Start) breaches.push(`p90 ${after.p90Start}s > ${c.budget.p90Start}s`);
  if (after.within250ms < c.budget.within250ms)
    breaches.push(`within 250ms ${after.within250ms} < ${c.budget.within250ms}`);
  // The pass has to earn its place: aligning must not leave lines worse off
  // than the transcript had them.
  if (after.medianStart > before.medianStart + 0.02)
    breaches.push(`alignment made it worse: ${before.medianStart}s → ${after.medianStart}s`);
  return { name: c.name, what: c.what, evidence, before, after, budget: c.budget, breaches };
});

const failed = results.filter((r) => r.breaches.length > 0);

for (const r of results) {
  const mark = r.breaches.length === 0 ? "ok  " : "FAIL";
  console.log(
    `${mark} ${r.name.padEnd(24)} median ${r.before.medianStart.toFixed(3)}s → ${r.after.medianStart.toFixed(3)}s   ` +
      `p90 ${r.after.p90Start.toFixed(3)}s   within 250ms ${(r.after.within250ms * 100).toFixed(0)}%` +
      (r.evidence ? "" : "   (the mix offered no edges)")
  );
  if (VERBOSE) console.log(`     ${r.what}`);
  for (const b of r.breaches) console.log(`     ✗ ${b}`);
}

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  `${JSON.stringify({ cases: results, failed: failed.map((f) => f.name) }, null, 2)}\n`
);
console.log(`\n${results.length - failed.length}/${results.length} within budget — report at ${OUT}`);

if (failed.length > 0 && ENFORCE) process.exit(1);
