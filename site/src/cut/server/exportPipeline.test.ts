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
