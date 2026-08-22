#!/usr/bin/env bun
/**
 * Speech-cut eval: does the cut land where a listener wants it?
 *
 * A recut is judged by ear, and the ear is strict about one thing above all —
 * a word must finish. Half a syllable missing at a cut is heard immediately,
 * however good the rest of the edit is, and "make it fast paced" is the ask
 * that produces it: cuts get planned tight against cue timings, cue timings
 * run short of the audio, and the tail of every sentence goes with the cut.
 *
 * So the truth is built rather than measured. A take of known words renders to
 * audio, a model's cut is planned on top of it from a transcript with the
 * errors real transcripts have, and the production placement path runs over
 * both. Every number below is measured against where the words actually are:
 *
 *   clipped — speech the cut removed. Anything above zero is the bug.
 *   air     — the quiet left between the cut and the word it keeps.
 *
 * Each case reports the model's own edges and the placed ones, because the
 * placement is the thing on trial. Budgets are enforced by default; the run
 * takes a couple of seconds with no model, no network, and no credits.
 *
 *   npm run eval:cut-edges [--only <case>] [--out path] [--no-enforce] [--verbose]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { scanSpeech, type PcmChunk } from "../src/cut/lib/audioScan";
import { AIR, MIN_AIR, placeEdge, settleJoint, type Pace } from "../src/cut/lib/cutRefine";

const SITE = path.resolve(import.meta.dir, "..");
const REPORT = path.resolve(SITE, "..", "evals", "cut-edges.latest-report.json");

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

// ── Deterministic everything ────────────────────────────────────────────────
// A budget that trips one time in five is worse than no budget.
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
};

// ── The take ────────────────────────────────────────────────────────────────

interface Word {
  sentence: number;
  start: number;
  end: number;
}

interface Take {
  words: Word[];
  sentences: { start: number; end: number }[];
  duration: number;
}

/** A take of `sentences` sentences: words of syllable length, a breath between
 * them, a pause between sentences, and `lead` of room before anyone speaks. */
function speak(opts: {
  sentences: number;
  wordsPerSentence: number;
  wordGap: number;
  sentenceGap: number;
  lead: number;
  seed: number;
}): Take {
  const rnd = rng(opts.seed);
  const words: Word[] = [];
  const sentences: Take["sentences"] = [];
  let t = opts.lead;
  for (let si = 0; si < opts.sentences; si++) {
    const start = t;
    for (let wi = 0; wi < opts.wordsPerSentence; wi++) {
      const dur = 0.24 + Math.abs(rnd()) * 0.4;
      words.push({ sentence: si, start: t, end: t + dur });
      t += dur + (wi + 1 < opts.wordsPerSentence ? opts.wordGap : 0);
    }
    sentences.push({ start, end: t });
    t += opts.sentenceGap;
  }
  return { words, sentences, duration: t + 1 };
}

interface Room {
  floorDb: number;
  bedDb?: number;
  /** Peak amplitude of the voice — a recording nobody normalized is quiet. */
  level: number;
  seed: number;
}

/** The take as audio: a burst per word, shaped like a syllable rather than a
 * flat block, over whatever room the case asks for. */
function render(take: Take, room: Room): Float32Array {
  const rnd = rng(room.seed);
  const out = new Float32Array(Math.ceil(take.duration * RATE));
  const floor = Math.pow(10, room.floorDb / 20);
  for (let i = 0; i < out.length; i++) out[i] = rnd() * floor * 2;
  if (room.bedDb !== undefined) {
    const bed = Math.pow(10, room.bedDb / 20);
    for (let i = 0; i < out.length; i++) out[i] += Math.sin((2 * Math.PI * 110 * i) / RATE) * bed;
  }
  for (const w of take.words) {
    const from = Math.round(w.start * RATE);
    const to = Math.min(out.length, Math.round(w.end * RATE));
    const len = Math.max(1, to - from);
    for (let i = from; i < to; i++) {
      const p = (i - from) / len;
      // Attack, hold, decay — a word does not start and stop square, and the
      // decay is the part a tight cut eats.
      const env = Math.min(1, p / 0.1) * Math.min(1, (1 - p) / 0.18);
      const wobble = 0.7 + 0.3 * Math.sin(p * Math.PI * 4);
      out[i] += rnd() * room.level * env * wobble;
    }
  }
  return out;
}

/** The rendered take, handed over in uneven spans the way a decoder does. */
async function* pcm(audio: Float32Array, from: number, to: number): AsyncGenerator<PcmChunk> {
  const first = Math.max(0, Math.floor(from * RATE));
  const last = Math.min(audio.length, Math.ceil(to * RATE));
  for (let start = first; start < last; start += 4321) {
    const end = Math.min(last, start + 4321);
    yield { channels: [audio.slice(start, end)], timestamp: start / RATE, sampleRate: RATE };
  }
}

// ── The model's cut ─────────────────────────────────────────────────────────

/** How the assistant placed its own edges before anything was refined.
 *  tight — right on the cue boundary, the pace-chasing habit this eval exists
 *          for; the cue runs short of the audio, so the edge is often already
 *          inside the word.
 *  loose — a beat of spare air on each side, what the skill actually asks for.
 *  wide  — a whole second of it, from a model working off a coarse look. */
type Style = "tight" | "loose" | "wide";

const SPARE: Record<Style, number> = { tight: 0, loose: 0.35, wide: 1 };

/** An edge the model asked for, and the word it is meant to keep. */
interface Cut {
  kind: "in" | "out";
  /** Where the model put it. */
  t: number;
  /** The true boundary of the word this side keeps. */
  word: number;
}

/**
 * Cuts at every sentence joint: the end of one sentence and the start of the
 * next, as the model would place them from a transcript. Cue times carry the
 * error real transcripts carry — a word's cue ends before its sound does, and
 * the boundary jitters either way.
 */
function planCuts(take: Take, style: Style, seed: number): Cut[] {
  const rnd = rng(seed);
  const cuts: Cut[] = [];
  for (const [i, s] of take.sentences.entries()) {
    // The recognizer clips the tail of the last word and jitters the boundary.
    const jitter = () => rnd() * 0.2;
    if (i + 1 < take.sentences.length)
      cuts.push({ kind: "out", t: s.end - 0.08 + jitter() + SPARE[style], word: s.end });
    if (i > 0) cuts.push({ kind: "in", t: s.start + 0.04 + jitter() - SPARE[style], word: s.start });
  }
  return cuts;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const quantile = (xs: number[], q: number) =>
  xs.length === 0 ? 0 : round3([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]);

interface Score {
  edges: number;
  /** Speech the cut removed, seconds. Zero is the only good answer. */
  worstClipped: number;
  clippedEdges: number;
  /** Quiet left between the cut and the word, seconds. */
  medianAir: number;
  tightestAir: number;
  widestAir: number;
}

/** Air at one edge: how far the cut sits from the word it keeps. Negative when
 * the cut is inside the word — the measurement of a clipped word. */
const airAt = (cut: Cut, t: number) => (cut.kind === "out" ? t - cut.word : cut.word - t);

function score(cuts: Cut[], placed: number[]): Score {
  const air = cuts.map((c, i) => airAt(c, placed[i]));
  const clipped = air.map((a) => Math.max(0, -a));
  return {
    edges: cuts.length,
    worstClipped: round3(Math.max(0, ...clipped)),
    clippedEdges: clipped.filter((c) => c > 0.005).length,
    medianAir: quantile(air, 0.5),
    tightestAir: round3(Math.min(...air)),
    widestAir: round3(Math.max(...air)),
  };
}

// ── Cases ───────────────────────────────────────────────────────────────────

interface Budget {
  /** Speech may not be cut off. Kept as a number so the report shows the slack. */
  clipped: number;
  /** The quiet at the tightest edge, and at the widest. */
  minAir: number;
  maxAir: number;
}

/** The span the tool reads around one edge — REACH plus room to measure the
 * recording's levels, the same window refine_speech_cuts opens. */
const WINDOW = 3;

function refine(audio: Float32Array, duration: number, cuts: Cut[], pace: Pace): Promise<number[]> {
  return Promise.all(
    cuts.map(async (cut) => {
      const from = Math.max(0, cut.t - WINDOW);
      const to = Math.min(duration, cut.t + WINDOW);
      const scan = await scanSpeech(pcm(audio, from, to), { from, to });
      return placeEdge(scan.segments, cut.t, cut.kind, pace, scan).t;
    })
  );
}

const talk = speak({ sentences: 7, wordsPerSentence: 5, wordGap: 0.08, sentenceGap: 0.62, lead: 0.9, seed: 1 });
const rapid = speak({ sentences: 8, wordsPerSentence: 4, wordGap: 0.05, sentenceGap: 0.24, lead: 0.4, seed: 2 });
// Long beats between sentences, the take a coarse plan leaves dead air in.
const airy = speak({ sentences: 6, wordsPerSentence: 5, wordGap: 0.08, sentenceGap: 2.4, lead: 1.4, seed: 6 });

const quietRoom: Room = { floorDb: -60, level: 0.6, seed: 3 };
const loudRoom: Room = { floorDb: -38, level: 0.6, seed: 5 };
const unnormalized: Room = { floorDb: -78, level: 0.05, seed: 7 };
const musicBed: Room = { floorDb: -58, bedDb: -34, level: 0.6, seed: 9 };

interface Spec {
  name: string;
  what: string;
  take: Take;
  room: Room;
  style: Style;
  pace: Pace;
  budget: Budget;
}

const SPECS: Spec[] = [
  {
    name: "fast/tight-cuts",
    what: "The reported bug: a fast-paced recut planned right on the cue boundaries, in a quiet room. Cue times run short of the audio, so half these edges start out inside a word.",
    take: talk,
    room: quietRoom,
    style: "tight",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.34 },
  },
  {
    name: "fast/loud-room",
    what: "The same tight plan over a room 22dB louder — a floor close enough to the voice that a fixed threshold reads the pauses as speech.",
    take: talk,
    room: loudRoom,
    style: "tight",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.34 },
  },
  {
    name: "fast/unnormalized",
    what: "A recording nobody levelled: the voice sits at -37dBFS, under any fixed silence threshold worth using on a normal file.",
    take: talk,
    room: unnormalized,
    style: "tight",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.34 },
  },
  {
    name: "fast/music-bed",
    what: "A steady bed under the whole take: nothing is ever truly quiet, and the gaps between sentences are the only readable edges.",
    take: talk,
    room: musicBed,
    style: "tight",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.4 },
  },
  {
    name: "fast/rapid-cadence",
    what: "Sentences a quarter second apart, cut fast: the pause cannot hold the full air, so both sides take what there is and no word is touched.",
    take: rapid,
    room: quietRoom,
    style: "tight",
    pace: "fast",
    budget: { clipped: 0, minAir: 0.05, maxAir: 0.34 },
  },
  {
    name: "fast/loose-plan",
    what: "The skill's own instruction followed — cut loose, refine after. The air comes back to the pace from the other direction.",
    take: talk,
    room: quietRoom,
    style: "loose",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.34 },
  },
  {
    name: "fast/wide-plan",
    what: "Sentences held two and a half seconds apart and a second of spare air either side, from a model working off a coarse look. Dead air is the failure here, not clipping.",
    take: airy,
    room: quietRoom,
    style: "wide",
    pace: "fast",
    budget: { clipped: 0, minAir: MIN_AIR.in, maxAir: 0.34 },
  },
  {
    name: "natural/tight-cuts",
    what: "The default pace over the same tight plan — every edge a quarter second clear of the word.",
    take: talk,
    room: quietRoom,
    style: "tight",
    pace: "natural",
    budget: { clipped: 0, minAir: 0.1, maxAir: 0.45 },
  },
  {
    name: "relaxed/tight-cuts",
    what: "The slowest pace: the piece breathes, and the same edges sit further out without running into the next sentence.",
    take: talk,
    room: quietRoom,
    style: "tight",
    pace: "relaxed",
    budget: { clipped: 0, minAir: 0.12, maxAir: 0.7 },
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

interface Result {
  name: string;
  what: string;
  pace: Pace;
  before: Score;
  after: Score;
  budget: Budget;
  breaches: string[];
}

const specs = SPECS.filter((c) => !ONLY || c.name.includes(ONLY));
if (specs.length === 0) {
  console.error(`No case matches ${ONLY}. Cases: ${SPECS.map((c) => c.name).join(", ")}`);
  process.exit(2);
}

const report: Result[] = [];
for (const spec of specs) {
  const audio = render(spec.take, spec.room);
  const cuts = planCuts(spec.take, spec.style, spec.room.seed + 1);
  const placed = await refine(audio, spec.take.duration, cuts, spec.pace);
  const before = score(cuts, cuts.map((c) => c.t));
  const after = score(cuts, placed);
  const breaches: string[] = [];
  if (after.worstClipped > spec.budget.clipped)
    breaches.push(`clipped ${after.worstClipped}s of speech at ${after.clippedEdges} edge(s)`);
  if (after.tightestAir < spec.budget.minAir)
    breaches.push(`tightest edge ${after.tightestAir}s < ${spec.budget.minAir}s of air`);
  if (after.widestAir > spec.budget.maxAir)
    breaches.push(`widest edge ${after.widestAir}s > ${spec.budget.maxAir}s of air`);
  // The pass has to earn its place: placing must not leave an edge worse off
  // than the model had it.
  if (after.worstClipped > before.worstClipped)
    breaches.push(`placing made it worse: ${before.worstClipped}s → ${after.worstClipped}s clipped`);
  report.push({ name: spec.name, what: spec.what, pace: spec.pace, before, after, budget: spec.budget, breaches });
}

// One joint, both edges of a removed sliver inside a pause too short to hold
// the air either side wants. Nothing may replay across it and neither word may
// be touched — the case that used to revert both edges to the model's numbers.
const jointCase = (() => {
  const take = speak({ sentences: 2, wordsPerSentence: 4, wordGap: 0.06, sentenceGap: 0.18, lead: 0.6, seed: 4 });
  const audio = render(take, quietRoom);
  const gapStart = take.sentences[0].end;
  const gapEnd = take.sentences[1].start;
  const mid = (gapStart + gapEnd) / 2;
  const run = async (pace: Pace) => {
    const scan = await scanSpeech(pcm(audio, 0, take.duration), { from: 0, to: take.duration });
    const out = placeEdge(scan.segments, mid - 0.03, "out", pace, scan);
    const into = placeEdge(scan.segments, mid + 0.03, "in", pace, scan);
    const joint = out.t > into.t ? settleJoint(out, into) : null;
    const outT = joint ?? out.t;
    const inT = joint ?? into.t;
    return {
      pace,
      crossed: round3(Math.max(0, out.t - into.t)),
      settled: joint !== null,
      replay: round3(Math.max(0, outT - inT)),
      outAir: round3(outT - gapStart),
      inAir: round3(gapEnd - inT),
    };
  };
  return { take, run };
})();

const joints = await Promise.all((["fast", "natural"] as Pace[]).map(jointCase.run));
const jointBreaches = joints.flatMap((j) => {
  const bad: string[] = [];
  if (j.replay > 0) bad.push(`${j.pace}: ${j.replay}s of source plays twice across the joint`);
  if (j.outAir < 0) bad.push(`${j.pace}: the joint cuts ${-j.outAir}s off the word before it`);
  if (j.inAir < 0) bad.push(`${j.pace}: the joint cuts ${-j.inAir}s off the word after it`);
  return bad;
});

for (const r of report) {
  const mark = r.breaches.length === 0 ? "ok  " : "FAIL";
  console.log(
    `${mark} ${r.name.padEnd(22)} clipped ${r.before.worstClipped.toFixed(3)}s → ${r.after.worstClipped.toFixed(3)}s   ` +
      `air ${r.after.tightestAir.toFixed(3)}–${r.after.widestAir.toFixed(3)}s (median ${r.after.medianAir.toFixed(3)}s, pace wants ${AIR[r.pace].in}–${AIR[r.pace].out}s)`
  );
  if (VERBOSE) console.log(`     ${r.what}`);
  for (const b of r.breaches) console.log(`     ✗ ${b}`);
}
console.log(
  `${jointBreaches.length === 0 ? "ok  " : "FAIL"} ${"joint/short-pause".padEnd(22)} ` +
    joints.map((j) => `${j.pace}: ${j.settled ? "settled" : "held"} ${j.outAir}s / ${j.inAir}s`).join("   ")
);
for (const b of jointBreaches) console.log(`     ✗ ${b}`);

const failed = report.filter((r) => r.breaches.length > 0);
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(
  OUT,
  `${JSON.stringify(
    { cases: report, joint: joints, jointBreaches, failed: failed.map((f) => f.name) },
    null,
    2
  )}\n`
);
const total = report.length + 1;
const passed = total - failed.length - (jointBreaches.length > 0 ? 1 : 0);
console.log(`\n${passed}/${total} within budget — report at ${OUT}`);

if ((failed.length > 0 || jointBreaches.length > 0) && ENFORCE) process.exit(1);
