import { describe, expect, test } from "bun:test";
import {
  runExport,
  type ExportPipelineIO,
  type ExportSpec,
  type RenderHandle,
} from "./exportPipeline";

// Builds the real encode filtergraph for a spec by running the pipeline with
// its edges stubbed: media exists, every stream probes present, SDR color,
// libx264, and ffmpeg runs are captured instead of spawned.
const graphFor = async (over: Partial<ExportSpec>): Promise<string[]> => {
  const ffmpegCalls: string[][] = [];
  const io: ExportPipelineIO = {
    stat: (async () => ({ isFile: () => true })) as unknown as ExportPipelineIO["stat"],
    writeFile: (async () => {}) as unknown as ExportPipelineIO["writeFile"],
    hasStream: async () => true,
    videoColorInfo: async () => null,
    h264Encoder: async () => "libx264",
    runFfmpeg: async (_job, args) => {
      ffmpegCalls.push(args);
    },
  };
  const clips = over.clips ?? [];
  const spec: ExportSpec = {
    projectId: "p",
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 24,
    preset: "veryfast",
    duration: clips.reduce(
      (s, c) => s + (c.out - c.in) / (c.speed && c.speed > 0 ? c.speed : 1),
      0
    ),
    clips,
    audio: [],
    overlays: [],
    ...over,
  };
  const job: RenderHandle = {
    tmpDir: "/tmp/graph-test",
    outPath: "/tmp/graph-test/out.mp4",
    progress: 0,
    log: [],
  };
  await runExport(job, spec, (f) => `/media/${f}`, io);
  const enc = ffmpegCalls[0];
  return enc[enc.indexOf("-filter_complex") + 1].split(";");
};

type Clip = ExportSpec["clips"][number];
const clip = (file: string, over: Partial<Clip> = {}): Clip => ({
  file,
  in: 0,
  out: 4,
  muted: false,
  ...over,
});

// ---------------------------------------------------------------------------
// A model of ffmpeg's link negotiation, as far as xfade cares: each stream
// carries a timebase and a constant-frame-rate stamp. `fps` (and a `color`
// source with `r=`) stamps 1/rate; the concat filter resets its output to the
// microsecond timebase with no rate; `trim`/`setpts` keep the timebase but
// clear the rate; every other filter passes its first input through. xfade
// aborts the whole export when its two inputs differ — the mismatch this
// model exists to catch:
//   [Parsed_xfade] First input link main timebase (1/1000000) do not match
//   the corresponding second input link xfade timebase (1/30)
// ---------------------------------------------------------------------------

type Pad = { tb: string; cfr: boolean };

const argValue = (args: string, key: string) =>
  new RegExp(`(?:^|:)${key}=([0-9.]+)`).exec(args)?.[1];

/** Split a chain body on top-level commas; quoted spans (enable exprs) stay
 * whole. */
const splitFilters = (body: string): string[] => {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
};

const parseChain = (raw: string) => {
  const inputs: string[] = [];
  let rest = raw;
  for (let m; (m = /^\[([^\]]+)\]/.exec(rest)); ) {
    inputs.push(m[1]);
    rest = rest.slice(m[0].length);
  }
  const outs: string[] = [];
  for (let m; (m = /\[([^\]]+)\]$/.exec(rest)); ) {
    outs.unshift(m[1]);
    rest = rest.slice(0, -m[0].length);
  }
  return { raw, inputs, outs, filters: splitFilters(rest) };
};

const pad = (p: Pad) => `${p.tb}${p.cfr ? "" : " (no rate)"}`;

/** Walks every chain of the graph, propagating each labeled stream's pad
 * state, and reports every xfade whose two inputs arrive with different
 * timebases or without a constant-rate stamp. Chains wait until all their
 * input labels are defined, so definition order in the graph is free. */
const xfadeMismatches = (chains: string[]): string[] => {
  const problems: string[] = [];
  const states = new Map<string, Pad>();
  const inputState = (label: string): Pad | undefined =>
    states.get(label) ??
    (/^\d+:[va]$/.test(label) ? { tb: `source ${label}`, cfr: false } : undefined);
  const pending = chains.map(parseChain);
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const { raw, inputs, outs, filters } = pending[i];
      const inStates = inputs.map(inputState);
      if (inStates.some((s) => s === undefined)) continue;
      pending.splice(i--, 1);
      progressed = true;
      let cur: Pad = inStates[0] ?? { tb: "generated", cfr: false };
      filters.forEach((f, fi) => {
        const eq = f.indexOf("=");
        const name = eq === -1 ? f : f.slice(0, eq);
        const args = eq === -1 ? "" : f.slice(eq + 1);
        if (name === "fps") {
          cur = { tb: `1/${argValue(args, "fps") ?? /^([\d.]+)/.exec(args)?.[1]}`, cfr: true };
        } else if (name === "color") {
          cur = { tb: `1/${argValue(args, "r") ?? argValue(args, "rate") ?? "25"}`, cfr: true };
        } else if (name === "xfade") {
          if (fi !== 0 || inputs.length !== 2) {
            problems.push(`xfade needs two chain-leading inputs: ${raw}`);
          } else {
            const [a, b] = inStates as Pad[];
            if (!a.cfr || !b.cfr || a.tb !== b.tb) {
              problems.push(`xfade inputs mismatch — ${pad(a)} vs ${pad(b)}: ${raw}`);
            }
          }
        } else if (name === "concat") {
          cur = { tb: "1/1000000 (concat)", cfr: false };
        } else if (name === "trim" || name === "setpts") {
          cur = { tb: cur.tb, cfr: false };
        }
      });
      for (const o of outs) states.set(o, cur);
    }
  }
  for (const p of pending) problems.push(`inputs never defined: ${p.raw}`);
  return problems;
};

describe("export filtergraph timebases", () => {
  test("the model flags a transition joined onto a bare concat", () => {
    const join = (cut: string) => [
      "[0:v]fps=30[s0]",
      "[1:v]fps=30[s1]",
      `[s0][s1]${cut}[cut]`,
      "[2:v]fps=30[s2]",
      "[s2]tpad=start_duration=0.500:start_mode=clone[h2]",
      "[cut][h2]xfade=transition=fade:duration=0.500:offset=7.500[out]",
    ];
    expect(xfadeMismatches(join("concat=n=2:v=1:a=0"))).toHaveLength(1);
    expect(xfadeMismatches(join("concat=n=2:v=1:a=0,fps=30"))).toEqual([]);
  });

  test("a transition after a hard cut joins matched streams", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4"),
        clip("b.mp4", { transition: 0.5, transitionStyle: "crossfade" }),
        clip("c.mp4"),
      ],
    });
    expect(g.join(";")).toContain("xfade=");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("every join transitioned, styles mixed", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { transition: 0.4, transitionStyle: "crossfade" }),
        clip("b.mp4", { transition: 0.4, transitionStyle: "pushleft" }),
        clip("c.mp4", { transition: 0.4, transitionStyle: "circleopen" }),
        clip("d.mp4"),
      ],
    });
    expect(g.filter((c) => c.includes("xfade=")).length).toBeGreaterThanOrEqual(3);
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a transition into a gap slot", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { transition: 0.5, transitionStyle: "crossfade" }),
        clip("", { out: 2 }),
        clip("b.mp4"),
      ],
    });
    expect(g.join(";")).toContain("xfade=");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("cross zoom, edge animations, speed, stills, gaps, overlays, and sound", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", {
          transition: 0.6,
          transitionStyle: "crosszoom",
          animIn: { style: "slideleft", seconds: 0.4 },
        }),
        clip("b.mp4", { speed: 2 }),
        clip("", { out: 2 }),
        clip("c.png", { image: true, animOut: { style: "slideup", seconds: 0.4 } }),
        clip("d.mp4", { transition: 0.5, transitionStyle: "dipblack" }),
        clip("e.mp4", { animOut: { style: "pop", seconds: 0.4 } }),
      ],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 2,
          start: 1,
          track: 1,
          muted: true,
          headFade: 0.3,
          tailZoom: 0.3,
        },
      ],
      audio: [{ file: "music.mp3", in: 0, out: 5, start: 0, volume: 0.8, fadeIn: 0.2 }],
      captions: [{ file: "cap1.png", start: 0, end: 2 }],
      fadeIn: 0.5,
    });
    expect(g.join(";")).toContain("xfade=");
    expect(xfadeMismatches(g)).toEqual([]);
  });
});
