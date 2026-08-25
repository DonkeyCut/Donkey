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
 *   holding sync    — a montage of sub-second clips sliced from one long file
 *                    plays through repeatedly, and the trace is checked for the
 *                    picture falling behind the clock it shares with the sound
 *                    and for late frames rising from the first pass to the
 *                    last. This is the session-decay case: a preview that is
 *                    smooth for a minute and choppy after five fails here.
 *
 * Fixtures build deterministically into dist/cut-perf/ (gitignored) from the
 * bundled stock clips, so the montage's cut times are known exactly.
 *
 * Needs `next dev` on :3000 and the dev auth bypass user. Spends no credits.
 *
 *   npm run eval:cut-perf [--only <case>] [--runs N] [--out path]
 *                         [--enforce-budgets] [--headed]
 *                         [--machine desktop|laptop|ryzen-5500u|potato] [--cpu N]
 *                         [--net <kbps>] [--rtt <ms>]
 */

import { chromium, type Browser, type Page, type Request, type Route } from "playwright";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CUT_MEDIA_ORIGIN } from "../src/cut/lib/hosts";

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

/**
 * The machine this run pretends to be.
 *
 * A preview that holds together on a developer's desktop says very little
 * about the laptop most people edit on. The desktop has decode slots to spare
 * and never falls behind, so the pool's caps never bind, the budget controller
 * never has to do anything, and a regression in either is invisible — every
 * pass composes at the same rate and reports the same numbers. These profiles
 * put the page on a smaller machine and hold the picture to what a viewer
 * would accept there.
 *
 * Two kinds of pressure, because the failure needs both. A slow main thread
 * makes the compositor miss frames. Few decode slots make the decoders behind
 * those frames deliver late, which is the part that actually drifts the
 * picture away from the sound on a real laptop.
 */
interface Machine {
  name: string;
  /** Main-thread slowdown as a multiplier: 6 gives the page a sixth of this
   * machine, applied through the same CDP knob DevTools uses. */
  cpu: number;
  /** Hardware decode slots. A decoder past this still works; it just delivers
   * its frames late, which is what falling back to software costs. Zero means
   * this machine has no hardware video decode at all — a blocklisted driver, a
   * codec the GPU does not carry — and every decoder runs on the CPU. */
  slots: number;
  /** What a frame costs once it is decoding in software. Zero leaves decoding
   * alone, which is what makes a profile a real machine rather than a
   * simulated one. */
  softwareMs: number;
  /** How many streams this machine decodes in software at once before they
   * start splitting a processor between them. A software decoder runs several
   * threads per stream, so a twelve-thread laptop carries a few 720p streams
   * at full rate and slows down past that — it does not decode one stream at a
   * time. Charging every stream by the total number decoding anywhere prices a
   * twelve-clip montage at forty times a frame, which no machine has ever
   * done, and the profile then says nothing about any of them. */
  decodeLanes: number;
  /** How far the picture may sit behind the sound here before a viewer would
   * call it broken. */
  lagP95S: number;
  /** Share of played frames allowed to sit a stall behind the sound. This is
   * the freeze the complaints are about, counted rather than taken at its
   * maximum: a max is one frame out of thousands, and on a throttled profile
   * that one frame is always the keyframe seek at a loop point. Counting how
   * often it happens says whether the picture hitches; the worst single frame
   * says only that a seek happened. */
  stallShare: number;
  /** Late-frame share below which a rise across the play is noise. A machine
   * already dropping a few frames swings by a few frames run to run, and a
   * ratio between two small numbers reads that as decay every other run. */
  decayFloor: number;
  /** Share of played frames that may show a picture which does not belong at
   * that instant. This is the plainest reading of "does the video play": a
   * frame the decoder failed to deliver on time is a frame the viewer sees
   * repeated or missing. */
  lateShare: number;
  /**
   * What this machine's audio output holds before a rendered sample is heard.
   *
   * The developer machine is the quiet one here too: CoreAudio reports a few
   * tens of milliseconds and a picture drawn against the wrong audio clock is
   * off by less than a frame, which nobody sees and no run catches. Shared-mode
   * WASAPI — every Windows browser, by default — reports several times that,
   * and a Bluetooth output more again. Zero leaves the device alone.
   */
  outputLatencyS: number;
  /**
   * What this machine's link to the media host gives it.
   *
   * Cloud media is read as ranged requests over the wire and cached as it
   * arrives (chunkCache.ts), so a walk can be starved of bytes exactly the way
   * it is starved of decode — the picture falls behind, the walk re-anchors,
   * and the seek that ends the lag lands nothing while it runs. Serving every
   * fixture instantly off disk left that half of the picture unmeasured. Zero
   * leaves the route alone, which is what keeps the desktop baseline still.
   */
  netKbps: number;
  /** Round trip to the media host, charged to every ranged request. A chunk
   * read is a request, so this is paid per 2MB rather than once.
   *
   * The rates here are read against the fixture's own bitrate (`LONG_KBPS`).
   * A link at the stream's own rate cannot play it and cache it at once, which
   * is arithmetic rather than a finding; the profiles sit above that, where
   * what the reader does with a late read is what decides the picture. */
  rttMs: number;
}

const MACHINES: Machine[] = [
  // The machine this is being written on: nothing binds, and the numbers are
  // held to the tightest budget in the file.
  { name: "desktop", cpu: 1, slots: 0, softwareMs: 0, decodeLanes: 4, outputLatencyS: 0, netKbps: 0, rttMs: 0, lagP95S: 0.05, stallShare: 0.002, lateShare: 0.02, decayFloor: 0.02 },
  // A mainstream laptop with an integrated GPU.
  { name: "laptop", cpu: 4, slots: 6, softwareMs: 6, decodeLanes: 4, outputLatencyS: 0.12, netKbps: 25_000, rttMs: 40, lagP95S: 0.06, stallShare: 0.04, lateShare: 0.1, decayFloor: 0.1 },
  // The one people report from: a 15W six-core with Vega graphics, running a
  // browser that is also drawing the editor.
  { name: "ryzen-5500u", cpu: 10, slots: 4, softwareMs: 8, decodeLanes: 4, outputLatencyS: 0.12, netKbps: 18_000, rttMs: 60, lagP95S: 0.06, stallShare: 0.03, lateShare: 0.05, decayFloor: 0.08 },
  // Worse than anything anyone has reported, which is the point: what holds
  // here holds on the machines that have not written in yet.
  { name: "potato", cpu: 20, slots: 2, softwareMs: 12, decodeLanes: 2, outputLatencyS: 0.2, netKbps: 18_000, rttMs: 120, lagP95S: 0.1, stallShare: 0.06, lateShare: 0.2, decayFloor: 0.15 },
  // No hardware video decode at all. This is not an exotic machine — a
  // blocklisted driver, a codec the GPU does not carry, a browser started with
  // acceleration off, and every stream is on the CPU. A software decoder is
  // slower than a hardware one; it is not broken, and neither is an editor
  // running on top of one. This profile is held to the same standard a laptop
  // is, because that is the claim.
  { name: "software-decode", cpu: 4, slots: 0, softwareMs: 8, decodeLanes: 4, outputLatencyS: 0.12, netKbps: 25_000, rttMs: 40, lagP95S: 0.06, stallShare: 0.04, lateShare: 0.1, decayFloor: 0.1 },
];

const MACHINE_NAME = arg("--machine") ?? "desktop";
const MACHINE = ((): Machine => {
  const m = MACHINES.find((x) => x.name === MACHINE_NAME);
  if (!m) throw new Error(`unknown --machine ${MACHINE_NAME}; try ${MACHINES.map((x) => x.name).join(", ")}`);
  // `--cpu`, `--slots`, `--sw`, `--net` and `--rtt` override the profile, for
  // finding where a machine actually breaks — and, between them, for telling the two kinds of
  // starvation apart. A case that fails on the profile and passes with the
  // link opened up was starved of bytes; one that fails either way was starved
  // of decode.
  return {
    ...m,
    cpu: Number(arg("--cpu") ?? m.cpu),
    slots: Number(arg("--slots") ?? m.slots),
    softwareMs: Number(arg("--sw") ?? m.softwareMs),
    netKbps: Number(arg("--net") ?? m.netKbps),
    rttMs: Number(arg("--rtt") ?? m.rttMs),
  };
})();
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
const BASE_GATE = {
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
  // Sound is scheduled against the clock the picture is drawn from, so how far
  // the picture sits behind the source moment it was asked for is how far it
  // sits behind the sound. A frame either side of the ask is the picture
  // keeping up; a quarter second is a viewer noticing. Each machine profile
  // sets its own, since what is honest on a desktop is fantasy on a laptop.
  lagP95S: 0.05,
  // A long play must end the way it began: a session that decays is the bug
  // this case exists to catch.
  decayRatio: 1.5,
  // Canvas backing the pool's warm shelf is holding. The shelf trades decoder
  // churn for memory, and this is the side of that trade a change could
  // quietly blow.
  warmMb: 400,
};

/** The budget this run is judged against: the tight one, with the picture-lag
 * limits relaxed to what the chosen machine can honestly hold. */
const GATE = {
  ...BASE_GATE,
  lagP95S: MACHINE.lagP95S,
  stallShare: MACHINE.stallShare,
  lateShare: MACHINE.lateShare,
  decayFloor: MACHINE.decayFloor,
  // A long task is a budget on work, and the throttle divides how much work
  // fits in a millisecond. Thirteen milliseconds of compositing is thirteen
  // milliseconds of compositing whether the CPU runs it in sixteen or in a
  // hundred and sixty, so the budget scales with the machine and keeps meaning
  // the same thing.
  longTaskMs: BASE_GATE.longTaskMs * MACHINE.cpu,
  // A step of a drag is the same work on any machine: read the ring, compose,
  // paint. What changes is how long a millisecond of it takes, so the budgets
  // scale with the throttle for the same reason the long-task one does — a
  // tenth of a machine answering a drag in a tenth of the rate is the drag
  // behaving, and a fixed number would only say the profile is slow.
  scrubP50Ms: BASE_GATE.scrubP50Ms * MACHINE.cpu,
  scrubP95Ms: BASE_GATE.scrubP95Ms * MACHINE.cpu,
  jumpP50Ms: BASE_GATE.jumpP50Ms * MACHINE.cpu,
  jumpP95Ms: BASE_GATE.jumpP95Ms * MACHINE.cpu,
};

/** How far behind the sound the picture has to be for that frame to read as a
 * hitch rather than a beat of lag. */
const STALL_S = 0.25;
/** How far the preview's hold-back may sit from what the output device reports
 * before the picture and the sound are telling different stories. One frame at
 * sixty hertz. */
const CLOCK_SLACK_S = 0.02;
/** Where the preview stops believing a device's claim, mirrored here so a
 * profile past it does not fail a run the preview is handling correctly. */
const CLOCK_CAP_S = 0.4;

// ── Types shared with perfTrace.ts ──────────────────────────────────────────
interface PresentRecord {
  t: number;
  at: number;
  srcTs: number | null;
  wantSrc: number | null;
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
  liveSources: number[];
  keptSources: number[];
  warmMb: number[];
  audioLead: number[];
  audioLatency: number[];
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

// ── The fast-cut fixture ────────────────────────────────────────────────────
//
// The shape people actually edit in: one long file, sliced into a montage of
// sub-second clips in shuffled source order, with sound. Every clip is its own
// decode mapping, so a play crosses a cut about once a second and each cut
// lands on a source moment the last clip's decoder was nowhere near.

/** The fast-cut source: long enough that its slices are spread across the file. */
const MONTAGE_SRC_S = 30;
/** One slice, and how many the montage holds. */
const SHOT_S = 0.9;
const SHOTS = 20;

/** A long clip with sound and a sparse keyframe cadence, which is what a phone
 * or a screen recording gives you. */
async function buildMontageSource(): Promise<void> {
  const dst = path.join(OUT, "montage-src.mp4");
  if (existsSync(dst)) return;
  const src = path.join(STOCK, "animal-dog-sprint.mp4");
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-stream_loop", "-1", "-i", src,
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", String(MONTAGE_SRC_S),
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast", "-g", "60", "-keyint_min", "60",
    "-r", "30", "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    dst,
  ]);
}

/** Where each shot reads from, spread over the source and shuffled by a fixed
 * step so no two neighbours share a decoder or a keyframe. */
const SHOT_INS = Array.from({ length: SHOTS }, (_, i) => {
  const slot = (i * 7) % SHOTS;
  return +((slot / SHOTS) * (MONTAGE_SRC_S - SHOT_S)).toFixed(3);
});

/** Seed the montage: one asset, many short clips, each its own mapping. */
/**
 * The montage, optionally wearing what a real project wears.
 *
 * The bare fixture is footage and cuts, which measures the decoders and very
 * little else. A cut people actually make carries a look and a grade, and both
 * are per-frame work on the compositor's side of the fence — the side a weak
 * CPU runs out of first. Measuring only the bare one leaves the cost that
 * shows up in the reports unmeasured.
 */
const seedMontage = (dressed = false) => async (page: Page): Promise<Fixture> =>
  page.evaluate(
    async ({ ins, shot, srcDuration, dressed }) => {
      const dev = (window as unknown as {
        __cutDev: { useEditor: { getState(): Record<string, unknown>; setState(p: unknown): void } };
      }).__cutDev;
      dev.useEditor.setState({
        assets: [
          {
            id: "montage",
            name: "montage-src.mp4",
            fileName: "montage-src.mp4",
            type: "video",
            url: "/__cutperf/montage-src.mp4",
            duration: srcDuration,
            width: 1280,
            height: 720,
          },
        ],
        clips: ins.map((inPoint, i) => ({
          id: `m-${i}`,
          assetId: "montage",
          track: 0,
          start: +(i * shot).toFixed(3),
          in: inPoint,
          out: +(inPoint + shot).toFixed(3),
          ...(dressed
            ? {
                look: "vhs",
                lookAmount: 0.8,
                grade: { contrast: 12, saturation: 10, temperature: 8, shadows: -6 },
              }
            : {}),
        })),
        audioClips: [],
        overlays: [],
        transitions: [],
        loaded: true,
      });
      await new Promise((r) => setTimeout(r, 200));
      return {
        cuts: ins.slice(1).map((_, i) => +((i + 1) * shot).toFixed(3)),
        duration: +(ins.length * shot).toFixed(3),
      };
    },
    { ins: SHOT_INS, shot: SHOT_S, srcDuration: MONTAGE_SRC_S, dressed }
  );

/** Where the scene-cut fixture changes scene: every three seconds. */
const CUT_SEG_S = 3;
const FIXTURE_CUTS = Array.from({ length: RAMP_S / CUT_SEG_S - 1 }, (_, i) => (i + 1) * CUT_SEG_S);

// ── The one-long-clip fixture ───────────────────────────────────────────────
//
// Most projects are not a montage. One file on the timeline is one continuous
// walk, and a walk is where the lag tolerances in frameSource.ts actually bind:
// a montage re-anchors at every cut, about once a second, and never gives a
// walk the room to fall two seconds behind. This fixture is the other shape,
// and it is read the way a cloud project reads — off the media host, in ranged
// chunks, through the chunk cache.

/** The long clip's length. Played more than once, so the decay measure gets
 * the same span of playback the montage cases get from a shorter fixture. */
const LONG_S = 30;
/** The long clip's bitrate. A music video is denser than stock footage, and
 * density is what decides whether the bytes or the decoder binds first — the
 * reported project was about 14 Mbps. */
const LONG_KBPS = 12_000;

/**
 * One long clip with sound, at `fps`, with keyframes two seconds apart.
 *
 * The keyframe cadence is the load-bearing part. A walk that re-anchors decodes
 * from the keyframe before the ask, so how far back that keyframe sits is what
 * the re-anchor costs, and what the lead in `aheadOf` has to cover.
 */
async function buildLongClip(fps: number): Promise<void> {
  const dst = path.join(OUT, `long-${fps}.mp4`);
  if (existsSync(dst)) return;
  const src = path.join(STOCK, "animal-dog-sprint.mp4");
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-stream_loop", "-1", "-i", src,
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
    "-t", String(LONG_S),
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "veryfast",
    "-g", String(fps * 2), "-keyint_min", String(fps * 2),
    "-b:v", `${LONG_KBPS}k`, "-maxrate", `${LONG_KBPS}k`, "-bufsize", `${LONG_KBPS * 2}k`,
    "-r", String(fps), "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    dst,
  ]);
}

/**
 * A fixture file addressed as cloud media.
 *
 * `chunkIdentity` only claims URLs on the media host (chunkCache.ts), so a
 * fixture served from the page's own origin bypasses the chunk cache entirely
 * — the whole ranged-read path that every cloud project plays through went
 * unmeasured here. Addressing the fixture the way the Worker addresses R2
 * puts it back: a key under `/cut/...`, a `v` cache-version, and reads that
 * arrive as 2MB chunks. The route in `launch()` answers them.
 */
const mediaUrl = (name: string) =>
  `${CUT_MEDIA_ORIGIN}/cut/perf/projects/eval/media/${name}?v=1`;

/** Seed one long clip, read as cloud media. `prefetch` starts the background
 * walk that fills the chunk cache behind the editor, which in a real project
 * is racing the playing walk for the same link — see `prefetchCloudMedia`. */
const seedLongClip = (fps: number, prefetch: boolean) => async (page: Page): Promise<Fixture> =>
  page.evaluate(
    async ({ url, duration, prefetch }) => {
      const dev = (window as unknown as {
        __cutDev: {
          useEditor: { getState(): Record<string, unknown>; setState(p: unknown): void };
          markSignedBatch?: (projectId: string, expiresAt: number | null) => void;
          prefetchCloudMedia?: (
            projectId: string,
            files: { fileName: string; url: string; type?: string }[]
          ) => void;
        };
      }).__cutDev;
      const name = url.split("/").pop()!.split("?")[0];
      dev.useEditor.setState({
        assets: [
          {
            id: "long",
            name,
            fileName: name,
            type: "video",
            url,
            duration,
            width: 1280,
            height: 720,
          },
        ],
        clips: [{ id: "c-long", assetId: "long", track: 0, start: 0, in: 0, out: duration }],
        audioClips: [],
        overlays: [],
        transitions: [],
        loaded: true,
      });
      // The project this is seeded into owns no media of its own, so the link
      // keeper's next re-mint would find nothing for this file and repoint it
      // at the /media route — a URL the fixture route never answers.
      dev.markSignedBatch?.("", null);
      await new Promise((r) => setTimeout(r, 200));
      if (prefetch) {
        dev.prefetchCloudMedia?.("perf-eval", [{ fileName: name, url, type: "video" }]);
      }
      return { cuts: [], duration };
    },
    { url: mediaUrl(`long-${fps}.mp4`), duration: LONG_S, prefetch }
  );

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
        __cutDev: {
          useEditor: { getState(): Record<string, unknown>; setState(p: unknown): void };
          markSignedBatch?: (projectId: string, expiresAt: number | null) => void;
        };
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
      // Fixture files are not the project's media, so nothing re-mints them —
      // see seedLongClip.
      dev.markSignedBatch?.("", null);
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

/**
 * Play from where the playhead is to the end of the cut, and wait for it to
 * get there.
 *
 * Waiting on the playhead rather than on a stopwatch is what makes a slow
 * machine measurable. A fixed timeout cuts the pass off wherever the throttled
 * page happened to have reached, so the run ends early, the trace is a
 * fraction of the length the fast machine's was, and the two are not
 * comparable — one of them simply saw less of the cut. Here every profile
 * plays the whole thing; the slow one just takes longer over it.
 */
async function playThrough(page: Page, duration: number): Promise<void> {
  await setPlaying(page, true);
  await page.waitForFunction(
    (end: number) => {
      const dev = (window as unknown as {
        __cutDev: { playheadAt(): number; useEditor: { getState(): { playing: boolean } } };
      }).__cutDev;
      return dev.playheadAt() >= end || !dev.useEditor.getState().playing;
    },
    duration - 0.05,
    // Generous: a machine given a twelfth of a CPU still has to get to the end,
    // and the point of the wait is that it does.
    { timeout: Math.max(30_000, duration * 6000), polling: 100 }
  );
  await setPlaying(page, false);
}

/** Put the playhead back to the start and wait until it is actually there. */
async function rewind(page: Page): Promise<void> {
  await setPlaying(page, false);
  await seek(page, 0);
  await page.waitForFunction(
    () =>
      (window as unknown as { __cutDev: { playheadAt(): number } }).__cutDev.playheadAt() < 0.01,
    undefined,
    { timeout: 15_000, polling: 100 }
  );
  await page.waitForTimeout(150);
}

/** Wait for the perf hook, then a beat for the picture to catch up. Polled on
 * an interval: a fresh seed kicks off filmstrip captures for every clip, and
 * rAF-polled waits starve under that burst. */
const settle = (page: Page, ms = 15_000) =>
  page
    .waitForFunction(
      () => {
        const perf = (window as unknown as {
          __cutPerf: { stop(): unknown };
        }).__cutPerf;
        return !!perf;
      },
      undefined,
      { timeout: ms, polling: 100 }
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
  liveSources?: number;
  /** Sources the pool kept, and the canvas backing on its warm shelf. */
  keptSources?: number;
  warmMb?: number;
  /** Seconds the picture sat behind the moment it was asked for. */
  lag?: Agg;
  /** Share of frames that sat a quarter second or more behind — the hitch. */
  stallShare?: number;
  /** Late-frame share over the first and last third of a long play. */
  decay?: { first: number; last: number };
  /** Seconds the preview held the picture back for the output device, against
   * the seconds the device reported holding. These agree when the picture is
   * drawn against the sound that is audible rather than the sound that has
   * been rendered. */
  clock?: { lead: number; reported: number };
  /** Seconds between a strip tile's own moment and the moment its picture
   * was captured at. */
  tileErr?: Agg;
  /** Concurrent decoders at their peak, and how many of them had to run in
   * software because this machine had no hardware slot left for them. */
  decoders?: { peak: number; software: number; softwarePeak: number; busyPeak: number };
  /** Which machine profile the run was judged as. */
  machine?: string;
}

interface EvalCase {
  name: string;
  bucket: Bucket;
  transitions: boolean;
  /** Least link this case is measured over — see `linkKbps`. */
  minKbps?: number;
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
        // Long enough that the measurement is the machine's answer rather than
        // this wait: a step that takes a second on a tenth of a machine is a
        // slow step, and the budget is what judges it. Cut off here it would
        // be recorded as a step that never painted at all, which is a
        // different — and untrue — thing to say.
        { timeout: 900 * MACHINE.cpu, polling: "raf" }
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
    if (has("--detail")) await dumpDetail(page, 0);
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
      machine: MACHINE.name,
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
    await playThrough(page, fx.duration);
    const trace = await stopTrace(page);
    const notes: string[] = [];
    if (!trace) return { name, bucket: "playback", pass: false, notes: ["no trace"] };
    const decoders = await page.evaluate(
      () =>
        (
          window as unknown as {
            __cutDecoders?: {
              peak: number;
              software: number;
              softwarePeak: number;
              busyPeak: number;
            };
          }
        ).__cutDecoders ?? null
    );

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
      decoders: decoders ?? undefined,
      machine: MACHINE.name,
    };
  },
});

/**
 * The pool and the engine log between passes, when `--detail` asks for them.
 */
async function dumpDetail(page: Page, pass: number): Promise<void> {
  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __cutDevEngine?: { poolState(): Record<string, unknown>[] };
      __cutDev: { useEditor: { getState(): { clips: unknown[]; playing: boolean } } };
    };
    const s = w.__cutDev.useEditor.getState();
    return { pool: w.__cutDevEngine?.poolState() ?? [], clips: s.clips.length, playing: s.playing };
  });
  const res = await page.evaluate(
    () => (window as unknown as { __resourceStats?: unknown }).__resourceStats ?? null
  );
  console.log(
    `[pool] pass ${pass + 1}: clips=${state.clips} playing=${state.playing} res=${JSON.stringify(res)}`
  );
  for (const s of state.pool) console.log(`[pool]   ${JSON.stringify(s)}`);
  const log = (await page.evaluate(() => {
    const w = window as unknown as { __cutEngineLog?: { at: number; msg: string }[] };
    const out = w.__cutEngineLog ?? [];
    w.__cutEngineLog = [];
    return out;
  })) as { at: number; msg: string }[];
  for (const e of log) console.log(`[elog] ${(e.at / 1000).toFixed(1)}s ${e.msg}`);
}

/** Play the cut through from the start, `passes` times over. */
async function playPasses(page: Page, fx: Fixture, passes: number): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await seek(page, 0);
    await playThrough(page, fx.duration);
    if (has("--detail")) await dumpDetail(page, i);
    await setPlaying(page, false);
  }
}

/**
 * Judge a play: how far the picture sat behind the clock, which clock it was
 * drawn against, whether it decayed across the passes, and what the pool held.
 *
 * `steady` says which presented frames belong to playing rather than to
 * opening a decoder — a montage excludes the moments either side of every cut,
 * one long clip excludes only its own head and tail.
 */
async function judgePlay(
  page: Page,
  name: string,
  passes: number,
  steady: (p: PresentRecord) => boolean,
  // A case whose link cannot carry the stream. Frames that never arrived are
  // the link's arithmetic, so counting them judges the fixture rather than the
  // preview. What such a case is for is whether the picture stayed with the
  // sound while it went short, which the lag and clock notes below still ask.
  starved = false
): Promise<CaseResult> {
  const trace = await stopTrace(page);
  const notes: string[] = [];
  if (!trace) return { name, bucket: "playback", pass: false, notes: ["no trace"] };
  const decoders = await page.evaluate(
    () =>
      (
        window as unknown as {
          __cutDecoders?: {
            peak: number;
            software: number;
            softwarePeak: number;
            busyPeak: number;
          };
        }
      ).__cutDecoders ?? null
  );

  const played = trace.presents.filter(steady);
  if (played.length < 60) {
    return { name, bucket: "playback", pass: false, notes: [`only ${played.length} frames`] };
  }
  const lag = agg(
    played
      .filter((p) => p.srcTs !== null && p.wantSrc !== null)
      .map((p) => Math.max(0, +(p.wantSrc! - p.srcTs!).toFixed(4)))
  );
  const late = played.filter((p) => !p.exact || p.stale);
  const share = (xs: PresentRecord[]) =>
    xs.length ? +(xs.filter((p) => !p.exact || p.stale).length / xs.length).toFixed(3) : 0;
  const third = Math.floor(played.length / 3);
  const decay = { first: share(played.slice(0, third)), last: share(played.slice(-third)) };
  if (has("--detail")) {
    const span = (trace.presents.at(-1)!.at - trace.presents[0].at) / 1000;
    console.log(
      `[detail] presents=${trace.presents.length} over ${span.toFixed(1)}s (${(
        trace.presents.length / span
      ).toFixed(1)}/s) stale=${played.filter((p) => p.stale).length} notExact=${
        played.filter((p) => !p.exact && !p.stale).length
      } sources p50=${agg(trace.liveSources).p50} max=${agg(trace.liveSources).max} held p50=${
        agg(trace.liveSamples).p50
      } max=${agg(trace.liveSamples).max}`
    );
    for (let i = 0; i < passes; i++) {
      const from = (i * played.length) / passes;
      const slice = played.slice(Math.floor(from), Math.floor(from + played.length / passes));
      const gaps = slice.slice(1).map((p, j) => p.at - slice[j].at);
      console.log(
        `[detail] pass ${i + 1}: late=${share(slice)} lagP95=${
          agg(slice.filter((p) => p.srcTs !== null).map((p) => Math.max(0, p.wantSrc! - p.srcTs!)))
            .p95
        }s frameGapP95=${agg(gaps).p95}ms n=${slice.length}`
      );
      // Which clips went dark, and for how long at a stretch.
      const byClip = new Map<string, { n: number; stale: number; worst: number }>();
      let streak = 0;
      for (let j = 0; j < slice.length; j++) {
        const p = slice[j];
        const key = p.clipId ?? "none";
        const row = byClip.get(key) ?? { n: 0, stale: 0, worst: 0 };
        row.n++;
        if (p.stale) {
          row.stale++;
          streak = streak + (j > 0 ? p.at - slice[j - 1].at : 0);
          row.worst = Math.max(row.worst, streak);
        } else {
          streak = 0;
        }
        byClip.set(key, row);
      }
      const dark = [...byClip.entries()]
        .filter(([, r]) => r.stale > 0)
        .sort((a, b) => b[1].stale / b[1].n - a[1].stale / a[1].n)
        .map(([id, r]) => `${id}:${Math.round((100 * r.stale) / r.n)}%/${Math.round(r.worst)}ms`);
      if (dark.length) console.log(`[detail]   dark ${dark.join(" ")}`);
    }
  }

  // The plainest question this case asks, and the one a viewer would ask:
  // did the frames arrive. A run where nothing decoded at all used to score
  // a clean sheet here — every frame stale, no lag to measure, because there
  // was never a picture to be behind.
  const lateShare = +(late.length / played.length).toFixed(3);
  if (!starved && lateShare > GATE.lateShare) {
    notes.push(`${Math.round(lateShare * 100)}% of frames did not arrive on time`);
  }
  if (decoders && decoders.peak === 0) notes.push("nothing decoded at all");
  if (lag.p95 > GATE.lagP95S) notes.push(`picture ${lag.p95}s behind the clock at p95`);
  // Which clock the picture is drawn against, which the lag above cannot ask:
  // a picture drawn against the rendered clock is exactly on time against it
  // and a tenth of a second early against the speakers. The device's own
  // answer is the reference, capped where the preview caps it so a driver
  // claiming something absurd cannot fail a run on its own.
  const lead = agg(trace.audioLead ?? []);
  const reported = agg(trace.audioLatency ?? []);
  const owed = Math.min(CLOCK_CAP_S, reported.p50);
  if (reported.n > 0 && Math.abs(lead.p50 - owed) > CLOCK_SLACK_S) {
    notes.push(
      `picture drawn ${Math.round((owed - lead.p50) * 1000)}ms ahead of the sound: ` +
        `the output holds ${Math.round(owed * 1000)}ms and the clock gives back ${Math.round(lead.p50 * 1000)}ms`
    );
  }
  const behind = played.filter((p) => p.srcTs !== null && p.wantSrc! - p.srcTs! > STALL_S);
  const stallShare = +(behind.length / played.length).toFixed(4);
  if (stallShare > GATE.stallShare) {
    notes.push(`picture hitched a quarter second behind on ${(stallShare * 100).toFixed(1)}% of frames`);
  }
  if (!starved && passes > 1 && decay.last > Math.max(GATE.decayFloor, decay.first * GATE.decayRatio)) {
    notes.push(`late frames rose ${decay.first} → ${decay.last} over the play`);
  }
  const warmMb = Math.max(0, ...trace.warmMb);
  if (warmMb > GATE.warmMb) notes.push(`warm shelf holding ${warmMb}MB of canvas`);
  // Long tasks are reported, not gated: this case judges sync, decay and
  // memory, and the stray dev-build hiccup that leaves every frame exact is
  // not a fail.
  return {
    name,
    bucket: "playback",
    pass: notes.length === 0,
    notes,
    drops: late.length,
    presented: played.length,
    lag,
    stallShare,
    decay,
    clock: { lead: lead.p50, reported: +reported.p50.toFixed(3) },
    longTasks: agg(trace.longTasks.map((l) => l.ms)),
    liveSamples: Math.max(0, ...trace.liveSamples),
    liveSources: Math.max(0, ...trace.liveSources),
    keptSources: Math.max(0, ...trace.keptSources),
    warmMb,
    decoders: decoders ?? undefined,
    machine: MACHINE.name,
  };
}

/**
 * A montage played straight through, `passes` times over, with the sound on.
 *
 * What it measures is drift: how far the picture sits behind the moment the
 * clock asked for, and whether the last pass is worse than the first. A single
 * pass answers "does a fast cut play"; several answer "does it still play after
 * a while", which is the complaint this case was written for.
 */
const montageCase = (name: string, passes: number, dressed = false): EvalCase => ({
  name,
  bucket: "playback",
  transitions: false,
  seed: seedMontage(dressed),
  run: async (page, fx) => {
    await rewind(page);
    // One pass before the trace, so what follows measures playing rather than
    // opening twenty decoders for the first time.
    await setPlaying(page, true);
    await page.waitForTimeout(WARM_PLAY_S * 1000);
    await rewind(page);
    await settle(page);
    await startTrace(page);
    await playPasses(page, fx, passes);
    // The moments a clip's decoder is being opened for the first time in a pass
    // belong to the open, so the measure starts a beat inside every clip and
    // ends a beat before the cut.
    return judgePlay(page, name, passes, (p) => {
      const into = p.t % SHOT_S;
      return p.t > 0.4 && p.t < fx.duration - 0.3 && into > 0.15 && into < SHOT_S - 0.05;
    });
  },
});

/**
 * One long clip, played straight through more than once.
 *
 * Three things this shape measures that a montage cannot. A single walk runs
 * long enough to fall behind, which is where `LAG_HOP_S` and the re-aim in
 * `aheadOf` bind and where the sawtooth people report as choppiness lives. The bytes
 * arrive over the media host through the chunk cache, so a walk starved of
 * bytes is distinguishable from one starved of decode. And `cold` traces the
 * very first play, before anything is resident — the state every editor opens
 * in, and the one the reports cluster in.
 *
 * `remount` is the other half of that report: the editor is closed and
 * reopened between the warm pass and the traced one, so the play being judged
 * is the one after coming back. Every decoder, every parsed file, and every
 * ranged request in the air goes with the old engine (`pool.closeAll`), and
 * the second play has to meet the same gate as the first anyway.
 */
const longClipCase = (
  name: string,
  opts: {
    fps: number;
    passes?: number;
    cold?: boolean;
    remount?: boolean;
    prefetch?: boolean;
    minKbps?: number;
    starved?: boolean;
  }
): EvalCase => {
  const passes = opts.passes ?? 2;
  const seed = seedLongClip(opts.fps, opts.prefetch ?? true);
  return {
    name,
    bucket: "playback",
    transitions: false,
    minKbps: opts.minKbps,
    seed,
    run: async (page, fx) => {
      if (!opts.cold) {
        // A whole pass before the trace, so what follows measures playing
        // rather than reading the file for the first time — and the file here
        // is read over the link, so a couple of seconds of warming would leave
        // almost all of it still to arrive. The cold case skips this on
        // purpose: reading it for the first time is what that one measures.
        await rewind(page);
        await playThrough(page, fx.duration);
        await rewind(page);
        await settle(page);
      }
      if (opts.remount) {
        await setPlaying(page, false);
        const id = currentProjectId(page.url());
        // A reopen paints the cached snapshot first and `loaded` goes true on
        // that, so seeding straight after the open would be overwritten by the
        // live document a moment later — and the live copy carries the /media
        // route URL for a file the fixture route does not answer. Wait for the
        // document itself, then seed on top of it.
        const live = page.waitForResponse(
          (r) => r.url().includes(`/api/cut/projects/${id}`) && r.request().method() === "GET",
          { timeout: 60_000 }
        );
        await open(page, id);
        await live;
        await page.waitForTimeout(500);
        await seed(page);
        await settle(page);
      }
      await startTrace(page);
      await playPasses(page, fx, passes);
      // One clip, so only its own head and tail belong to the open.
      return judgePlay(
        page,
        name,
        passes,
        (p) => p.t > 1 && p.t < fx.duration - 0.3,
        opts.starved ?? false
      );
    },
  };
};

/** The project id out of the editor's own URL, for a case that reopens it. */
const currentProjectId = (url: string) => url.split("/p/")[1]?.split(/[?#]/)[0] ?? "";

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
  montageCase("play-fast-cuts", 1),
  montageCase("play-fast-cuts-long", 4),
  // One file on the timeline, which is what most projects are. Warm first, so
  // this one is about decode alone.
  longClipCase("play-one-long-clip", { fps: 30 }),
  // The same clip at sixty. `DECODE_AHEAD_S` asks for 0.3s of lookahead and
  // the ring holds ten frames, so above thirty a second the frame count binds
  // first and the buffered span silently halves.
  longClipCase("play-one-long-clip-60fps", { fps: 60 }),
  // Traced from the very first play, with nothing resident: the bytes arrive
  // over the link while the walk is already reading. Measured over a link with
  // real headroom, since what a first read owes is a picture that keeps up
  // once the bytes can arrive in time — a link at the stream's own rate cannot
  // deliver them and that is arithmetic, not a reader.
  longClipCase("play-cold-bytes", { fps: 30, cold: true, minKbps: LONG_KBPS * 3 }),
  // The editor closed and reopened between the warm pass and the traced one.
  longClipCase("play-after-remount", { fps: 30, remount: true }),
  // The same play with nothing reading ahead of it. The background walk that
  // fills the chunk cache shares the link with the walk that is playing, and
  // this is the case that says how much of the link it is taking.
  longClipCase("play-without-readahead", { fps: 30, prefetch: false }),
  // A first read over a link that cannot carry the stream. The bytes are not
  // going to arrive in time and no reader can invent them, so this one is not
  // about late frames: it is about what the picture does while it waits. The
  // sound plays on regardless, and the rule is that the picture stays with it
  // and gives up resolution and smoothness instead of drifting seconds behind.
  // Run it with `--net` under the fixture's own rate; the profile links all
  // sit above it, so it says nothing until asked.
  // Only when a link is named. A cold first read is the noisiest thing the
  // suite can measure — the open, the keyframe walk and the first bytes all
  // land inside the traced pass — and on an unthrottled profile it measures
  // that noise rather than the link. It earns its keep under `--net` below the
  // fixture's rate, where it answers what the picture does when the bytes
  // genuinely cannot arrive in time.
  ...(has("--net") ? [longClipCase("play-cold-slow-link", { fps: 30, cold: true, starved: true })] : []),
  // The same montage graded and looked, which is what the cost of a real
  // project's frame looks like on a machine that has none to spare.
  montageCase("play-fast-cuts-graded", 2, true),
  idleCase,
  filmstripCase,
  filmstripCutsCase,
];

// ── Run ─────────────────────────────────────────────────────────────────────

/**
 * The link the throttle is charging against, which a case may raise.
 *
 * A profile's link sits close enough to the fixture's own bitrate that what a
 * reader does with a late read decides the picture. That is the right setting
 * for a play whose file is already on disk, and the wrong one for a first-ever
 * read: bytes that have not arrived cannot be shown by any reader, so holding
 * one to them measures the link's arithmetic rather than the engine. A case
 * about first reads raises this to where the link is not the answer.
 */
let linkKbps = MACHINE.netKbps;

/** Pause for the profile's round trip, then for as long as the link takes to
 * carry `bytes`. Zero on either leaves the response alone, which is what keeps
 * the desktop baseline still. */
const charge = (bytes: number): Promise<void> => {
  const ms = MACHINE.rttMs + (linkKbps > 0 ? (bytes * 8) / linkKbps : 0);
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
};

/** Headers a cross-origin media read needs back. The chunk cache reads
 * `Content-Range` to learn the object's size, and a browser hides it from a
 * cross-origin response unless it is named here. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
};

/**
 * One fixture file. A `Range` header is not a simple header, so a cross-origin
 * read preflights and that is answered here too.
 *
 * `paced` is what separates the two media residencies this serves. A file the
 * browser already holds — an import in OPFS, a local project's own bytes — is
 * a disk read, and that is every fixture addressed at `/__cutperf/`. Cloud
 * media is read over the wire, and only those reads are charged the profile's
 * link.
 */
async function serveFixture(route: Route, request: Request, paced: boolean): Promise<void> {
  if (request.method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS });
    return;
  }
  const name = path.basename(new URL(request.url()).pathname);
  const body = await readFile(path.join(OUT, name));
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers()["range"] ?? "");
  const from = range ? Number(range[1]) : 0;
  const to = range
    ? range[2]
      ? Math.min(Number(range[2]), body.length - 1)
      : body.length - 1
    : body.length - 1;
  const slice = body.subarray(from, to + 1);
  if (paced) await charge(slice.length);
  await route.fulfill({
    status: range ? 206 : 200,
    body: slice,
    headers: {
      ...CORS,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${from}-${to}/${body.length}` } : {}),
    },
  });
}

/** A browser with the fixture media served from disk and the session answered. */
/**
 * Give the page a fixed number of hardware decode slots.
 *
 * Chrome hands a tab as many as the GPU and driver happen to allow and offers
 * no way to ask for fewer, so this stands in for that limit: a decoder built
 * once the slots are gone has its output deferred, which is what falling back
 * to software costs the picture — the frames still arrive, they just arrive
 * late. Everything else about the decoder is the real one.
 *
 * What it charges is a rate, not a delay. This distinction is the whole model:
 * a decoder that hands every frame over 90ms late still delivers thirty of
 * them a second, and playback barely notices. A decoder that can only finish a
 * frame every 90ms delivers eleven, and playback starves. Software decoding is
 * the second kind, so each stream here has a queue and a frame leaves it only
 * once the one before it has had its turn.
 *
 * The turn costs more the more streams are *working* at that moment, past what
 * the machine decodes at once — twelve streams on a machine that carries four
 * of them run at three times the cost, and the bigger the frames the more
 * again, since decode cost runs with pixel count. Working is the word that
 * matters. A preview walk fills its ring
 * a fraction of a second ahead and then stops until something reads it, and a
 * decoder sitting there having decoded nothing recently costs a CPU nothing.
 * Charging for open decoders rather than busy ones would make the eval argue
 * for closing decoders that were already free, which is a fix aimed at the
 * wrong thing.
 *
 * Both of these are levers the preview can pull: how many streams it keeps
 * fed, and how large it decodes. Modelling them is what lets the eval say
 * which lever is worth pulling.
 *
 * Browser source, injected before any page script, so `window.VideoDecoder` is
 * already wrapped by the time the preview reaches for it.
 */
const decoderShim = ({ slots, softwareMs, decodeLanes }: Machine) => `
(() => {
  const Native = window.VideoDecoder;
  if (!Native) return;
  const stats = (window.__cutDecoders = { peak: 0, software: 0, softwarePeak: 0, busyPeak: 0 });
  let live = 0;
  let onCpu = 0;
  // When each software stream last finished a frame. A stream that has not
  // decoded recently is not on the CPU, whatever else it is holding open.
  const lastOut = new Map();
  const BUSY_MS = 250;
  const busy = (now) => {
    let n = 0;
    for (const [d, at] of lastOut) {
      if (now - at < BUSY_MS) n++;
      else lastOut.delete(d);
    }
    return n;
  };
  const freed = new WeakSet();
  const slow = new WeakSet();
  window.VideoDecoder = class extends Native {
    constructor(init) {
      const overflow = live >= ${slots};
      // When this stream's next frame can come off the CPU.
      let turn = 0;
      super(
        overflow
          ? Object.assign({}, init, {
              output: (frame) => {
                // Cost runs with area, against 720p as the unit, and with how
                // many streams are splitting the CPU right now.
                const area = ((frame.codedWidth || 1280) * (frame.codedHeight || 720)) / (1280 * 720);
                const now = performance.now();
                lastOut.set(this, now);
                const sharing = Math.max(1, busy(now) / ${decodeLanes});
                stats.busyPeak = Math.max(stats.busyPeak, sharing);
                const cost = ${softwareMs} * sharing * area;
                // The queue: this frame waits for the one before it to finish.
                turn = Math.max(now, turn) + cost;
                setTimeout(() => init.output(frame), turn - now);
              },
            })
          : init
      );
      live++;
      stats.peak = Math.max(stats.peak, live);
      if (overflow) {
        slow.add(this);
        onCpu++;
        stats.software++;
        stats.softwarePeak = Math.max(stats.softwarePeak, onCpu);
      }
    }
    close() {
      if (!freed.has(this)) {
        freed.add(this);
        live--;
        if (slow.has(this)) onCpu--;
      }
      return super.close();
    }
  };
})();
`;

/**
 * Make the page's audio output hold as long as this machine's does.
 *
 * `outputLatency` is the device's answer, and on the machine this is written on
 * the answer is small enough that a preview ignoring it is wrong by less than a
 * frame. Reporting a Windows-sized buffer instead is what makes the gate below
 * mean something: a picture drawn against the rendered clock rather than the
 * audible one now sits a tenth of a second ahead of its own sound, which is
 * what the reports describe.
 *
 * Only the reading changes. The samples still leave the machine when they
 * leave it; what is under test is whether the preview reads the device at all.
 */
const audioShim = (seconds: number) => `
(() => {
  const patch = (Klass) => {
    if (!Klass) return;
    const d = Object.getOwnPropertyDescriptor(Klass.prototype, "outputLatency");
    Object.defineProperty(Klass.prototype, "outputLatency", {
      configurable: true,
      get() {
        const own = d && d.get ? d.get.call(this) : 0;
        return (own || 0) + ${seconds};
      },
    });
  };
  patch(window.AudioContext);
  patch(window.webkitAudioContext);
})();
`;

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
  // The shim is what enforces the slot limit as well as the per-frame cost, so
  // asking for slots on a profile that pays no CPU cost has to install it too.
  // Without this, `--slots 2` on a profile whose `softwareMs` is 0 parses,
  // threads through to the child, and changes nothing at all.
  if (MACHINE.softwareMs > 0 || arg("--slots"))
    await context.addInitScript({ content: decoderShim(MACHINE) });
  if (MACHINE.outputLatencyS > 0)
    await context.addInitScript({ content: audioShim(MACHINE.outputLatencyS) });
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
  // With `--detail`, count what the page opens against what it lets go of:
  // a picture that locks up mid-session is usually a resource nobody closed.
  if (has("--detail")) {
    await context.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      const stats = { made: 0, closed: 0, errors: 0, lastError: "", canvases: 0, pixels: 0 };
      w.__resourceStats = stats;
      const RealDecoder = (w as { VideoDecoder?: unknown }).VideoDecoder as
        | (new (init: { error?: (e: unknown) => void }) => { close(): void })
        | undefined;
      if (RealDecoder) {
        w.VideoDecoder = class extends RealDecoder {
          constructor(init: { error?: (e: unknown) => void }) {
            super({
              ...init,
              error: (e: unknown) => {
                stats.errors++;
                stats.lastError = String(e).slice(0, 200);
                init.error?.(e);
              },
            });
            stats.made++;
          }
          close() {
            stats.closed++;
            return super.close();
          }
        };
        Object.assign(w.VideoDecoder as object, RealDecoder);
      }
      const f = Object.assign(stats, { fetches: 0, fetchLive: 0, fetchWorst: 0 });
      const realFetch = window.fetch.bind(window);
      window.fetch = (async (...fetchArgs: Parameters<typeof fetch>) => {
        f.fetches++;
        f.fetchLive++;
        f.fetchWorst = Math.max(f.fetchWorst, f.fetchLive);
        try {
          return await realFetch(...fetchArgs);
        } finally {
          f.fetchLive--;
        }
      }) as typeof fetch;
      const create = document.createElement.bind(document);
      document.createElement = ((tag: string, ...rest: unknown[]) => {
        const el = create(tag as "canvas", ...(rest as []));
        if (tag === "canvas") {
          stats.canvases++;
          queueMicrotask(() => {
            const c = el as HTMLCanvasElement;
            stats.pixels += c.width * c.height;
          });
        }
        return el;
      }) as typeof document.createElement;
    });
  }
  // The welcome sequence opens over the editor for an account that has yet to
  // run it, covers the stage and holds playback. Answering the account read as
  // finished keeps the eval on the editor, whatever the dev account's row says.
  await context.route("**/api/account/onboarding*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        version: 99,
        completedAt: new Date(0).toISOString(),
        skipped: false,
        referralSources: [],
        referralOther: null,
      }),
    });
  });
  // Serve the fixture clips from disk. Range requests get real 206 slices: a
  // <video> element treats a source without them as unseekable and clamps
  // every seek to zero, which the filmstrip case's ground-truth probe relies
  // on being wrong about.
  //
  // Cloud media's link is charged in the route rather than through CDP's
  // network emulation, which throttles the whole context: the page, the dev
  // build's module graph and the API all have to arrive at their usual speed,
  // or every case measures Next's first load.
  await context.route("**/__cutperf/*", (route, request) => serveFixture(route, request, false));
  // The same files addressed as cloud media, which is the path a cloud project
  // actually plays: `chunkIdentity` claims this origin, so reads arrive as 2MB
  // ranged chunks through the chunk cache and land in OPFS as they do.
  await context.route(`${CUT_MEDIA_ORIGIN}/**`, (route, request) => serveFixture(route, request, true));
  const page = await context.newPage();
  if (MACHINE.cpu > 1 || MACHINE.softwareMs > 0 || arg("--slots")) {
    if (MACHINE.cpu > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: MACHINE.cpu });
    }
    console.log(
      `[machine] ${MACHINE.name}: cpu 1/${MACHINE.cpu}` +
        (MACHINE.softwareMs || arg("--slots")
          ? `, ${MACHINE.slots || "no"} hardware decode slot${MACHINE.slots === 1 ? "" : "s"}`
          : "") +
        (MACHINE.softwareMs ? `, +${MACHINE.softwareMs}ms per frame on the CPU` : "")
    );
  }
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
/** A fresh project on the dev account for one run to seed into. */
async function newProject(): Promise<string> {
  const res = await fetch(`${BASE}/api/cut/projects?u=${DEV_USER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "cut-perf eval" }),
  });
  if (!res.ok) throw new Error(`create project failed: ${res.status} (is next dev running?)`);
  return ((await res.json()) as { id: string }).id;
}

async function fanOut(names: string[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const name of names) {
    const out = path.join(OUT, `case-${name}.json`);
    const passthrough = [
      "--base",
      BASE,
      "--machine",
      MACHINE_NAME,
      "--runs",
      String(RUNS),
      ...(has("--headed") ? ["--headed"] : []),
      ...(arg("--cpu") ? ["--cpu", String(MACHINE.cpu)] : []),
      ...(arg("--slots") ? ["--slots", String(MACHINE.slots)] : []),
      ...(arg("--sw") ? ["--sw", String(MACHINE.softwareMs)] : []),
      ...(arg("--net") ? ["--net", String(MACHINE.netKbps)] : []),
      ...(arg("--rtt") ? ["--rtt", String(MACHINE.rttMs)] : []),
    ];
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
        : r.lag
          ? `late=${r.drops}/${r.presented} lagP95=${r.lag.p95}s hitch=${((r.stallShare ?? 0) * 100).toFixed(1)}% lagMax=${r.lag.max}s sources=${r.liveSources} sw=${r.decoders?.softwarePeak ?? "-"}/${r.decoders?.software ?? "-"} busy=${r.decoders?.busyPeak ?? "-"} clock=${Math.round((r.clock?.lead ?? 0) * 1000)}/${Math.round((r.clock?.reported ?? 0) * 1000)}ms warm=${r.warmMb}MB decay=${r.decay?.first}→${r.decay?.last}`
          : `late=${r.drops}/${r.presented} atCut=${r.boundaryDrops}`;

async function main(): Promise<void> {
  const files = await buildFixtures();
  await buildRamp();
  await buildCutsClip();
  await buildMontageSource();
  await buildLongClip(30);
  await buildLongClip(60);
  console.log(`[fixtures] ${files.length} clips + ramp + cuts + long 30/60 in ${OUT}`);

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

  const results: CaseResult[] = [];
  for (const c of cases) {
    for (let i = 0; i < RUNS; i++) {
      // A project per run. Seeding a second time into one that already holds
      // the first run's clips leaves the editor with media it cannot decode,
      // and every frame after that is a frame the picture never arrived for —
      // which read as a clean sheet for as long as the only gates here were
      // about lag, since a picture that never comes is never behind.
      // Set from the profile every case, rather than raised and left. A case
      // that asks for a faster link asks for itself alone: carried forward, it
      // would hand every case after it a link the profile never granted, and
      // they would pass on a machine the profile says they should not.
      linkKbps =
        c.minKbps && MACHINE.netKbps > 0
          ? Math.max(MACHINE.netKbps, c.minKbps)
          : MACHINE.netKbps;
      const projectId = await newProject();
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
    machine: MACHINE,
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

  // A case is judged on its runs together. On a machine deliberately starved
  // of CPU one bad run in three is the noise floor, and a gate that trips on
  // it is a gate people learn to re-run until it goes green.
  const byCase = new Map<string, CaseResult[]>();
  for (const r of results) {
    const runs = byCase.get(r.name) ?? [];
    runs.push(r);
    byCase.set(r.name, runs);
  }
  const failed = [...byCase].filter(([, runs]) => runs.filter((r) => !r.pass).length * 2 > runs.length);
  if (failed.length) {
    const how = failed
      .map(([name, runs]) => `${name} (${runs.filter((r) => !r.pass).length}/${runs.length})`)
      .join(", ");
    console.error(`\n${failed.length} case(s) breached the ${MACHINE.name} gate: ${how}`);
    if (ENFORCE) process.exit(1);
    console.error("(report only)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
