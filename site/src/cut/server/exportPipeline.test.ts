import { describe, expect, test } from "bun:test";
import path from "node:path";
import { retimeOf } from "@donkeycut/effects-kit";
import {
  colorParamsFilter,
  colorTagArgs,
  narrowSpecToRange,
  runExport,
  videoCodecArgs,
  type ExportPipelineIO,
  type ExportSpec,
  type RenderHandle,
} from "./exportPipeline";

// Builds the real encode filtergraph for a spec by running the pipeline with
// its edges stubbed: media exists, every stream probes present, SDR color,
// software encoders, and every ffmpeg run is captured for the assertions.
/** Every ffmpeg run the pipeline made for a spec, in order; the graph is the
 * one carrying `-filter_complex`. */
/** Every file the pipeline wrote in the last run, in order. */
let written: { file: string; data: string }[] = [];
/** Files staged in the job dir by base name, as an upload would leave them. */
const stagedFiles = new Map<string, string>();
/** Source sizes the probe reports, by staged path; absent probes as unknown. */
const probedDims = new Map<string, { width: number; height: number }>();

/** The masters and stem packs the last run asked for. */
let mastered: { input: string; output: string; opts: Parameters<ExportPipelineIO["masterRawMix"]>[2] }[] = [];
let packed: { files: { path: string; name: string }[]; output: string }[] = [];

const runsFor = async (over: Partial<ExportSpec>): Promise<string[][]> => {
  const ffmpegCalls: string[][] = [];
  written = [];
  mastered = [];
  packed = [];
  // Seconds each turned file was asked to produce, summed off the `-t` of the
  // chunk runs that wrote its pieces, so the bake reads back a whole file.
  const produced = new Map<string, number>();
  const io: ExportPipelineIO = {
    exportSourceFiles: async () => false,
    stat: (async () => ({ isFile: () => true })) as unknown as ExportPipelineIO["stat"],
    writeFile: (async (file: string, data: string) => {
      written.push({ file, data });
    }) as unknown as ExportPipelineIO["writeFile"],
    readFile: (async (file: string) => {
      return new TextEncoder().encode(stagedFiles.get(path.basename(file)) ?? "");
    }) as unknown as ExportPipelineIO["readFile"],
    unlink: (async () => {}) as unknown as ExportPipelineIO["unlink"],
    hasStream: async () => true,
    audioChannels: async (file) => (file.includes("mono") ? 1 : 2),
    videoDecodeCost: async () => null,
    videoDimensions: async (file) => probedDims.get(file) ?? null,
    mediaDuration: async (file) => produced.get(file) ?? 0,
    videoEncoder: async (codec) =>
      codec === "hevc" ? "libx265" : codec.startsWith("prores") ? "prores_ks" : "libx264",
    masterRawMix: async (input, output, opts) => {
      mastered.push({ input, output, opts });
      return {} as Awaited<ReturnType<ExportPipelineIO["masterRawMix"]>>;
    },
    packStems: async (files, output) => {
      packed.push({ files, output });
    },
    runFfmpeg: async (_job, args) => {
      ffmpegCalls.push(args);
      const piece = args[args.length - 1].match(/^(.*)\.\d+\.(?:mov|wav)$/);
      const len = args.indexOf("-t");
      if (piece && len >= 0) produced.set(piece[1], (produced.get(piece[1]) ?? 0) + Number(args[len + 1]));
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
    duration: clips.reduce((s, c) => s + retimeOf(c).len, 0),
    clips,
    audio: [],
    overlays: [],
    ...over,
  };
  const job: RenderHandle = {
    tmpDir: "/tmp/graph-test",
    outPath: "/tmp/graph-test/out.mp4",
    stemsPath: "/tmp/graph-test/out stems.zip",
    progress: 0,
    log: [],
  };
  await runExport(job, spec, (f) => `/media/${f}`, io);
  return ffmpegCalls;
};

/** The graph without its last line, the delivery's signalling stamped on the
 * finished frames (colorParamsFilter), for assertions about the chains. */
const untagged = (g: string[]): string[] => g.filter((l) => !l.endsWith("[vtag]"));

const graphFor = async (over: Partial<ExportSpec>): Promise<string[]> => {
  const runs = await runsFor(over);
  const enc = runs.find((a) => a.includes("-filter_complex"))!;
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

  test("a cross dissolve cuts the picture and crosses the sound", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { in: 1, out: 5, soundCross: 0.5, soundAhead: 0.5, transitionStyle: "audiocross" }),
        clip("b.mp4", { in: 1, out: 5, soundBack: 0.5 }),
      ],
    });
    const graph = g.join(";");
    // No blend on the picture at all — the join is a plain concat.
    expect(graph).not.toContain("xfade=");
    expect(graph).not.toContain("tpad=start_duration");
    // The two segments carry equal-power ramps into and out of the cut, not
    // fades to silence.
    expect(graph).not.toContain("afade=t=out:st=3.500");
    expect(graph).toContain("cos(clip((t-(3.500))/1.000,0,1)*PI/2)");
    expect(graph).toContain("sin(clip((t-(-0.500))/1.000,0,1)*PI/2)");
    // …and each clip plays its handle across the cut, delayed onto it, so
    // both are really sounding while the picture has already changed.
    expect(graph).toContain("atrim=5.000:5.500");
    expect(graph).toContain("atrim=0.500:1.000");
    expect(graph).toContain("adelay=4000:all=1[xha1]");
    expect(graph).toContain("adelay=3500:all=1[xhb1]");
    expect(graph).toContain("[xha1]");
    expect(graph).toContain("[xhb1]");
  });

  test("a cross dissolve joined into a picture transition keeps the streams matched", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { soundCross: 0.5, transitionStyle: "audiocross" }),
        clip("b.mp4", { transition: 0.5, transitionStyle: "crossfade" }),
        clip("c.mp4"),
      ],
    });
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("an upper-track cross dissolve ramps the sound and never the picture", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 8 })],
      overlayVideos: [
        {
          file: "u1.mp4",
          in: 1,
          out: 5,
          start: 0,
          track: 1,
          muted: false,
          tailSound: 0.5,
          soundAhead: 0.5,
        },
        {
          file: "u2.mp4",
          in: 1,
          out: 5,
          start: 4,
          track: 1,
          muted: false,
          headSound: 0.5,
          soundBack: 0.5,
        },
      ],
    });
    const graph = g.join(";");
    // The sound crosses at the cut between the two upper-track clips, each
    // reaching into its handle so both are audible there…
    expect(graph).toContain("cos(clip((t-(3.500))/1.000,0,1)*PI/2)");
    expect(graph).toContain("sin(clip((t-(0.000))/1.000,0,1)*PI/2)");
    expect(graph).toContain("atrim=1.000:5.500");
    expect(graph).toContain("atrim=0.500:5.000");
    // …and the picture keeps its opacity throughout: no alpha ramp anywhere.
    expect(graph).not.toContain("fade=t=in:st=0:d=0.500:alpha=1");
    expect(graph).not.toContain("alpha=1");
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

  test("a block's card is read from the job's own directory, not the project's media", async () => {
    const runs = await runsFor({
      clips: [clip("a.mp4"), clip("block_1.png", { image: true, staged: true, out: 3 })],
    });
    const graph = runs.find((a) => a.includes("-filter_complex"))!;
    const inputs = graph.slice(0, graph.indexOf("-filter_complex"));
    // The block travels with the job; the footage beside it still resolves
    // through the project's media folder.
    expect(inputs).toContain("/tmp/graph-test/block_1.png");
    expect(inputs).toContain("/media/a.mp4");
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
    });
    expect(g.join(";")).toContain("xfade=");
    expect(xfadeMismatches(g)).toEqual([]);
  });
});

describe("a speed curve in the filtergraph", () => {
  test("a curved clip lays its picture through the map and reads baked sound", async () => {
    const curved = clip("a.mp4", { speedCurve: [[0, 1], [4, 4]] });
    const g = await graphFor({ clips: [curved, clip("b.mp4")] });
    const video = g.find((f) => f.startsWith("[0:v]trim="))!;
    expect(video).toContain("setpts='(clip(T-STARTT");
    expect(video).not.toContain("(PTS-STARTPTS)/");
    // The baked WAV joins the inputs after the two media files, and the
    // clip's sound is read from it in timeline seconds with no tempo.
    const audio = g.find((f) => f.startsWith("[2:a]atrim="))!;
    expect(audio).toBeTruthy();
    expect(audio).not.toContain("atempo");
    expect(audio).toContain(`apad=whole_dur=${retimeOf(curved).len.toFixed(3)}`);
    // The plain clip still reads its own input at source seconds.
    expect(g.some((f) => f.startsWith("[1:a]atrim=0.000:4.000"))).toBe(true);
  });
});

describe("smooth slow motion in the filtergraph", () => {
  test("a slowed clip runs motion interpolation over its whole span", async () => {
    const g = await graphFor({ clips: [clip("a.mp4", { speed: 0.5, smoothSlow: true }), clip("b.mp4")] });
    const video = g.find((f) => f.startsWith("[0:v]trim="))!;
    expect(video).toContain("minterpolate=fps=30:mi_mode=mci");
    expect(video).not.toContain("split=");
    // The plain clip beside it is untouched.
    expect(g.find((f) => f.startsWith("[1:v]trim="))).not.toContain("minterpolate");
  });

  test("a curve that dips is interpolated in the dip alone", async () => {
    const curved = clip("a.mp4", {
      smoothSlow: true,
      speedCurve: [
        [0, 1],
        [1.5, 0.4],
        [3, 3],
        [4, 3],
      ],
    });
    const g = await graphFor({ clips: [curved, clip("b.mp4")] });
    const head = g.find((f) => f.startsWith("[0:v]trim="))!;
    expect(head).toContain("split=3[smic0_0][smic0_1][smic0_2]");
    const pieces = g.filter((f) => f.startsWith("[smic0_"));
    expect(pieces.length).toBe(3);
    expect(pieces[0]).toContain("fps=30[smo");
    expect(pieces[0]).not.toContain("minterpolate");
    expect(pieces[1]).toContain("minterpolate=fps=30");
    expect(pieces[2]).not.toContain("minterpolate");
    expect(g.some((f) => f.includes("concat=n=3:v=1:a=0,fps=30[smoc0]"))).toBe(true);
  });

  test("a clip at 1× or faster keeps its plain chain with the flag on", async () => {
    const g = await graphFor({ clips: [clip("a.mp4", { speed: 2, smoothSlow: true })] });
    expect(g.join(";")).not.toContain("minterpolate");
  });
});

describe("clip sound in the filtergraph", () => {
  const sound = {
    eq: [2, 1, -2, -1, 1.5, 1, -1],
    compressor: { threshold: -18, ratio: 3, attack: 10, release: 80 },
    limiter: { ceiling: -1 },
  };

  test("a treated track-0 clip runs its chain before its level, pad and fades", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { sound, volume: 0.8, animOut: { style: "fade", seconds: 0.4 } })],
    });
    const stanza = g.find((f) => f.startsWith("[0:a]"))!;
    expect(stanza).toBeTruthy();
    const at = (s: string) => stanza.indexOf(s);
    expect(at("lowshelf=f=100")).toBeGreaterThan(at("aformat="));
    expect(at("acompressor=")).toBeGreaterThan(at("highshelf="));
    expect(at("alimiter=")).toBeGreaterThan(at("acompressor="));
    expect(at("volume=0.8")).toBeGreaterThan(at("alimiter="));
    expect(at("apad=")).toBeGreaterThan(at("volume=0.8"));
    expect(at("afade=t=out")).toBeGreaterThan(at("apad="));
  });

  test("a treated soundtrack clip and overlay clip carry the same chain", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4")],
      overlayVideos: [
        { file: "ov.mp4", in: 0, out: 2, start: 1, track: 1, muted: false, sound },
      ],
      audio: [{ file: "music.mp3", in: 0, out: 5, start: 0, volume: 0.8, sound }],
    });
    const treated = g.filter((f) => f.includes("alimiter="));
    expect(treated).toHaveLength(2);
    // Every stanza treats the resampled stream, so one clip's treatment
    // sounds the same whichever list it came from.
    for (const f of treated) {
      expect(f.indexOf("alimiter=")).toBeLessThan(f.indexOf("adelay="));
      expect(f.indexOf("aformat=")).toBeLessThan(f.indexOf("lowshelf="));
    }
  });

  test("an untreated clip spells no dynamics filter", async () => {
    const g = await graphFor({ clips: [clip("a.mp4", { sound: { eq: [0, 0, 0, 0, 0, 0, 0] } })] });
    expect(g.join(";")).not.toContain("acompressor=");
    expect(g.join(";")).not.toContain("equalizer=");
  });
});

describe("clip masks in the filtergraph", () => {
  test("a masked track-0 clip trims onto a black base and keeps the join sound", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { mask: { file: "mask_c0.png" }, transition: 0.5, transitionStyle: "crossfade" }),
        clip("b.mp4"),
      ],
    });
    const joined = g.join(";");
    // The multiply chain: painted coverage into the segment's alpha, then the
    // black base restores the opaque constant-size label.
    expect(joined).toContain("alphaextract");
    expect(joined).toContain("blend=all_mode=multiply");
    expect(joined).toContain("alphamerge");
    expect(joined).toContain("format=gray");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a keyframed mask on an upper track plays as a concat slideshow at the box", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 2,
          start: 1,
          track: 1,
          muted: true,
          frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
          mask: {
            frames: [
              { file: "mask_ov0_f0.png", duration: 1 },
              { file: "mask_ov0_f1.png", duration: 1 },
            ],
          },
        },
      ],
    });
    const joined = g.join(";");
    expect(joined).toContain("blend=all_mode=multiply");
    // A letterboxed masked overlay pads out to its region box so the painted
    // mask and the segment share exact pixel geometry.
    expect(joined).toContain("pad=540:960");
    expect(joined).toContain("alphamerge,format=yuva420p");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a masked letterboxed overlay keeps its look, graded before the pad", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 2,
          start: 1,
          track: 1,
          muted: true,
          look: "vhs",
          frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
          mask: { file: "mask_ov0.png" },
        },
      ],
    });
    const joined = g.join(";");
    // The look chain runs on the opaque scaled picture; the transparent box
    // pad joins the chain after it, so the margins stay clear.
    expect(joined).toContain("[olki0]");
    const lookAt = g.findIndex((c) => c.includes("[olki0]"));
    const padAt = g.findIndex((c) => c.includes("pad=540:960") && c.includes("black@0.0"));
    expect(lookAt).toBeGreaterThanOrEqual(0);
    expect(padAt).toBeGreaterThanOrEqual(lookAt);
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a masked overlay's own effects run on its clock, before the pad and the mask", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 2,
          start: 1,
          track: 1,
          muted: true,
          effects: [{ effect: "negative" }, { effect: "huecycle", amount: 0.5 }],
          frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
          mask: { file: "mask_ov0.png" },
        },
      ],
    });
    const joined = g.join(";");
    // Both effects gate on the segment's own clock, 0 to its 2s length, in
    // the order the clip lists them.
    const negAt = g.findIndex((c) => c.includes("lutyuv=y='minval+maxval-val'") && c.includes("gte(t,0)*lt(t,2)"));
    const hueAt = g.findIndex((c) => c.includes("hue=H='2*PI*0.8*(t-0)'"));
    const padAt = g.findIndex((c) => c.includes("pad=540:960") && c.includes("black@0.0"));
    expect(negAt).toBeGreaterThanOrEqual(0);
    expect(hueAt).toBeGreaterThan(negAt);
    expect(padAt).toBeGreaterThan(hueAt);
    expect(joined).toContain("alphamerge");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a track-0 clip's effects treat its picture ahead of the letterbox bars", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 3, effects: [{ effect: "negative" }] }), clip("b.mp4", { out: 2 })],
    });
    const fxAt = g.findIndex((c) => c.includes("lutyuv=y='minval+maxval-val'"));
    expect(fxAt).toBeGreaterThanOrEqual(0);
    // The chain the effect hands on to pads after it, and only the first clip
    // wears it.
    expect(g.slice(fxAt).some((c) => c.includes("[cw0fo0]null") && c.includes("pad=1080:1920"))).toBe(true);
    expect(g.filter((c) => c.includes("lutyuv=y='minval+maxval-val'"))).toHaveLength(1);
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a mask under head/tail alpha fades keeps both", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 3,
          start: 0.5,
          track: 1,
          muted: true,
          headFade: 0.3,
          tailFade: 0.3,
          mask: { file: "mask_ov0.png" },
        },
      ],
    });
    const joined = g.join(";");
    // Fades apply on the segment before the mask multiplies, so both survive
    // (fade alpha=1 multiplies; alphamerge would have replaced it).
    const fadeChain = g.find((c) => c.includes("fade=t=in") && c.includes("alpha=1"));
    const maskChain = g.findIndex((c) => c.includes("blend=all_mode=multiply"));
    expect(fadeChain === undefined).toBe(false);
    expect(maskChain).toBeGreaterThan(g.indexOf(fadeChain!));
    expect(joined).toContain("format=gray");
    expect(xfadeMismatches(g)).toEqual([]);
  });
});

describe("subject masks in the filtergraph", () => {
  test("subject-tagged elements and clips take matte splits, negated when inverted", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { out: 6, mask: { subject: { invert: true, feather: 20 } } }),
      ],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 2,
          start: 1,
          track: 1,
          muted: true,
          mask: { subject: {} },
        },
      ],
      overlays: [
        {
          start: 1,
          end: 3,
          x: 100,
          y: 200,
          blank: "b.png",
          frames: [{ file: "el_f0.png", duration: 2 }],
          subject: { invert: true },
        },
      ],
      behindMask: { file: "behind_mask.mp4", from: 0.5 },
    });
    const joined = g.join(";");
    // Three consumers, one split each, every one through the same multiply
    // chain in lane order.
    expect(joined).toContain("split=3[bhs0][bhs1][bhs2]");
    expect(g.filter((c) => c.includes("negate")).length).toBe(2);
    expect(joined).toContain("gblur=sigma=");
    expect(g.filter((c) => c.includes("blend=all_mode=multiply")).length).toBe(3);
    expect(xfadeMismatches(g)).toEqual([]);
  });
});

describe("clip keyframes in the filtergraph", () => {
  const KF = [
    { t: 0, x: 0.3, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
    { t: 2, x: 0.7, y: 0.4, scale: 1.6, rotation: 45, opacity: 1 },
  ];

  test("a keyed track-0 clip transforms over a transparent base, opaque out", async () => {
    const g = await graphFor({
      clips: [
        clip("a.mp4", { out: 4, kf: KF, transition: 0.5, transitionStyle: "crossfade" }),
        clip("b.mp4"),
      ],
    });
    const joined = g.join(";");
    expect(joined).toContain("rotate=a=");
    expect(joined).toContain("eval=frame");
    expect(joined).toContain("clip((t-0.000)/2.000,0,1)");
    // The transparent base carries the positioned picture; the black base
    // restores the opaque constant-size label the join expects.
    expect(joined).toContain("color=c=black@0.0");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a keyed overlay clip positions by expression with its start folded in", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 8 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 3,
          start: 1.5,
          track: 1,
          muted: true,
          kf: KF,
        },
      ],
    });
    const joined = g.join(";");
    expect(joined).toContain("(t-1.500)");
    expect(joined).toContain("rotate=a=");
    expect(joined).toContain("-w/2");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a keyed subject-masked overlay rides the transparent base before the matte", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 8 })],
      overlayVideos: [
        {
          file: "ov.mp4",
          in: 0,
          out: 3,
          start: 1,
          track: 1,
          muted: true,
          kf: KF,
          mask: { subject: {} },
        },
      ],
      behindMask: { file: "behind_mask.mp4", from: 0.5 },
    });
    const joined = g.join(";");
    expect(joined).toContain("color=c=black@0.0");
    expect(joined).toContain("blend=all_mode=multiply");
    expect(xfadeMismatches(g)).toEqual([]);
  });
});

describe("the project background in the filtergraph", () => {
  test("a cut of nothing but elements renders the background for its whole length", async () => {
    const g = await graphFor({
      clips: [clip("", { out: 6, hidden: true, muted: true })],
      background: "#FF5500",
      overlays: [{ file: "o0.png", start: 0, end: 6 }],
    });
    const joined = g.join(";");
    expect(joined).toContain("color=c=0xFF5500");
    expect(joined).not.toContain("color=c=black:");
  });

  test("a fitted clip letterboxes into the background rather than into black", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { fit: "fit" })],
      background: "#FFFFFF",
    });
    expect(g.join(";")).toContain("color=0xFFFFFF");
  });

  test("a covering clip's crop quotes its min() so the graph parser keeps it whole", async () => {
    const g = await graphFor({ clips: [clip("a.mp4", { fit: "fill", zoom: 1.5 })] });
    expect(g.join(";")).toContain("crop='min(iw,1080)':'min(ih,1920)'");
  });

  test("a mirrored clip flips after its framing, inside its box", async () => {
    const g = await graphFor({ clips: [clip("a.mp4", { fit: "fill", flipH: true })] });
    expect(g.join(";")).toContain(":(ih-oh)*0.500,hflip,setsar=1");
    const v = await graphFor({ clips: [clip("a.mp4", { flipV: true })] });
    expect(v.join(";")).toContain(",vflip,setsar=1,format=yuv420p,pad=");
  });

  test("no background named keeps the black frame every cut had before", async () => {
    const g = await graphFor({ clips: [clip("", { out: 4, hidden: true, muted: true })] });
    expect(g.join(";")).toContain("color=c=black:");
  });
});

describe("audio effects in the filtergraph", () => {
  test("a windowed effect splices the mix and puts the untreated pieces back", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 10 })],
      effects: [{ effect: "echo", amount: 0.7, start: 2, end: 4 }],
    });
    const joined = g.join(";");
    expect(joined).toContain("asplit=3");
    expect(joined).toContain("aecho=");
    // The head, the treated window, and the tail, joined back in order.
    expect(joined).toContain("atrim=0:2.000,asetpts=PTS-STARTPTS[afxh0]");
    expect(joined).toContain("atrim=start=4.000,asetpts=PTS-STARTPTS[afxt0]");
    expect(joined).toContain("concat=n=3:v=0:a=1[afx0]");
    // The treated piece leaves at the length it went in at, so a chain that
    // rings past its window cannot push the rest of the sound late.
    expect(joined).toContain("apad=whole_dur=2.000,atrim=0:2.000");
  });

  test("an effect over the whole cut needs no splice", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 4 })],
      effects: [{ effect: "muffle", amount: 1, start: 0, end: 4 }],
    });
    const joined = g.join(";");
    expect(joined).toContain("lowpass=");
    expect(joined).not.toContain("asplit=");
    expect(joined).not.toContain("concat=n=");
  });

  test("an effect at the head splices in two pieces", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      effects: [{ effect: "telephone", start: 0, end: 2 }],
    });
    const joined = g.join(";");
    expect(joined).toContain("asplit=2");
    expect(joined).toContain("concat=n=2:v=0:a=1[afx0]");
    expect(joined).not.toContain("[afxh0]");
  });

  test("audio effects stay out of the picture chain, and picture effects out of the mix", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      effects: [
        { effect: "reverb", start: 1, end: 3 },
        { effect: "vignette", amount: 0.5, start: 1, end: 3 },
      ],
    });
    const joined = g.join(";");
    // The vignette gates the picture; the reverb never reaches a video label.
    expect(joined).toContain("vignette=");
    expect(joined).toContain("aecho=");
    expect(joined).not.toContain("aecho=1:1:23|41|59|79|101|127|151|181:0.35|0.223|0.142|0.091|0.058|0.037|0.024|0.015[vfx");
  });

  test("two audio effects run in series, each over its own window", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 12 })],
      effects: [
        { effect: "echo", start: 6, end: 8 },
        { effect: "crush", start: 1, end: 3 },
      ],
    });
    const joined = g.join(";");
    // Sorted by start: the crush splices first, and the echo splices what it
    // handed on.
    expect(joined).toContain("acrusher=");
    expect(joined.indexOf("acrusher=")).toBeLessThan(joined.indexOf("aecho="));
    expect(joined).toContain("[afx0]asplit=3");
    expect(joined).toContain("concat=n=3:v=0:a=1[afx1]");
  });
});

describe("a reversed clip in the filtergraph", () => {
  const reversed = clip("a.mp4", { in: 2, out: 8, speed: 2, reverse: true, soundBack: 0.5, soundAhead: 0.25 });

  test("is baked turned around in chunks and read forward off the copy", async () => {
    const runs = await runsFor({ clips: [reversed, clip("b.mp4")] });
    const graph = runs.find((a) => a.includes("-filter_complex"))!;
    const bakes = runs.filter((a) => a.includes("-i") && a.includes("/media/a.mp4"));
    // The reach: the trim plus the handles at the clip's rate, [1.5, 9].
    // Three-second chunks from the top: [6, 9], [3, 6], [1.5, 3].
    expect(bakes.map((a) => [a[a.indexOf("-ss") + 1], a[a.indexOf("-t") + 1]])).toEqual([
      ["6.000", "3.000"],
      ["3.000", "3.000"],
      ["1.500", "1.500"],
    ]);
    for (const a of bakes) {
      expect(a[a.indexOf("-vf") + 1]).toBe("reverse,format=yuv420p");
      expect(a[a.indexOf("-af") + 1]).toBe("areverse");
      expect(a.indexOf("-ss")).toBeLessThan(a.indexOf("-i"));
      expect(a.indexOf("-t")).toBeLessThan(a.indexOf("-i"));
    }
    const join = runs.find((a) => a.includes("concat"))!;
    expect(join).toContain("-c");
    expect(join[join.indexOf("-c") + 1]).toBe("copy");
    // The graph reads the copy, never the source, and trims the mirrored
    // span: source [2, 8] under a pivot of 9 is [1, 7] in the copy.
    const inputs = graph.slice(0, graph.indexOf("-filter_complex"));
    expect(inputs).not.toContain("/media/a.mp4");
    expect(inputs.some((p) => p.endsWith("turned_clip_0.mov"))).toBe(true);
    const idx = inputs.filter((p, i) => inputs[i - 1] === "-i").findIndex((p) => p.endsWith("turned_clip_0.mov"));
    const g = graph[graph.indexOf("-filter_complex") + 1].split(";");
    const video = g.find((f) => f.startsWith(`[${idx}:v]trim=`))!;
    expect(video).toContain("trim=1.000:7.000,setpts=(PTS-STARTPTS)/2");
    expect(video).not.toContain("reverse");
    const audio = g.find((f) => f.startsWith(`[${idx}:a]atrim=`))!;
    expect(audio).toContain("atrim=1.000:7.000");
    expect(audio).toContain("atempo");
    expect(audio).not.toContain("areverse");
  });

  test("a reversed curve keeps its length and lands mirrored on the copy", async () => {
    const curved = clip("a.mp4", {
      in: 0,
      out: 4,
      speedCurve: [
        [0, 1],
        [4, 4],
      ],
      reverse: true,
    });
    const g = await graphFor({ clips: [curved, clip("b.mp4")] });
    const video = g.find((f) => f.startsWith("[1:v]trim="))!;
    expect(video).toContain("trim=0.000:4.000,setpts='(clip(T-STARTT");
    const first = g.find((f) => f.includes("apad=whole_dur="))!;
    expect(first).toContain(`apad=whole_dur=${retimeOf(curved).len.toFixed(3)}`);
  });
});


// ---------------------------------------------------------------------------
// Delivery: the encode carries the codec, container and audio the spec asks
// for, and a spec from before those fields existed is the H.264 + AAC MP4 it
// always was.
const encodeRun = async (over: Partial<ExportSpec>) => {
  const runs = await runsFor({ clips: [clip("a.mp4")], ...over });
  return runs.find((a) => a.includes("-filter_complex"))!;
};
const arg = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("delivery", () => {
  test("source bitrates reach the worker and Mac encoders", async () => {
    const args = await encodeRun({ bitrate: 140_000, audioBitrate: 48_000 });
    expect(arg(args, "-b:v")).toBe("140000");
    expect(arg(args, "-b:a")).toBe("48000");
    expect(args).not.toContain("-crf");
  });
  test("a spec without delivery fields is an H.264 + AAC MP4", async () => {
    const args = await encodeRun({});
    expect(arg(args, "-c:v")).toBe("libx264");
    expect(arg(args, "-crf")).toBe("24");
    expect(arg(args, "-pix_fmt")).toBe("yuv420p");
    expect(arg(args, "-c:a")).toBe("aac");
    expect(args[args.length - 1].endsWith("encode.mp4")).toBe(true);
  });

  test("HEVC is tagged hvc1 so QuickTime opens it", async () => {
    const args = await encodeRun({ codec: "hevc" });
    expect(arg(args, "-c:v")).toBe("libx265");
    expect(arg(args, "-tag:v")).toBe("hvc1");
    expect(arg(args, "-pix_fmt")).toBe("yuv420p");
  });

  test("a ProRes master writes 10-bit 4:2:2 HQ with PCM into a MOV", async () => {
    const args = await encodeRun({ codec: "prores", container: "mov", audioCodec: "pcm" });
    expect(arg(args, "-c:v")).toBe("prores_ks");
    expect(arg(args, "-profile:v")).toBe("3");
    expect(arg(args, "-pix_fmt")).toBe("yuv422p10le");
    expect(arg(args, "-c:a")).toBe("pcm_s16le");
    expect(args).not.toContain("-crf");
    expect(args[args.length - 1].endsWith("encode.mov")).toBe(true);
  });

  test("a ProRes 4444 master writes 10-bit 4:4:4 and composites at full chroma", async () => {
    const args = await encodeRun({ codec: "prores4444", container: "mov", audioCodec: "pcm" });
    expect(arg(args, "-c:v")).toBe("prores_ks");
    expect(arg(args, "-profile:v")).toBe("4");
    expect(arg(args, "-pix_fmt")).toBe("yuv444p10le");
    expect(args).not.toContain("-crf");
    const graph = arg(args, "-filter_complex");
    // The composite itself holds the chroma; a 4:2:0 graph would have thrown
    // it away before prores_ks ever saw a frame.
    expect(graph).toContain("format=yuv444p");
    expect(graph).not.toContain("yuv420p");
    expect(graph).not.toContain("yuva420p");
    for (const stanza of graph.split(";").filter((f) => f.includes("overlay="))) {
      expect(stanza).toContain(":format=yuv444");
    }
  });

  test("an H.264 delivery composites at 4:2:0, where its encoder lands anyway", async () => {
    const graph = arg(await encodeRun({}), "-filter_complex");
    expect(graph).toContain("format=yuv420p");
    expect(graph).not.toContain("yuv444");
  });

  test("a typed bitrate replaces the tier's CRF", async () => {
    const args = await encodeRun({ bitrate: 6_000_000 });
    expect(args).not.toContain("-crf");
    expect(arg(args, "-b:v")).toBe("6000000");
    expect(arg(args, "-maxrate")).toBe("9000000");
  });

  test("H.264 and HEVC write the High profile with a key frame every two seconds", async () => {
    const h264 = await encodeRun({ fps: 30 });
    expect(arg(h264, "-profile:v")).toBe("high");
    expect(arg(h264, "-g")).toBe("60");
    const hevc = await encodeRun({ codec: "hevc", fps: 24 });
    expect(arg(hevc, "-g")).toBe("48");
    const prores = await encodeRun({ codec: "prores", container: "mov" });
    expect(prores).not.toContain("-g");
  });

  test("a range is cut from the finished composite and sets the file's length", async () => {
    const args = await encodeRun({ duration: 20, range: { start: 5, end: 12 } });
    const graph = arg(args, "-filter_complex");
    expect(graph).toContain("trim=start=5.000:end=12.000,setpts=PTS-STARTPTS[vrange]");
    expect(graph).toContain("atrim=start=5.000:end=12.000,asetpts=PTS-STARTPTS[arange]");
    expect(arg(args, "-map")).toBe("[vrange]");
    expect(arg(args, "-t")).toBe("7.000");
  });

  test("a range hides the track-0 slots it cannot reach and drops the entries outside it", async () => {
    const spec = {
      projectId: "p", width: 1080, height: 1920, fps: 30, crf: 24, preset: "veryfast",
      duration: 30,
      range: { start: 12, end: 18 },
      clips: ["a", "b", "c", "d", "e", "f"].map((n) => clip(`${n}.mp4`, { out: 5 })),
      audio: [
        { file: "m1.mp3", in: 0, out: 4, start: 0, volume: 1 },
        { file: "m2.mp3", in: 0, out: 4, start: 15, volume: 1 },
      ],
      overlays: [
        { file: "t1.png", start: 0, end: 3 },
        { file: "t2.png", start: 17, end: 25 },
      ],
      captions: [
        { file: "c1.png", start: 1, end: 2 },
        { file: "c2.png", start: 13, end: 14 },
      ],
    } as unknown as ExportSpec;
    const narrowed = narrowSpecToRange(spec);
    // Five-second slots: [0,5) [5,10) [10,15) [15,20) [20,25) [25,30). The
    // half-second slack keeps the slot ending at 10 hidden and the one
    // starting at 20 hidden.
    expect(narrowed.clips.map((c) => !!c.hidden)).toEqual([true, true, false, false, true, true]);
    expect(narrowed.audio.map((a) => a.file)).toEqual(["m2.mp3"]);
    expect(narrowed.overlays.map((o) => o.file)).toEqual(["t2.png"]);
    expect(narrowed.captions?.map((c) => c.file)).toEqual(["c2.png"]);
    expect(narrowed.duration).toBe(30);
    const whole = { ...spec, range: undefined };
    expect(narrowSpecToRange(whole)).toBe(whole);
  });

  test("a join at the range edge keeps its neighbor", async () => {
    const spec = {
      projectId: "p", width: 1080, height: 1920, fps: 30, crf: 24, preset: "veryfast",
      duration: 15,
      range: { start: 6, end: 8 },
      clips: [clip("a.mp4", { out: 5, transition: 1 }), clip("b.mp4", { out: 5 }), clip("c.mp4", { out: 5 })],
      audio: [],
      overlays: [],
    } as unknown as ExportSpec;
    // Slots [0,5) [5,10) [10,15): a one-second join reaches 1.5 s past each
    // edge, so the first slot (ending at 5, within 1.5 of 6) stays and the
    // last (starting at 10, beyond 1.5 of 8) is hidden.
    expect(narrowSpecToRange(spec).clips.map((c) => !!c.hidden)).toEqual([false, false, true]);
  });

  test("no range delivers the whole cut", async () => {
    const args = await encodeRun({ duration: 20 });
    expect(arg(args, "-filter_complex")).not.toContain("[vrange]");
    expect(arg(args, "-t")).toBe("20.000");
  });
});

describe("channel layout", () => {
  test("a mono source is laid into both channels at full level, a stereo one passes through", async () => {
    const f = await graphFor({
      clips: [clip("mono-voice.mp4"), clip("stereo.mp4")],
      audio: [{ file: "mono-bed.m4a", in: 0, out: 2, start: 0, volume: 0.5 }],
    });
    const inputs = ["mono-voice.mp4", "stereo.mp4", "mono-bed.m4a"];
    const stanza = (file: string) =>
      f.find((x) => x.startsWith(`[${inputs.indexOf(file)}:a]`) && x.includes("aresample=44100"))!;
    expect(stanza("mono-voice.mp4")).toContain("aresample=44100,pan=stereo|c0=c0|c1=c0,aformat=");
    expect(stanza("mono-bed.m4a")).toContain("aresample=44100,pan=stereo|c0=c0|c1=c0,aformat=");
    expect(stanza("stereo.mp4")).toContain("aresample=44100,aformat=");
    expect(stanza("stereo.mp4")).not.toContain("pan=");
  });
});

describe("clip color in the filtergraph", () => {
  const graphText = async (over: Partial<ExportSpec>) => untagged(await graphFor(over)).join(";");

  test("an ungraded Rec.709 clip runs no color at all", async () => {
    const g = await graphText({ clips: [clip("a.mp4")] });
    expect(g).not.toContain("lut3d");
    expect(g).not.toContain("gbrp16le");
    expect(g).not.toContain("colorspace=");
    expect(g).not.toContain("in_color_matrix");
  });

  test("a graded clip bakes one LUT and runs it in 16-bit RGB before the pad, then back to BT.709 video", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { grade: { exposure: 10 } }), clip("b.mp4", { grade: { exposure: 10 } })],
    });
    const joined = g.join(";");
    // One .cube for the two clips sharing a recipe.
    const cubes = written.filter((w) => w.file.endsWith(".cube"));
    expect(cubes).toHaveLength(1);
    expect(cubes[0].file).toBe(path.join("/tmp/graph-test", "clip_0.cube"));
    expect(cubes[0].data).toContain("LUT_3D_SIZE 33");
    const line = g.find((l) => l.startsWith("[0:v]"))!;
    // The framing scale spells the file's matrix and range; the picture goes
    // to 16-bit RGB, through the LUT, and comes back as BT.709 video before
    // the letterbox pad.
    expect(line).toMatch(/scale=[^,]*in_color_matrix=bt709:in_range=tv/);
    const at = (needle: string) => {
      const i = line.indexOf(needle);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("format=gbrp16le")).toBeLessThan(at("lut3d=file="));
    expect(line).toContain(`lut3d=file='${path.join("/tmp/graph-test", "clip_0.cube")}':interp=tetrahedral`);
    expect(at("lut3d=file=")).toBeLessThan(at("scale=out_color_matrix=bt709:out_range=tv"));
    expect(at("scale=out_color_matrix=bt709:out_range=tv")).toBeLessThan(at("format=yuv420p"));
    expect(at("format=yuv420p")).toBeLessThan(at("pad=1080:1920"));
    expect(untagged(g).join(";")).not.toContain("colorspace=");
    expect(joined).not.toContain("lutrgb");
    expect(joined).not.toContain("hue=");
  });

  test("a log source converts through the wide LUT with its own matrix, graded or not", async () => {
    const g = await graphFor({
      lutSize: 33,
      lutSizeWide: 65,
      clips: [clip("log.mov", { color: { profile: "apple-log", matrix: "bt2020nc", fullRange: false } })],
    });
    const line = g.find((l) => l.startsWith("[0:v]"))!;
    expect(line).toMatch(/scale=[^,]*in_color_matrix=bt2020:in_range=tv/);
    expect(line).toContain("format=gbrp16le,lut3d=file=");
    expect(written.find((w) => w.file.endsWith(".cube"))!.data).toContain("LUT_3D_SIZE 65");
  });

  test("an ungraded file in another matrix or range converts in video, with no LUT", async () => {
    const g = await graphFor({
      clips: [clip("sd.mp4", { color: { profile: "rec709", matrix: "bt601", fullRange: true } })],
    });
    const line = g.find((l) => l.startsWith("[0:v]"))!;
    expect(line).not.toContain("lut3d");
    expect(line).toContain("scale:in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv");
    expect(line.indexOf("out_range=tv")).toBeLessThan(line.indexOf("pad=1080:1920"));
  });

  test("sharpen and clarity run on 16-bit luma after the LUT and before the pad", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { grade: { exposure: 5, sharpen: 25, clarity: 30 } })],
    });
    const joined = g.join(";");
    const head = g.find((l) => l.startsWith("[0:v]"))!;
    expect(head).toContain("lut3d=file=");
    expect(head).toMatch(/scale=out_color_matrix=bt709:out_range=pc,format=yuv444p16le\[dtic0\]$/);
    // The detail pass: bases from the input luma, gained detail merged back.
    expect(joined).toContain("[dtic0]split=6[dtc0o][dtc0ss][dtc0sr][dtc0cs][dtc0cr][dtc0cx]");
    expect(joined).toMatch(/\[dtc0ss\]gblur=sigma=1\.77\d*:planes=1\[dtc0sb\]/);
    expect(joined).toContain("[dtc0sr][dtc0sb]blend=c0_mode=grainextract,lutyuv=y='clip((val-32768)*0.750+32768,0,65535)'[dtc0sd]");
    // Clarity's window at 1920 tall is 43, past guided's reach: a reduced copy.
    expect(joined).toContain("[dtc0cs]scale='ceil(iw/3)':'ceil(ih/3)':flags=bilinear,guided=radius=14:eps=0.010:planes=1[dtc0cq]");
    expect(joined).toContain("[dtc0cq][dtc0cx]scale=rw:rh:flags=bilinear[dtc0cb]");
    expect(joined).toContain("[dtc0cr][dtc0cb]blend=c0_mode=grainextract,lutyuv=y='clip((val-32768)*0.900+32768,0,65535)'[dtc0cd]");
    expect(joined).toContain("[dtc0o][dtc0sd]blend=c0_mode=grainmerge[dtc0m1]");
    expect(joined).toContain("[dtc0m1][dtc0cd]blend=c0_mode=grainmerge[dtoc0]");
    const tail = g.find((l) => l.startsWith("[dtoc0]"))!;
    expect(tail).toContain("null,scale=in_color_matrix=bt709:in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p,pad=1080:1920");
    expect(xfadeMismatches(g)).toEqual([]);
  });

  test("a fitted 16:9 clip in a 9:16 frame sizes its detail to its own picture", async () => {
    // The preview runs sharpen and clarity on the whole decoded picture, so
    // the radii follow the picture's height: 1080 wide at 16:9 is 607.5 tall,
    // not the 1920 of the frame it letterboxes into.
    probedDims.set("/media/wide.mp4", { width: 1920, height: 1080 });
    try {
      const g = await graphFor({
        clips: [clip("wide.mp4", { fit: "fit", grade: { sharpen: 25, clarity: 30 } })],
      });
      const joined = g.join(";");
      expect(joined).toMatch(/\[dtc0ss\]gblur=sigma=0\.56\d*:planes=1\[dtc0sb\]/);
      // A window of 14 fits guided's reach: no reduced copy.
      expect(joined).toContain("[dtc0cs]guided=radius=14:eps=0.010:planes=1[dtc0cb]");
      // Covering the frame, the picture is 1920 tall and 3413 wide.
      const covered = (
        await graphFor({ clips: [clip("wide.mp4", { fit: "fill", grade: { sharpen: 25 } })] })
      ).join(";");
      expect(covered).toMatch(/\[dtc0ss\]gblur=sigma=1\.77\d*:planes=1\[dtc0sb\]/);
    } finally {
      probedDims.clear();
    }
  });

  test("clarity alone at a small frame runs guided at the picture's own size", async () => {
    const g = await graphFor({
      width: 640,
      height: 360,
      clips: [clip("a.mp4", { grade: { clarity: 50 } })],
    });
    const joined = g.join(";");
    expect(joined).not.toContain("lut3d");
    expect(joined).toContain("[dtic0]split=3[dtc0o][dtc0cs][dtc0cr]");
    expect(joined).toContain("[dtc0cs]guided=radius=8:eps=0.010:planes=1[dtc0cb]");
    expect(joined).toContain("[dtc0o][dtc0cd]blend=c0_mode=grainmerge[dtoc0]");
  });

  test("a graded overlay colors before its box pad, and a still keeps its alpha", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { out: 6 })],
      overlayVideos: [
        { file: "ov.mp4", in: 0, out: 2, start: 1, track: 1, muted: true, grade: { contrast: 10 },
          frame: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, mask: { file: "mask_ov0.png" } },
        { file: "still.png", in: 0, out: 2, start: 3, track: 1, muted: true, image: true, grade: { contrast: 10 },
          color: { profile: "srgb", matrix: "bt709", fullRange: true } },
      ],
    });
    const ov = g.find((l) => l.includes("[ovv0]") || (l.includes("lut3d") && l.includes("540:960")))!;
    expect(ov).toContain("format=gbrp16le,lut3d=file=");
    expect(ov.indexOf("out_range=tv")).toBeLessThan(ov.indexOf("pad=540:960"));
    const still = g.find((l) => l.includes("gbrap16le"))!;
    expect(still).toContain("format=gbrap16le,lut3d=file=");
    expect(still).not.toContain("in_color_matrix");
    // One recipe each: a video and a still share nothing but the grade.
    expect(written.filter((w) => w.file.endsWith(".cube"))).toHaveLength(1);
  });

  test("a smoothed slow clip spells the conversion again after its interpolation", async () => {
    const g = await graphFor({
      clips: [clip("a.mp4", { speed: 0.5, smoothSlow: true, grade: { exposure: 5 } })],
    });
    const line = g.find((l) => l.startsWith("[0:v]"))!;
    expect(line).toContain("minterpolate=");
    expect(line.indexOf("minterpolate=")).toBeLessThan(line.indexOf("scale:in_color_matrix=bt709:in_range=tv,format=gbrp16le,lut3d"));
  });

  test("a staged library LUT bakes into the clip's cube, and one that will not read fails naming it", async () => {
    stagedFiles.set("lut_abc.cube", "TITLE \"warm\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n");
    const g = await graphFor({
      clips: [clip("a.mp4", { grade: { lut: { id: "lut:abc" } }, color: { profile: "rec709", matrix: "bt709", fullRange: false, lutFile: "lut_abc.cube" } })],
    });
    expect(g.join(";")).toContain("lut3d=file=");
    expect(written.filter((w) => w.file.endsWith(".cube"))).toHaveLength(1);
    await expect(
      graphFor({
        clips: [clip("a.mp4", { grade: { lut: { id: "lut:missing" } }, color: { profile: "rec709", matrix: "bt709", fullRange: false, lutFile: "lut_missing.cube" } })],
      })
    ).rejects.toThrow(/The LUT lut_missing\.cube could not be read/);
  });

  test("a reversed clip's turned copy carries its code values as they are", async () => {
    const runs = await runsFor({
      clips: [clip("hdr.mp4", { reverse: true, color: { profile: "hlg", matrix: "bt2020nc", fullRange: false } })],
    });
    const chunk = runs.find((a) => a.includes("-ss"))!;
    expect(chunk[chunk.indexOf("-vf") + 1]).toBe("reverse,format=yuv420p");
    const enc = runs.find((a) => a.includes("-filter_complex"))!;
    const graph = enc[enc.indexOf("-filter_complex") + 1];
    expect(graph).toMatch(/scale=[^,]*in_color_matrix=bt2020:in_range=tv/);
    expect(graph).toContain("lut3d=file=");
    expect(untagged(graph.split(";")).join(";")).not.toContain("colorspace=");
  });
});

describe("an HDR delivery", () => {
  const hdrSpec = (over: Partial<ExportSpec> = {}): Partial<ExportSpec> => ({
    colorSpace: "hlg",
    codec: "hevc",
    clips: [clip("a.mp4")],
    ...over,
  });

  test("composites at ten bits in HLG: every clip maps into Rec.2020 and comes back as 10-bit video", async () => {
    const g = await graphFor(hdrSpec());
    const line = g.find((l) => l.startsWith("[0:v]"))!;
    // An ungraded Rec.709 clip is a conversion here, so it takes the LUT.
    expect(line).toMatch(/scale=[^,]*in_color_matrix=bt709:in_range=tv/);
    expect(line).toContain("format=gbrp16le,lut3d=file=");
    expect(line).toContain("scale=out_color_matrix=bt2020:out_range=tv");
    expect(line).toContain("format=yuv420p10le");
    expect(g.join(";")).not.toContain("format=yuv420p,");
    expect(g.join(";")).not.toContain("format=yuv420p[");
    const cubes = written.filter((w) => w.file.endsWith(".cube")).map((w) => path.basename(w.file));
    expect(cubes).toContain("clip_0.cube");
    expect(cubes).toContain("graphics.cube");
    expect(cubes).not.toContain("hlg_to_pq.cube");
  });

  test("an HLG file ungraded runs no LUT, and a graded one grades in place", async () => {
    const hlg = { profile: "hlg" as const, matrix: "bt2020nc" as const, fullRange: false };
    const plain = await graphFor(hdrSpec({ clips: [clip("h.mp4", { color: hlg })] }));
    expect(plain.find((l) => l.startsWith("[0:v]"))).not.toContain("lut3d");
    const graded = await graphFor(hdrSpec({ clips: [clip("h.mp4", { color: hlg, grade: { exposure: 10 } })] }));
    const line = graded.find((l) => l.startsWith("[0:v]"))!;
    expect(line).toMatch(/scale=[^,]*in_color_matrix=bt2020:in_range=tv/);
    expect(line).toContain("lut3d=file=");
    expect(line).toContain("scale=out_color_matrix=bt2020:out_range=tv");
  });

  test("graphics take the sRGB to HLG lattice before they overlay, and overlays blend at ten bits", async () => {
    const g = await graphFor(
      hdrSpec({
        duration: 4,
        overlays: [{ file: "o0.png", start: 0, end: 4 }],
        captions: [{ file: "cap1.png", start: 0, end: 2 }],
      })
    );
    const joined = g.join(";");
    const gfxLines = g.filter((l) => l.includes("format=gbrap16le,lut3d=file="));
    expect(gfxLines.length).toBeGreaterThanOrEqual(2);
    expect(gfxLines[0]).toContain(path.join("/tmp/graph-test", "graphics.cube"));
    expect(gfxLines[0]).toMatch(/\[gfx\d+\]$/);
    const graphics = written.find((w) => w.file.endsWith("graphics.cube"))!;
    expect(graphics.data).toContain("LUT_3D_SIZE 33");
    // The lattice's last node: sRGB white sits at HLG reference white.
    const last = graphics.data.trim().split("\n").at(-1)!.split(" ").map(Number);
    for (const v of last) expect(Math.abs(v - 0.75)).toBeLessThan(2e-4);
    expect(joined).toMatch(/overlay=[^\[]*:format=yuv420p10/);
    expect(joined).not.toMatch(/overlay=[^\[]*:format=yuv420p\b(?!10)/);
  });

  test("a PQ delivery ends with the fixed HLG to PQ pass and carries HDR10 metadata", async () => {
    const runs = await runsFor(hdrSpec({ colorSpace: "pq" }));
    const enc = runs.find((a) => a.includes("-filter_complex"))!;
    const graph = enc[enc.indexOf("-filter_complex") + 1];
    const pq = graph.split(";").find((l) => l.includes("hlg_to_pq.cube"))!;
    expect(pq).toContain("scale=in_color_matrix=bt2020:in_range=tv,format=gbrp16le,lut3d=file=");
    expect(pq).toContain("scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le[vpq]");
    expect(written.find((w) => w.file.endsWith("hlg_to_pq.cube"))!.data).toContain("LUT_3D_SIZE 65");
    expect(arg(enc, "-x265-params")).toContain("transfer=smpte2084");
    expect(arg(enc, "-x265-params")).toContain("hdr10=1");
    expect(arg(enc, "-x265-params")).toContain("master-display=G(13250,34500)");
    expect(arg(enc, "-x265-params")).toContain("max-cll=1000,400");
    expect(arg(enc, "-color_trc")).toBe("smpte2084");
    expect(arg(enc, "-bsf:v")).toBe("hevc_metadata=colour_primaries=9:transfer_characteristics=16:matrix_coefficients=9:video_full_range_flag=0");
  });

  test("the worker's HEVC is Main 10 with its color in the bitstream and the container", async () => {
    const args = await encodeRun(hdrSpec());
    expect(arg(args, "-c:v")).toBe("libx265");
    expect(arg(args, "-pix_fmt")).toBe("yuv420p10le");
    expect(arg(args, "-profile:v")).toBe("main10");
    expect(arg(args, "-tag:v")).toBe("hvc1");
    const params = arg(args, "-x265-params");
    expect(params).toContain("colorprim=bt2020");
    expect(params).toContain("transfer=arib-std-b67");
    expect(params).toContain("colormatrix=bt2020nc");
    expect(params).not.toContain("hdr10");
    expect(arg(args, "-colorspace")).toBe("bt2020nc");
    expect(arg(args, "-color_primaries")).toBe("bt2020");
    expect(arg(args, "-color_trc")).toBe("arib-std-b67");
    expect(arg(args, "-color_range")).toBe("tv");
    expect(arg(args, "-bsf:v")).toContain("transfer_characteristics=18");
    expect(args.join(" ")).not.toContain("hlg_to_pq");
  });

  test("the Mac's HEVC is Main 10 over p010, PQ with no static metadata", () => {
    const spec = { fps: 30, crf: 24, preset: "veryfast", codec: "hevc", colorSpace: "pq", width: 1080, height: 1920 } as ExportSpec;
    const args = videoCodecArgs("hevc_videotoolbox", spec);
    expect(arg(args, "-c:v")).toBe("hevc_videotoolbox");
    expect(arg(args, "-profile:v")).toBe("main10");
    expect(arg(args, "-pix_fmt")).toBe("p010le");
    expect(arg(args, "-tag:v")).toBe("hvc1");
    expect(arg(args, "-bsf:v")).toContain("transfer_characteristics=16");
    expect(args.join(" ")).not.toContain("master-display");
    expect(colorTagArgs(spec)).toEqual(["-color_range", "tv", "-colorspace", "bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084"]);
    expect(colorTagArgs({ colorSpace: "hlg" })[7]).toBe("arib-std-b67");
    expect(colorTagArgs({})).toEqual(["-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"]);
  });

  test("ProRes carries HDR at ten bits with the Rec.2020 tags", async () => {
    const args = await encodeRun(hdrSpec({ codec: "prores", container: "mov", audioCodec: "pcm" }));
    expect(arg(args, "-c:v")).toBe("prores_ks");
    expect(arg(args, "-pix_fmt")).toBe("yuv422p10le");
    expect(arg(args, "-color_trc")).toBe("arib-std-b67");
    expect(arg(args, "-colorspace")).toBe("bt2020nc");
  });

  test("H.264 is refused", async () => {
    await expect(runsFor(hdrSpec({ codec: "h264" }))).rejects.toThrow(/H\.264 is 8-bit/);
    await expect(runsFor(hdrSpec({ codec: undefined }))).rejects.toThrow(/H\.264 is 8-bit/);
    const spec = { fps: 30, crf: 24, preset: "veryfast", codec: "h264", colorSpace: "hlg" } as ExportSpec;
    expect(() => videoCodecArgs("libx264", spec)).toThrow(/H\.264 is 8-bit/);
    expect(() => videoCodecArgs("h264_videotoolbox", spec)).toThrow(/H\.264 is 8-bit/);
  });

  /** Every alpha-carrying segment kind at once: a painted mask on a keyed,
   * shadowed track-0 clip, a subject-matted clip, a removal clip, a masked
   * keyed overlay, and a subject-trimmed element. */
  const alphaSpec = (over: Partial<ExportSpec> = {}): Partial<ExportSpec> => ({
    duration: 12,
    clips: [
      clip("a.mp4", {
        mask: { file: "mask.png" },
        kf: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 10, opacity: 1 }],
        shadow: { file: "shadow.png" },
      }),
      clip("b.mp4", { mask: { subject: { feather: 1 } } }),
      clip("c.mp4", { removal: { rgb: "rm_rgb.mov", alpha: "rm_a.mov" } }),
    ],
    overlayVideos: [
      {
        file: "o.mp4",
        in: 0,
        out: 2,
        start: 1,
        track: 1,
        muted: true,
        frame: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
        mask: { file: "omask.png" },
        kf: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 5, opacity: 1 }],
      },
    ],
    overlays: [
      {
        frames: [{ file: "f0.png", duration: 0.5 }],
        blank: "blank.png",
        x: 0,
        y: 0,
        start: 1,
        end: 2,
        subject: { invert: true },
        lane: 0,
      },
    ],
    behindMask: { file: "matte.mp4", from: 0 },
    ...over,
  });

  test("alpha segments hold ten bits: masks merge as planes, multiply as a blend, and no rgba or alphamerge hop remains", async () => {
    const g = await graphFor(hdrSpec(alphaSpec()));
    const joined = g.join(";");
    expect(joined).not.toContain("format=rgba");
    expect(joined).not.toContain("alphamerge");
    expect(joined).not.toContain("alphaextract");
    // An 8-bit mask widens through 8-bit gray, which is exact, and nothing
    // reaches the alpha filters below ten bits.
    expect(joined).not.toMatch(/format=gray[,\]](?!format=gray10le)/);
    expect(joined).not.toMatch(/format=yuva?4[24][04]p[,\]]/);
    // Every mask reaches the alpha filters as a four-plane copy carrying the
    // composite's own tags, so negotiation never converts it on the way in.
    const carrier = "mergeplanes=0x00000000:format=yuva444p10le,setparams=range=tv:colorspace=bt2020nc";
    const multiply = "blend=c0_mode=normal:c1_mode=normal:c2_mode=normal:c3_mode=multiply";
    // Painted mask on track 0: the mask is ten-bit gray, the segment joins
    // the alpha family tagged like the video, the multiply is per plane.
    expect(joined).toContain("setsar=1,format=gray,format=gray10le[cmk0]");
    expect(joined).toContain(`[cmk0]${carrier}[cm0k]`);
    expect(joined).toContain("format=yuva444p10le,setparams=range=tv:colorspace=bt2020nc[cm0c]");
    expect(joined).toContain(`[cm0c][cm0k]${multiply}[cmc0]`);
    // The subject matte is ten-bit gray at the source and multiplies the same way.
    expect(joined).toMatch(/format=gray10le,tpad=start_duration=0\.000:color=black\[bh_src\]/);
    expect(joined).toContain(`[cs1c][cs1k]${multiply}[csc1]`);
    // A removal clip's keyed pair: the color piece converts with the
    // composite's matrix, the luma piece lands in the alpha plane by mergeplanes.
    expect(joined).toContain("scale=out_color_matrix=bt2020:out_range=tv,format=yuva444p10le[rvc2]");
    expect(joined).toContain("format=gray10le[rva2]");
    expect(joined).toContain("[rvc2][rv2k]mergeplanes=0x00010210:format=yuva444p10le,tpad=stop_mode=clone:stop_duration=1[rvs2]");
    // Shadow PNG, masked keyed overlay, subject-trimmed element.
    expect(joined).toContain("scale=out_color_matrix=bt2020:out_range=tv,format=yuva444p10le[csh0]");
    expect(joined).toContain(`[om0c][om0k]${multiply},format=yuva420p10le[omc0]`);
    expect(joined).toMatch(/\[omc0\]format=yuva444p10le,setparams=range=tv:colorspace=bt2020nc,rotate=/);
    expect(joined).toContain(`[oe0c][oe0k]${multiply},format=yuva420p10le[oes0]`);
  });

  test("nothing overlays onto a main that carries alpha: a pose lands as color and alpha, each on an opaque backdrop", async () => {
    // ffmpeg's ten-bit overlay onto a main with alpha unpremultiplies with
    // eight-bit constants: a keyed pose on a clear frame came out at a
    // quarter of its brightness. The posed picture changes size frame by
    // frame, so its alpha is read back after it lands, off a zero frame and
    // a full one.
    const g = await graphFor(
      hdrSpec(
        alphaSpec({
          clips: [
            clip("a.mp4", { kf: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 10, opacity: 1 }] }),
            clip("c.mp4", { removal: { rgb: "rm_rgb.mov", alpha: "rm_a.mov" }, animOut: { style: "pop", seconds: 0.5 } }),
          ],
          overlayVideos: [
            {
              file: "o.mp4", in: 0, out: 2, start: 1, track: 1, muted: true,
              frame: { x: 0.5, y: 0.5, w: 0.4, h: 0.4 },
              mask: { subject: { feather: 1 } },
              kf: [{ t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 5, opacity: 1 }],
            },
          ],
        })
      )
    );
    const joined = g.join(";");
    expect(joined).not.toContain("black@0.0:s=");
    expect(joined).toContain("[ckt0]format=yuva444p10le,split=3[ckb0c][ckb0z][ckb0f]");
    expect(joined).toContain("[ckb0c]format=yuv444p10le,setparams=range=tv:colorspace=bt2020nc[ckb0co]");
    expect(joined).toMatch(/\[ckb0zb\]\[ckb0z\]overlay=[^\[]*format=yuv444p10\[ckb0zp\]/);
    expect(joined).toContain("[ckb0fp][ckb0zp]blend=all_mode=subtract[ckb0inv]");
    expect(joined).toContain("[ckb0ff][ckb0inv]blend=all_mode=subtract[ckb0ap]");
    expect(joined).toContain("[ckb0cp][ckb0ap]mergeplanes=0x00010210:format=yuva444p10le[ckp0]");
    expect(joined).toContain("[osb0cp][osb0ap]mergeplanes=0x00010210:format=yuva444p10le[osp0]");
    // The removal clip's pop lands on the bare frame, opaque in format.
    expect(joined).toMatch(/color=c=black:s=1080x1920:r=30:d=0\.500,format=yuv444p10le\[xbc1_tail\]/);
    const mains = [...joined.matchAll(/\[([^\]]+)\]\[[^\]]+\]overlay=/g)].map((m) => m[1]);
    for (const main of mains) {
      const made = g.find((l) => l.endsWith(`[${main}]`)) ?? "";
      expect(made).not.toMatch(/format=yuva[^,\[]*\[[^\]]+\]$/);
    }
  });

  test("the finished frames carry the delivery's signalling, so a ProRes MOV gets its colr atom", async () => {
    const hlg = await graphFor(hdrSpec({ codec: "prores", container: "mov", audioCodec: "pcm" }));
    expect(hlg.at(-1)).toMatch(/^\[v\w*\]setparams=range=tv:colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67\[vtag\]$/);
    const pq = await graphFor(hdrSpec({ colorSpace: "pq" }));
    expect(pq.at(-1)).toBe("[vpq]setparams=range=tv:colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084[vtag]");
    const sdr = await graphFor({ codec: "prores", container: "mov", audioCodec: "pcm", clips: [clip("a.mp4")] });
    expect(sdr.at(-1)).toMatch(/^\[v\w*\]setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709\[vtag\]$/);
    const enc = (await runsFor(hdrSpec())).find((a) => a.includes("-filter_complex"))!;
    expect(enc[enc.indexOf("-map") + 1]).toBe("[vtag]");
    expect(colorParamsFilter({ colorSpace: "hlg" })).toContain("color_trc=arib-std-b67");
  });

  test("the same segments in SDR keep their rgba chains", async () => {
    const g = await graphFor(alphaSpec({ codec: "h264" }));
    const joined = untagged(g).join(";");
    expect(g.at(-1)).toContain("setparams=range=tv:colorspace=bt709");
    expect(joined).not.toContain("mergeplanes");
    expect(joined).not.toContain("setparams");
    expect(joined).not.toContain("gray10le");
    expect(joined).toContain("[cmk0]blend=all_mode=multiply");
    expect(joined).toContain("[rvc2][rva2]alphamerge,tpad=stop_mode=clone:stop_duration=1[rvs2]");
    expect(joined).toContain("[oe10]alphaextract,fps=30[oea0]");
    expect(joined).toContain("alphamerge,format=yuva420p[oes0]");
  });

  test("an SDR delivery is untouched: BT.709 tags, 8-bit planes, no graphics lattice", async () => {
    const args = await encodeRun({ codec: "hevc" });
    expect(arg(args, "-pix_fmt")).toBe("yuv420p");
    expect(arg(args, "-color_trc")).toBe("bt709");
    expect(args).not.toContain("-bsf:v");
    expect(written.some((w) => w.file.endsWith("graphics.cube"))).toBe(false);
  });
});

describe("a mastered delivery", () => {
  test("the encode pass writes the picture and the raw mix apart; the master joins them", async () => {
    const runs = await runsFor({ clips: [clip("a.mp4")], loudness: -14, truePeakCeiling: -1 });
    const enc = runs.find((a) => a.includes("-filter_complex"))!;
    // The video output carries no audio map of its own.
    const videoOut = enc.findIndex((a) => a.endsWith("encode.mp4"));
    expect(enc.slice(0, videoOut).filter((a) => a === "-map")).toHaveLength(1);
    const mixAt = enc.indexOf("/tmp/graph-test/mix.f32");
    expect(enc.slice(videoOut, mixAt)).toContain("pcm_f32le");
    expect(mastered).toEqual([
      {
        input: "/tmp/graph-test/mix.f32",
        output: "/tmp/graph-test/master.f32",
        opts: { sampleRate: 44100, channels: 2, targetLufs: -14, ceilingDbtp: -1 },
      },
    ]);
    const mux = runs[runs.length - 1];
    expect(mux).toContain("/tmp/graph-test/master.f32");
    expect(arg(mux, "-c:v")).toBe("copy");
    expect(arg(mux, "-c:a")).toBe("aac");
    expect(mux[mux.length - 1]).toBe("/tmp/graph-test/out.mp4");
  });

  test("an unmastered delivery keeps its one-pass sound and plain remux", async () => {
    const runs = await runsFor({ clips: [clip("a.mp4")] });
    expect(mastered).toEqual([]);
    expect(arg(runs[runs.length - 1], "-c")).toBe("copy");
  });
});

describe("stems", () => {
  const stemSpec: Partial<ExportSpec> = {
    clips: [clip("a.mp4")],
    overlayVideos: [{ file: "b.mp4", in: 0, out: 2, start: 1, track: 1, muted: false }],
    audio: [
      { file: "vo.mp3", in: 0, out: 2, start: 0, volume: 1, duck: 0.3 },
      { file: "song.mp3", in: 0, out: 4, start: 0, volume: 0.5, lane: 1 },
    ],
    stemPlan: [
      { name: "Dialogue", lane: null, file: "1 Dialogue.wav" },
      { name: "Voiceover", lane: 0, file: "2 Voiceover.wav" },
      { name: "Music", lane: 1, file: "3 Music.wav" },
    ],
  };

  test("every stream the mix sums is split once into its stem, and the mix still sums them all", async () => {
    const graph = await graphFor(stemSpec);
    const splits = graph.filter((l) => /asplit=2\[[^\]]+m\]\[[^\]]+s\]$/.test(l));
    // Track-0 sound, the upper-track clip's, the voiceover and the song.
    expect(splits).toHaveLength(4);
    const mix = graph.find((l) => l.endsWith("[amix]"))!;
    expect(mix).toContain("amix=inputs=4");
    expect(mix.match(/m\]/g)).toHaveLength(4);
  });

  test("each stem runs the delivery's length and lands as a 24-bit WAV, then packs into the zip", async () => {
    const runs = await runsFor({ ...stemSpec, duration: 4 });
    const enc = runs.find((a) => a.includes("-filter_complex"))!;
    const graph = arg(enc, "-filter_complex").split(";");
    for (let i = 0; i < 3; i++) {
      expect(graph.some((l) => l.endsWith(`apad=whole_dur=4.000,atrim=0:4.000[stem${i}]`))).toBe(true);
      expect(enc).toContain(`/tmp/graph-test/stem_${i}.wav`);
    }
    expect(enc.filter((a) => a === "pcm_s24le")).toHaveLength(3);
    expect(packed).toEqual([
      {
        output: "/tmp/graph-test/out stems.zip",
        files: [
          { path: "/tmp/graph-test/stem_0.wav", name: "1 Dialogue.wav" },
          { path: "/tmp/graph-test/stem_1.wav", name: "2 Voiceover.wav" },
          { path: "/tmp/graph-test/stem_2.wav", name: "3 Music.wav" },
        ],
      },
    ]);
  });

  test("an audio effect treats every stem as it treats the mix", async () => {
    const graph = await graphFor({
      ...stemSpec,
      duration: 4,
      effects: [{ effect: "echo", start: 0, end: 4 }],
    });
    expect(graph.some((l) => l.endsWith("[afx0]"))).toBe(true);
    for (let i = 0; i < 3; i++) expect(graph.some((l) => l.endsWith(`[afxs${i}_0]`))).toBe(true);
  });

  test("a range cuts every stem to the delivered window", async () => {
    const graph = await graphFor({ ...stemSpec, duration: 4, range: { start: 1, end: 3 } });
    expect(graph.find((l) => l.endsWith("[stem2]"))).toContain("atrim=start=1.000:end=3.000");
  });

  test("a spec that asks for stems renders even when its source could copy", async () => {
    const runs = await runsFor({ ...stemSpec, sourceSegments: [{ file: "a.mp4", from: 0, to: 4 }], target: "export" });
    expect(runs.some((a) => a.includes("-filter_complex"))).toBe(true);
  });
});
