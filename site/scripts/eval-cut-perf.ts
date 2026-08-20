#!/usr/bin/env bun
/**
 * Preview performance eval: how fast does the picture answer, and does it ever
 * drop a frame at a cut?
 *
 * Both questions are about time, and neither can be settled by watching. A real
 * Chrome opens a real editor on a fixture project, drives it, and reads the
 * engine's own frame trace (`window.__cutPerf`, installed by devHooks.ts). Two
 * numbers come out of it:
 *
 *   scrub-to-pixel — from the moment a time is asked for to the moment a frame
 *                    for that time is painted. Held or black frames don't count;
 *                    only real pixels answer a scrub.
 *   frames at a cut — every boundary in the fixture is crossed while playing and
 *                    the trace is checked for a source frame shown twice or
 *                    skipped over.
 *   filmstrip truth — the timeline strip's tile under (and around) the playhead
 *                    shows the frame at the tile's own midpoint, at every zoom.
 *                    The fixture's color walks an RGB circle over the clip, so
 *                    each tile's color names the source moment it was captured
 *                    at; the tile is compared against this same browser's
 *                    decode of the file, which cancels colorspace drift between
 *                    the encoder and the canvas.
 *
 * Fixtures build deterministically into dist/cut-perf/ (gitignored) from the
 * bundled stock clips, so the montage's cut times are known exactly.
 *
 * Needs `next dev` on :3000 and the dev auth bypass user. Spends no credits.
 *
 *   npm run eval:cut-perf [--only <case>] [--runs N] [--out path]
 *                         [--enforce-budgets] [--headed]
 */

import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE = path.resolve(import.meta.dir, "..");
const OUT = path.resolve(SITE, "..", "dist", "cut-perf");
const STOCK = path.join(SITE, "public", "cut-stock-video");
const REPORT = path.resolve(SITE, "..", "evals", "cut-perf.latest-report.json");

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const BASE = arg("--base") ?? "http://localhost:3000";
const RUNS = Number(arg("--runs") ?? 1);
const ONLY = arg("--only");
const BUCKET = arg("--bucket");
const ENFORCE = has("--enforce-budgets");
/** The dev-only account the API bypass authenticates as. */
const DEV_USER = "donkey-dev-auth-bypass";

// ── The gate ────────────────────────────────────────────────────────────────
//
// Two numbers matter and they are not the same number. The typical step of a
// drag has to land inside a frame — that is what "instant" means, and the p50
// holds it. The tail is a step that crosses into a clip whose decoder is only
// then opened, which costs what opening a decoder costs; it is bounded rather
// than eliminated.
//
// These are measured against `next dev`, so they carry the development build's
// overhead. A production build has less of it; the gate is set where the dev
// build can hold it under ordinary machine load.
const GATE = {
  // Every step of a drag lands inside one frame at 60Hz, tail included. That is
  // the whole claim.
  scrubP50Ms: 10,
  scrubP95Ms: 16.7,
  // A jump lands where no buffer could have reached, so it pays for a decode
  // from the nearest keyframe. Held to what that honestly costs.
  jumpP50Ms: 20,
  jumpP95Ms: 32,
  // The one that has to be exact: crossing a join must never show a frame that
  // does not belong at that instant.
  boundaryDrops: 0,
  longTaskMs: 16,
  // A strip tile shows the frame at its own midpoint; this is the measurement
  // slack around that moment (capture grid, frame quantization, jpeg noise),
  // on top of the truth lookup's own step. A capture allowed to drift toward
  // a tile's edge lands on the neighboring scene whenever a cut sits inside
  // the tile — the standard is the midpoint, so that drift is a failure.
  filmstripSlackS: 0.2,
};

// ── Types shared with perfTrace.ts ──────────────────────────────────────────
interface PresentRecord {
  t: number;
  at: number;
  srcTs: number | null;
  clipId: string | null;
  exact: boolean;
  stale: boolean;
}
interface SeekRecord {
  t: number;
  at: number;
  latencyMs: number | null;
}
interface Trace {
  presents: PresentRecord[];
  seeks: SeekRecord[];
  longTasks: { at: number; ms: number }[];
  ticks: number;
  liveSamples: number[];
  startedAt: number;
}

interface Agg {
  p50: number;
  p95: number;
  mean: number;
  max: number;
  n: number;
}

const agg = (xs: number[]): Agg => {
  if (xs.length === 0) return { p50: 0, p95: 0, mean: 0, max: 0, n: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    p50: +q(0.5).toFixed(2),
    p95: +q(0.95).toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    n: s.length,
  };
};

// ── Fixtures ────────────────────────────────────────────────────────────────

function run(cmd: string, cmdArgs: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, cmdArgs);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`));
      resolve(code);
    });
  });
}

/** Clip length in the fixture, in seconds. Short enough that a montage crosses
 * many cuts quickly, long enough that each has real decoding to do. */
const CLIP_S = 3;
const CLIPS = 6;
/** Seconds of playback spent opening decoders before the trace starts. */
const WARM_PLAY_S = 2;

/**
 * A montage of known cut times, re-encoded so every clip shares a codec, frame
 * rate and keyframe cadence — the cut times are then exact, and a dropped frame
 * at a join is the engine's doing rather than the file's.
 */
async function buildFixtures(): Promise<string[]> {
  await mkdir(OUT, { recursive: true });
  const sources = [
    "animal-dog-sprint.mp4",
    "animal-flock-sky.mp4",
    "anime-cloud-drift.mp4",
  ].filter((f) => existsSync(path.join(STOCK, f)));
  if (sources.length === 0) throw new Error(`no stock clips found in ${STOCK}`);

  const made: string[] = [];
  for (let i = 0; i < CLIPS; i++) {
    const src = path.join(STOCK, sources[i % sources.length]);
    const dst = path.join(OUT, `clip-${i}.mp4`);
    made.push(dst);
    if (existsSync(dst)) continue;
    await run("ffmpeg", [
      "-y", "-loglevel", "error",
      "-i", src,
      "-t", String(CLIP_S),
      // A keyframe every second: a scrub lands near one often enough to be a
      // fair test, and far enough from one to be a real one.
      "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-keyint_min", "30",
      "-r", "30", "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p",
      "-an",
      dst,
    ]);
  }
  return made;
}

/** The filmstrip fixture's length. The shape it replicates: a clip in the low
 * twenties of seconds carries about twelve pre-sampled thumbs, one every two
 * seconds, and on fast-cutting footage a zoomed tile drawn from those sits a
 * scene away from its own moment. */
const RAMP_S = 24;

/** A clip whose color names its own timestamp: red and green trace one full
 * circle over the clip (r = sin, g = cos of the clip's phase), so every frame
 * has a color no other moment in the clip shares. Explicit bt709 tags keep
 * the browser's decode on the encoder's matrix. */
async function buildRamp(): Promise<void> {
  const dst = path.join(OUT, "ramp.mp4");
  if (existsSync(dst)) return;
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=30:d=${RAMP_S}`,
    "-vf",
    `format=rgb24,geq=r='128+112*sin(2*PI*(N/30)/${RAMP_S})':g='128+112*cos(2*PI*(N/30)/${RAMP_S})':b='64'`,
    "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    dst,
  ]);
}

/** Where the scene-cut fixture changes scene: every three seconds. */
const CUT_SEG_S = 3;
const FIXTURE_CUTS = Array.from({ length: RAMP_S / CUT_SEG_S - 1 }, (_, i) => (i + 1) * CUT_SEG_S);

/** The ramp with a hard scene cut every three seconds: the color circle jumps
 * phase at each segment, and blue names the segment so no two moments across
 * the clip share a color. Every frame still names its own timestamp, and every
 * cut lands on a known second. */
async function buildCutsClip(): Promise<void> {
  const dst = path.join(OUT, "cuts.mp4");
  if (existsSync(dst)) return;
  const seg = `floor(N/${30 * CUT_SEG_S})`;
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=black:s=1280x720:r=30:d=${RAMP_S}`,
    "-vf",
    `format=rgb24,geq=r='128+112*sin(2*PI*(N/30)/${RAMP_S}+2.4*${seg})':g='128+112*cos(2*PI*(N/30)/${RAMP_S}+2.4*${seg})':b='40+24*${seg}'`,
    "-c:v", "libx264", "-preset", "veryfast", "-g", "30", "-keyint_min", "30",
    "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    dst,
  ]);
}

// ── Driving the page ────────────────────────────────────────────────────────

interface Fixture {
  /** Timeline seconds where one clip hands over to the next. */
  cuts: number[];
  duration: number;
}

/** Seed a project straight into the open editor's store, so the eval measures
 * the engine and not the importer. */
async function seed(page: Page, files: string[], transitions: boolean): Promise<Fixture> {
  const payload = files.map((f, i) => ({ url: `/__cutperf/clip-${i}.mp4`, id: `perf-${i}` }));
  return page.evaluate(
    async ({ payload, clipS, transitions }) => {
      const dev = (window as unknown as {
        __cutDev: { useEditor: { getState(): Record<string, unknown>; setState(p: unknown): void } };
      }).__cutDev;
      const assets = payload.map((p) => ({
        id: p.id,
        name: `${p.id}.mp4`,
        fileName: `${p.id}.mp4`,
        type: "video",
        url: p.url,
        duration: clipS,
        width: 1280,
        height: 720,
      }));
      const clips = payload.map((p, i) => ({
        id: `c-${i}`,
        assetId: p.id,
        track: 0,
        start: i * clipS,
        in: 0,
        out: clipS,
        ...(transitions && i < payload.length - 1 ? { transition: 0.5 } : {}),
      }));
      dev.useEditor.setState({
        assets,
        clips,
        audioClips: [],
        overlays: [],
        transitions: [],
        loaded: true,
      });
      // Let the store's own derive pass settle the transition fields.
      await new Promise((r) => setTimeout(r, 200));
      return {
        cuts: payload.slice(1).map((_, i) => (i + 1) * clipS),
        duration: payload.length * clipS,
      };
    },
    { payload, clipS: CLIP_S, transitions }
  );
}

/** Seed one time-coded fixture clip for a filmstrip case and generate its
 * pre-sampled strip, so the case starts where a real project does: thumbs in
 * hand, captures still to earn. */
const seedTimeCoded = (src: string, cuts: number[]) => async (page: Page): Promise<Fixture> =>
  page.evaluate(
    async ({ duration, src, cuts }) => {
      const dev = (window as unknown as {
        __cutDev: {
          useEditor: {
            getState(): { assets: { thumbs?: string[] }[] };
            setState(p: unknown): void;
          };
          enrichAsset: (asset: unknown) => Promise<void>;
        };
      }).__cutDev;
      const name = src.split("/").pop()!;
      dev.useEditor.setState({
        assets: [
          {
            id: "fixture",
            name,
            fileName: name,
            type: "video",
            url: src,
            duration,
            width: 1280,
            height: 720,
          },
        ],
        clips: [{ id: "c-fixture", assetId: "fixture", track: 0, start: 0, in: 0, out: duration }],
        audioClips: [],
        overlays: [],
        transitions: [],
        loaded: true,
      });
      await new Promise((r) => setTimeout(r, 200));
      await dev.enrichAsset(dev.useEditor.getState().assets[0]);
      return { cuts, duration };
    },
    { duration: RAMP_S, src, cuts }
  );

const startTrace = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cutPerf: { start(): void } }).__cutPerf.start());

const stopTrace = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __cutPerf: { stop(): Trace | null } }).__cutPerf.stop() as unknown
  ) as Promise<Trace | null>;

const seek = (page: Page, t: number) =>
  page.evaluate((t) => {
    const dev = (window as unknown as {
      __cutDev: { useEditor: { getState(): { seek(t: number): void } } };
    }).__cutDev;
    dev.useEditor.getState().seek(t);
  }, t);

const setPlaying = (page: Page, playing: boolean) =>
  page.evaluate((p) => {
    const dev = (window as unknown as {
      __cutDev: { useEditor: { getState(): { setPlaying(p: boolean): void } } };
    }).__cutDev;
    dev.useEditor.getState().setPlaying(p);
  }, playing);

/** Put the playhead back to the start and wait until it is actually there. */
async function rewind(page: Page): Promise<void> {
  await setPlaying(page, false);
  await seek(page, 0);
  await page.waitForFunction(
    () =>
      (window as unknown as { __cutDev: { playheadAt(): number } }).__cutDev.playheadAt() < 0.01,
    undefined,
    { timeout: 5000 }
  );
  await page.waitForTimeout(150);
}

/** Wait for the picture to catch up to the last thing asked for. */
const settle = (page: Page, ms = 2500) =>
  page
    .waitForFunction(
      () => {
        const perf = (window as unknown as {
          __cutPerf: { stop(): unknown };
        }).__cutPerf;
        return !!perf;
      },
      undefined,
      { timeout: ms }
    )
    .then(() => page.waitForTimeout(120));

// ── Cases ───────────────────────────────────────────────────────────────────

type Bucket = "scrub" | "playback" | "boundary" | "filmstrip";

interface CaseResult {
  name: string;
  bucket: Bucket;
  pass: boolean;
  notes: string[];
  scrub?: Agg;
  drops?: number;
  presented?: number;
  boundaryDrops?: number;
  idleTicks?: number;
  longTasks?: Agg;
  liveSamples?: number;
  /** Seconds between a strip tile's own moment and the moment its picture
   * was captured at. */
  tileErr?: Agg;
}

interface EvalCase {
  name: string;
  bucket: Bucket;
  transitions: boolean;
  /** The project this case measures; the montage of stock clips when unset. */
  seed?: (page: Page) => Promise<Fixture>;
  run: (page: Page, fx: Fixture) => Promise<CaseResult>;
}

/**
 * Move the playhead one step at a time, a frame apart, the way a pointer does.
 *
 * `span` is how much of the cut the gesture covers, so a drag creeps along the
 * timeline and a jump lands somewhere else entirely — the two gestures have
 * genuinely different costs and are measured apart.
 */
async function sweep(page: Page, fx: Fixture, from: number, span: number, steps: number) {
  for (let i = 0; i <= steps; i++) {
    await seek(page, from + (i / steps) * span);
    // Wait for the picture to catch up before asking for the next position.
    // Driving on a fixed delay instead would measure how many steps the engine
    // can be given, which is a different question: what a drag feels like is
    // how long each position takes to appear.
    await page
      .waitForFunction(
        () => !(window as unknown as { __cutPerf: { awaiting(): boolean } }).__cutPerf.awaiting(),
        undefined,
        { timeout: 900, polling: "raf" }
      )
      .catch(() => {});
  }
  await page.waitForTimeout(200);
}

interface ScrubShape {
  name: string;
  transitions: boolean;
  /** How the gesture moves. */
  gesture: (page: Page, fx: Fixture) => Promise<void>;
  budget: { p50: number; p95: number };
}

const scrubCase = (shape: ScrubShape): EvalCase => ({
  name: shape.name,
  bucket: "scrub",
  transitions: shape.transitions,
  run: async (page, fx) => {
    await setPlaying(page, false);
    // A pass before the trace opens the decoders and lets the dev build settle,
    // so the numbers describe scrubbing rather than first load.
    await sweep(page, fx, 0, fx.duration - 0.05, 8);
    await startTrace(page);
    await shape.gesture(page, fx);
    const trace = await stopTrace(page);
    const notes: string[] = [];
    if (!trace) return { name: shape.name, bucket: "scrub", pass: false, notes: ["no trace"] };
    const answered = trace.seeks.filter((s) => s.latencyMs !== null).map((s) => s.latencyMs!);
    const unanswered = trace.seeks.length - answered.length;
    const a = agg(answered);
    // Superseded seeks never resolve and that is correct — but a gesture that
    // waits a frame per step should answer nearly all of them.
    if (unanswered > trace.seeks.length * 0.2) {
      notes.push(`${unanswered}/${trace.seeks.length} seeks never painted`);
    }
    const lt = agg(trace.longTasks.map((l) => l.ms));
    if (lt.max > GATE.longTaskMs) notes.push(`long task ${lt.max}ms`);
    if (a.p95 > shape.budget.p95) notes.push(`p95 ${a.p95}ms over ${shape.budget.p95}ms`);
    if (a.p50 > shape.budget.p50) notes.push(`p50 ${a.p50}ms over ${shape.budget.p50}ms`);
    return {
      name: shape.name,
      bucket: "scrub",
      pass: notes.length === 0,
      notes,
      scrub: a,
      longTasks: lt,
      liveSamples: Math.max(0, ...trace.liveSamples),
    };
  },
});

const playbackCase = (name: string, transitions: boolean): EvalCase => ({
  name,
  bucket: transitions ? "boundary" : "playback",
  transitions,
  run: async (page, fx) => {
    // Rewind before warming, and make sure it took. A previous case leaves the
    // playhead at the end of the cut, and a warm-up play from there finishes
    // before it has opened anything — the measured play would then start from a
    // pool as cold as if there had been no warm-up at all.
    await rewind(page);
    // Open the decoders before the trace: the first play of a fresh montage
    // pays for six files at once, which is a load cost rather than a frame one.
    await setPlaying(page, true);
    await page.waitForTimeout(WARM_PLAY_S * 1000);
    await setPlaying(page, false);
    await seek(page, 0);
    await settle(page);
    await startTrace(page);
    await setPlaying(page, true);
    // Play the whole fixture through, plus a moment to land the last frame.
    await page.waitForTimeout((fx.duration + 1) * 1000);
    await setPlaying(page, false);
    const trace = await stopTrace(page);
    const notes: string[] = [];
    if (!trace) return { name, bucket: "playback", pass: false, notes: ["no trace"] };

    // A frame the decoder failed to deliver: the engine painted, but with a
    // picture that does not belong at that instant. Repeating a source frame is
    // not a fault — thirty-frame footage on a sixty-hertz display does it every
    // other frame — so the measure is whether the right frame was there.
    // The first moments of a play are the decoders opening, and the last are
    // the cut ending. What is being measured is the stretch in between.
    const played = trace.presents.filter((p) => p.t > 0.4 && p.t < fx.duration - 0.3);
    const late = played.filter((p) => !p.exact || p.stale);
    // Boundary trouble is what the rebuild is judged on: a late frame within a
    // few frames either side of a cut.
    const near = (t: number) => fx.cuts.some((c) => Math.abs(t - c) < 0.1);
    const boundaryDrops = late.filter((p) => near(p.t)).length;
    if (boundaryDrops > GATE.boundaryDrops) {
      notes.push(`${boundaryDrops} stale frames at a cut`);
    }
    // The picture must reach the end: a clock that stalls would pass the
    // boundary check by never arriving.
    const reached = Math.max(...played.map((p) => p.t), 0);
    if (reached < fx.duration - 0.5) {
      notes.push(`playback stopped at ${reached.toFixed(2)}s of ${fx.duration}s`);
    }
    const lt = agg(trace.longTasks.map((l) => l.ms));
    if (lt.max > GATE.longTaskMs) notes.push(`long task ${lt.max}ms`);
    return {
      name,
      bucket: transitions ? "boundary" : "playback",
      pass: notes.length === 0,
      notes,
      drops: late.length,
      presented: played.length,
      boundaryDrops,
      longTasks: lt,
      liveSamples: Math.max(0, ...trace.liveSamples),
    };
  },
});

/** A paused editor with nothing changing must schedule no frames at all. */
const idleCase: EvalCase = {
  name: "idle-costs-nothing",
  bucket: "playback",
  transitions: false,
  run: async (page) => {
    await setPlaying(page, false);
    await seek(page, 1.2);
    await page.waitForTimeout(600);
    await startTrace(page);
    await page.waitForTimeout(1000);
    const trace = await stopTrace(page);
    const ticks = trace?.ticks ?? -1;
    // A couple of settling frames is fine; sixty a second is the old loop.
    const pass = ticks >= 0 && ticks <= 3;
    return {
      name: "idle-costs-nothing",
      bucket: "playback",
      pass,
      notes: pass ? [] : [`${ticks} engine frames while idle`],
      idleTicks: ticks,
    };
  },
};

/** A strip tile's picture against the tile's own moment, sampled around the
 * playhead. One measurement per zoom: the timeline is zoomed, scrolled to the
 * playhead, and left to finish its tile captures; then every visible tile's
 * color is matched against this browser's decode of the ramp at known times,
 * which turns each tile back into the source second it actually shows. */
interface TileSample {
  tileT: number;
  impliedT: number;
  err: number;
  tol: number;
}

/** Wait until the strip has no captures queued or mid-read, checked twice so
 * a re-render that queues one more round is also drained. */
async function settleTiles(page: Page): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await page.waitForFunction(
      () =>
        (window as unknown as { __cutDev: { edgeFramesPending(): number } }).__cutDev
          .edgeFramesPending() === 0,
      undefined,
      { timeout: 30_000 }
    );
    await page.waitForTimeout(300);
  }
}

/** Wait for the seeded asset's pre-sampled strip to exist. */
async function awaitThumbs(page: Page): Promise<void> {
  await setPlaying(page, false);
  await page.waitForFunction(
    () => {
      const dev = (window as unknown as {
        __cutDev: { useEditor: { getState(): { assets: { thumbs?: string[] }[] } } };
      }).__cutDev;
      return !!dev.useEditor.getState().assets[0]?.thumbs?.length;
    },
    undefined,
    { timeout: 60_000 }
  );
}

/** Zoom to `pps`, park the playhead at `at` and scroll it to the view's
 * center, then wait for every capture the strip asked for. */
async function zoomTo(page: Page, c: { pps: number; at: number }): Promise<void> {
  await page.evaluate(({ pps, at }) => {
    const dev = (window as unknown as {
      __cutDev: {
        useEditor: { getState(): { setPxPerSec(v: number): void; seek(t: number): void } };
      };
    }).__cutDev;
    dev.useEditor.getState().setPxPerSec(pps);
    dev.useEditor.getState().seek(at);
  }, c);
  await page.waitForTimeout(150);
  await page.evaluate(({ at }) => {
    const dev = (window as unknown as {
      __cutDev: { useEditor: { getState(): { pxPerSec: number } } };
    }).__cutDev;
    const scroller = document.querySelector("[data-tl-scroll]") as HTMLElement;
    const box = document.querySelector('[data-tl-sel^="clip:"]') as HTMLElement;
    const view = scroller.getBoundingClientRect();
    const pps = dev.useEditor.getState().pxPerSec;
    scroller.scrollLeft +=
      box.getBoundingClientRect().left + at * pps - (view.left + view.width / 2);
  }, c);
  await settleTiles(page);
}

/** In-page measure of the visible strip against ground truth: what moment
 * each tile's picture implies, read off the time-coded fixture through this
 * browser's own decoder. */
const measureStrip = async ({ at, slackS, src }: { at: number; slackS: number; src: string }) => {
  const dev = (window as unknown as {
    __cutDev: { useEditor: { getState(): { pxPerSec: number } } };
  }).__cutDev;
  const pps = dev.useEditor.getState().pxPerSec;
  const scroller = document.querySelector("[data-tl-scroll]") as HTMLElement;
  const box = document.querySelector('[data-tl-sel^="clip:"]') as HTMLElement;
  const view = scroller.getBoundingClientRect();
  const boxR = box.getBoundingClientRect();
  // The seeded clip starts at 0 with no trim at speed 1, so a tile
  // center's offset in the box is its source time.
  const tiles = (Array.from(
    box.querySelectorAll(".tl-filmstrip img")
  ) as HTMLImageElement[])
    .map((img) => {
      const r = img.getBoundingClientRect();
      return { img, left: r.left, width: r.width, t: (r.left + r.width / 2 - boxR.left) / pps };
    })
    // Tiles on screen, clear of the clamped end captures, nearest the
    // playhead first; twenty is plenty to convict a wrong strip. The
    // strip's first and last tiles pin to the clip's exact boundary
    // frames (trim feedback), so the midpoint standard exempts them.
    .filter((x) => x.left + x.width > view.left && x.left < view.right)
    .filter((x) => x.t > 0.8 && x.t < 23.2)
    .filter(
      (x) => x.left > boxR.left + 2 && x.left + x.width < boxR.left + boxR.width - 2
    )
    .sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at))
    .slice(0, 20);
  if (tiles.length === 0) return [];
  const avg = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 4;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    draw(ctx);
    const d = ctx.getImageData(0, 0, 4, 4).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      g += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  };
  // Ground truth from the same file through this browser's own
  // decoder, so whatever the canvas does to the colors it does to
  // both sides of the comparison.
  const video = document.createElement("video");
  video.src = src;
  video.muted = true;
  video.preload = "auto";
  await new Promise<void>((res, rej) => {
    video.onloadeddata = () => res();
    video.onerror = () => rej(new Error("fixture did not load"));
  });
  const seekTo = (t: number) =>
    new Promise<void>((res) => {
      video.onseeked = () => res();
      video.currentTime = t;
    });
  const span = tiles[0].width / pps;
  const step = Math.max(0.04, span / 8);
  const ts = tiles.map((x) => x.t);
  const lo = Math.max(0.05, Math.min(...ts) - 2.5);
  const hi = Math.min(23.9, Math.max(...ts) + 2.5);
  const lookup: { t: number; c: number[] }[] = [];
  for (let t = lo; t <= hi; t += step) {
    await seekTo(t);
    lookup.push({ t, c: avg((ctx) => ctx.drawImage(video, 0, 0, 4, 4)) });
  }
  const out: { tileT: number; impliedT: number; err: number; tol: number }[] = [];
  for (const tile of tiles) {
    const el = new Image();
    el.src = tile.img.src;
    await el.decode();
    const c = avg((ctx) => ctx.drawImage(el, 0, 0, 4, 4));
    let impliedT = lookup[0].t;
    let bestD = Infinity;
    for (const p of lookup) {
      const d =
        (p.c[0] - c[0]) ** 2 + (p.c[1] - c[1]) ** 2 + (p.c[2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        impliedT = p.t;
      }
    }
    out.push({
      tileT: tile.t,
      impliedT,
      err: Math.abs(impliedT - tile.t),
      tol: slackS + step,
    });
  }
  return out;
};

/** Zoom to one check, settle the captures, and hold every visible tile to
 * the midpoint standard, turning misses into notes. */
async function checkMidpoints(
  page: Page,
  src: string,
  c: { pps: number; at: number },
  notes: string[],
  samples: (TileSample & { pps: number })[]
): Promise<void> {
  await zoomTo(page, c);
  const got = (await page.evaluate(measureStrip, {
    at: c.at,
    slackS: GATE.filmstripSlackS,
    src,
  })) as TileSample[];
  if (got.length < 8) notes.push(`only ${got.length} tiles sampled at ${c.pps}px/s`);
  for (const s of got) {
    if (s.err > s.tol) {
      notes.push(
        `tile at ${s.tileT.toFixed(2)}s shows ${s.impliedT.toFixed(2)}s (${s.err.toFixed(2)}s off, tol ${s.tol.toFixed(2)}s) at ${c.pps}px/s`
      );
    }
  }
  samples.push(...got.map((s) => ({ ...s, pps: c.pps })));
}

const filmstripCase: EvalCase = {
  name: "filmstrip-under-the-playhead",
  bucket: "filmstrip",
  transitions: false,
  seed: seedTimeCoded("/__cutperf/ramp.mp4", []),
  run: async (page) => {
    await awaitThumbs(page);
    // The user's gesture at three zooms: the fit view, a working zoom, and
    // the deepest the timeline goes.
    const samples: (TileSample & { pps: number })[] = [];
    const notes: string[] = [];
    for (const c of [
      { pps: 60, at: 15 },
      { pps: 300, at: 15.45 },
      { pps: 800, at: 8 },
    ]) {
      await checkMidpoints(page, "/__cutperf/ramp.mp4", c, notes, samples);
    }
    return {
      name: "filmstrip-under-the-playhead",
      bucket: "filmstrip",
      pass: notes.length === 0,
      notes: notes.slice(0, 12),
      tileErr: agg(samples.map((s) => s.err)),
    };
  },
};

/** How far a strip's tile boundary may sit from the scene cut it marks: the
 * detected cut's own precision (an eighth of the probe spacing) plus room
 * for the strip's minimum sub-tile. */
const CUT_ALIGN_S = 0.12;

const filmstripCutsCase: EvalCase = {
  name: "filmstrip-at-scene-cuts",
  bucket: "filmstrip",
  transitions: false,
  seed: seedTimeCoded("/__cutperf/cuts.mp4", FIXTURE_CUTS),
  run: async (page, fx) => {
    await awaitThumbs(page);
    // Zooms where a tile spans a fraction of a scene, parked on a known cut:
    // every tile still shows its own moment, and the strip changes picture at
    // the cut itself — some tile boundary sits on each cut in view.
    const samples: (TileSample & { pps: number })[] = [];
    const notes: string[] = [];
    for (const c of [
      { pps: 150, at: 9 },
      { pps: 400, at: 9 },
    ]) {
      await checkMidpoints(page, "/__cutperf/cuts.mp4", c, notes, samples);
      const misses = await page.evaluate(
        ({ cuts }) => {
          const dev = (window as unknown as {
            __cutDev: { useEditor: { getState(): { pxPerSec: number } } };
          }).__cutDev;
          const pps = dev.useEditor.getState().pxPerSec;
          const scroller = document.querySelector("[data-tl-scroll]") as HTMLElement;
          const box = document.querySelector('[data-tl-sel^="clip:"]') as HTMLElement;
          const view = scroller.getBoundingClientRect();
          const boxR = box.getBoundingClientRect();
          const edges = (Array.from(
            box.querySelectorAll(".tl-filmstrip img")
          ) as HTMLImageElement[]).map((img) => (img.getBoundingClientRect().left - boxR.left) / pps);
          const lo = (Math.max(view.left, boxR.left) - boxR.left) / pps;
          const hi = (Math.min(view.right, boxR.right) - boxR.left) / pps;
          return cuts
            .filter((cut) => cut > lo + 0.5 && cut < hi - 0.5)
            .map((cut) => ({ cut, off: Math.min(...edges.map((e) => Math.abs(e - cut))) }));
        },
        { cuts: fx.cuts }
      );
      if (misses.length === 0) notes.push(`no cuts in view at ${c.pps}px/s`);
      for (const m of misses) {
        if (m.off > CUT_ALIGN_S) {
          notes.push(
            `no tile boundary at the ${m.cut}s cut (nearest ${m.off.toFixed(2)}s away) at ${c.pps}px/s`
          );
        }
      }
    }
    return {
      name: "filmstrip-at-scene-cuts",
      bucket: "filmstrip",
      pass: notes.length === 0,
      notes: notes.slice(0, 12),
      tileErr: agg(samples.map((s) => s.err)),
    };
  },
};

const CASES: EvalCase[] = [
  // The gesture the complaint was about: the pointer slides along the timeline
  // and the picture has to keep up with it, frame by frame.
  scrubCase({
    name: "drag-within-a-clip",
    transitions: false,
    gesture: (page, fx) => sweep(page, fx, 0.4, 2, 40),
    budget: { p50: GATE.scrubP50Ms, p95: GATE.scrubP95Ms },
  }),
  scrubCase({
    name: "drag-across-a-cut",
    transitions: false,
    gesture: (page, fx) => sweep(page, fx, fx.cuts[0] - 1, 2, 40),
    budget: { p50: GATE.scrubP50Ms, p95: GATE.scrubP95Ms },
  }),
  scrubCase({
    name: "drag-across-a-transition",
    transitions: true,
    gesture: (page, fx) => sweep(page, fx, fx.cuts[0] - 1, 2, 40),
    budget: { p50: GATE.scrubP50Ms, p95: GATE.scrubP95Ms },
  }),
  // Landing somewhere else entirely costs a decode from the nearest keyframe,
  // which no arrangement of buffers can avoid. Budgeted for what that costs.
  scrubCase({
    name: "jump-across-the-cut",
    transitions: false,
    gesture: (page, fx) => sweep(page, fx, 0, fx.duration - 0.05, 40),
    budget: { p50: GATE.jumpP50Ms, p95: GATE.jumpP95Ms },
  }),
  playbackCase("play-hard-cuts", false),
  playbackCase("play-with-transitions", true),
  idleCase,
  filmstripCase,
  filmstripCutsCase,
];

// ── Run ─────────────────────────────────────────────────────────────────────

/** A browser with the fixture media served from disk and the session answered. */
async function launch(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: !has("--headed"),
    // Sound is part of the clock, and a headless run has no gesture to unlock
    // the audio context with.
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-donkey-dev-auth-bypass": "1" },
    viewport: { width: 1600, height: 1000 },
  });
  // The editor's session gate is a client-side cookie read, and the only sign-in
  // this build offers is Google's. Answering that one request for the dev-bypass
  // user is the whole of the fake: every other request the page makes is real,
  // and carries the same bypass header the API already accepts in dev.
  await context.route("**/api/auth/get-session*", async (route) => {
    const stamp = new Date(0).toISOString();
    const user = {
      id: DEV_USER,
      name: "cut-perf eval",
      email: "cut-perf@localhost",
      emailVerified: true,
      createdAt: stamp,
      updatedAt: stamp,
      image: null,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user,
        session: {
          id: "cut-perf-session",
          userId: DEV_USER,
          token: "cut-perf",
          expiresAt: new Date(Date.now() + 864e5).toISOString(),
          createdAt: stamp,
          updatedAt: stamp,
        },
      }),
    });
  });
  // Serve the fixture clips from disk, so no upload or network variance sits
  // between the eval and the decoder. Range requests get real 206 slices: a
  // <video> element treats a source without them as unseekable and clamps
  // every seek to zero, which the filmstrip case's ground-truth probe relies
  // on being wrong about.
  await context.route("**/__cutperf/*", async (route, request) => {
    const name = path.basename(new URL(request.url()).pathname);
    const body = await readFile(path.join(OUT, name));
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers()["range"] ?? "");
    if (range) {
      const from = Number(range[1]);
      const to = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      await route.fulfill({
        status: 206,
        body: body.subarray(from, to + 1),
        headers: {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${from}-${to}/${body.length}`,
        },
      });
      return;
    }
    await route.fulfill({
      status: 200,
      body,
      headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes" },
    });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`[pageerror] ${String(e).slice(0, 200)}`));
  page.on("crash", () => console.log("[crash] the page went down"));
  return { browser, page };
}

/** Load the editor and wait until it can be driven. */
async function open(page: Page, projectId: string): Promise<void> {
  await page.goto(`${BASE}/app/p/${projectId}`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __cutDev?: { useEditor: { getState(): { loaded: boolean } } };
        __cutPerf?: unknown;
      };
      return !!w.__cutDev && !!w.__cutPerf && w.__cutDev.useEditor.getState().loaded;
    },
    undefined,
    { timeout: 120_000 }
  );
}

/**
 * Run each case in a process of its own and gather the reports.
 *
 * A case leaves decoders open, a playhead parked somewhere and a mixer mid-cut,
 * and the next case measured in the same page reports that state rather than
 * its own — the same case reads clean alone and ragged fifth in a row. Since
 * what is being measured is the engine from a cold start, the isolation has to
 * be real, and a process is the only boundary that has proved to be.
 */
async function fanOut(names: string[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const name of names) {
    const out = path.join(OUT, `case-${name}.json`);
    const passthrough = ["--base", BASE, ...(has("--headed") ? ["--headed"] : [])];
    await run(process.execPath, [
      import.meta.path,
      "--only",
      name,
      "--out",
      out,
      ...passthrough,
    ]);
    const report = JSON.parse(await readFile(out, "utf8")) as { results: CaseResult[] };
    for (const r of report.results) {
      results.push(r);
      const mark = r.pass ? "ok  " : "FAIL";
      console.log(`[${mark}] ${r.name.padEnd(24)} ${detailOf(r)}${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`);
    }
  }
  return results;
}

const detailOf = (r: CaseResult) =>
  r.scrub
    ? `p50=${r.scrub.p50}ms p95=${r.scrub.p95}ms max=${r.scrub.max}ms n=${r.scrub.n}`
    : r.tileErr
      ? `errP50=${r.tileErr.p50}s errMax=${r.tileErr.max}s n=${r.tileErr.n}`
      : r.idleTicks !== undefined
        ? `ticks=${r.idleTicks}`
        : `late=${r.drops}/${r.presented} atCut=${r.boundaryDrops}`;

async function main(): Promise<void> {
  const files = await buildFixtures();
  await buildRamp();
  await buildCutsClip();
  console.log(`[fixtures] ${files.length} clips + ramp + cuts in ${OUT}`);

  const cases = CASES.filter(
    (c) => (!ONLY || c.name === ONLY) && (!BUCKET || c.bucket === BUCKET)
  );
  if (cases.length === 0) throw new Error("no cases selected");

  // Without a single case named, this run is the coordinator: it drives one
  // child per case and merges what they report.
  if (!ONLY) {
    const results = await fanOut(cases.map((c) => c.name));
    await writeReport(results);
    return;
  }

  const { browser, page } = await launch();
  const res = await fetch(`${BASE}/api/cut/projects?u=${DEV_USER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cut-perf eval" }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status} (is next dev running?)`);
  const projectId = ((await res.json()) as { id: string }).id;
  console.log(`[ready] ${BASE}/app/p/${projectId}`);

  const results: CaseResult[] = [];
  for (const c of cases) {
    for (let i = 0; i < RUNS; i++) {
      await open(page, projectId);
      const fx = await (c.seed ? c.seed(page) : seed(page, files, c.transitions));
      await settle(page);
      const r = await c.run(page, fx);
      results.push(r);
      const mark = r.pass ? "ok  " : "FAIL";
      console.log(`[${mark}] ${c.name.padEnd(24)} ${detailOf(r)}${r.notes.length ? ` — ${r.notes.join("; ")}` : ""}`);
    }
  }

  await browser.close();

  await writeReport(results);
}

async function writeReport(results: CaseResult[]): Promise<void> {
  const report = {
    schema: "cut-perf-eval/v1",
    gate: GATE,
    fixture: { clips: CLIPS, clipSeconds: CLIP_S },
    results,
  };
  const outPath = arg("--out") ?? (ONLY || BUCKET ? null : REPORT);
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[report] ${outPath}`);
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length && ENFORCE) {
    console.error(`\n${failed.length} case(s) breached the gate.`);
    process.exit(1);
  }
  if (failed.length) console.error(`\n${failed.length} case(s) breached the gate (report only).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
