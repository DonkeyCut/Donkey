import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { passWindows, runExport, type ExportSpec, type RenderHandle } from "./exportPipeline";

// The graph tests assert shapes; this one hands the real graph to a real
// ffmpeg. It synthesizes every asset kind from lavfi sources, builds one
// project that uses every ExportSpec feature — framing crops, regions,
// transitions, edge animations, looks, grades, masks (painted and subject),
// keyframed poses, borders, shadows, overlay videos, elements (static and
// slideshow), effects, captions, an audio bed with ducking, whole-video
// fades, a background color, a gap, a clip played backward — and renders it
// end to end. A filter ffmpeg rejects, a broken option value, or an
// unconnected pad fails here before it can fail an export.
//
// It runs once per delivery, because the graph is built in the chroma the
// delivery carries: a ProRes 4444 master composites at 4:4:4, where every
// filter and every `overlay` negotiates a different pixel family than the
// 4:2:0 the H.264 file is built in.
const DELIVERIES = [
  { name: "an H.264 MP4", ext: "mp4", codec: "h264", pixFmt: "yuv420p", trc: "bt709", over: {} },
  {
    // ProRes 4444's bitstream carries twelve bits, so the file reads back as
    // yuv444p12le whatever the encoder was handed.
    name: "a ProRes 4444 master",
    ext: "mov",
    codec: "prores",
    pixFmt: "yuv444p12le",
    trc: "bt709",
    over: { codec: "prores4444", container: "mov", audioCodec: "pcm" },
  },
  {
    // An HDR delivery composites at ten bits; every alpha segment (the
    // masked keyed clip, the subject matte, the masked overlay) must reach
    // the Main 10 file without an 8-bit hop.
    name: "an HLG HEVC file",
    ext: "mp4",
    codec: "hevc",
    pixFmt: "yuv420p10le",
    trc: "arib-std-b67",
    over: { codec: "hevc", colorSpace: "hlg" },
  },
] as const satisfies readonly {
  name: string;
  ext: string;
  codec: string;
  /** What the finished file decodes as. */
  pixFmt: string;
  /** The transfer the file's header signals. */
  trc: string;
  over: Partial<ExportSpec>;
}[];

const available = (cmd: string) =>
  spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
const tools = available("ffmpeg") && available("ffprobe");

const ff = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${r.stderr}`);
};

const probe = (file: string) => {
  const r = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration",
      "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,color_transfer",
      "-of", "json",
      file,
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`ffprobe failed:\n${r.stderr}`);
  return JSON.parse(r.stdout) as {
    format: { duration: string };
    streams: {
      codec_type: string;
      codec_name: string;
      pix_fmt?: string;
      width?: number;
      height?: number;
      color_transfer?: string;
    }[];
  };
};

const W = 320;
const H = 568;

/** Synthesizes every asset kind from lavfi sources into `mediaDir` (project
 * media) and `tmpDir` (client-painted stills), and returns one project that
 * uses every ExportSpec feature over them. */
async function everyFeature(mediaDir: string, tmpDir: string): Promise<ExportSpec> {
  // ---- Footage, stills, and the audio bed (project media) ----------
  const vid = (name: string, src: string, hz: number, secs: number) =>
    ff([
      "-f", "lavfi", "-i", `${src}=size=320x240:rate=24:duration=${secs}`,
      "-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=44100:duration=${secs}`,
      "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac",
      path.join(mediaDir, name),
    ]);
  vid("a.mp4", "testsrc2", 440, 3);
  vid("b.mp4", "smptebars", 660, 3);
  vid("o.mp4", "testsrc", 880, 3);
  ff([
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1:duration=1",
    "-frames:v", "1", path.join(mediaDir, "img.png"),
  ]);
  ff([
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=6",
    "-c:a", "aac", path.join(mediaDir, "music.m4a"),
  ]);

  // ---- Client-painted stills and the person matte (job.tmpDir) -----
  const png = (name: string, chain: string) =>
    ff(["-f", "lavfi", "-i", chain, "-frames:v", "1", path.join(tmpDir, name)]);
  png("mask.png", `color=c=white:s=${W}x${H},format=gray`);
  png("omask.png", "color=c=0xC0C0C0:s=160x160,format=gray");
  png("el.png", `color=c=red@0.5:s=${W}x${H},format=rgba`);
  png("f0.png", "color=c=blue:s=120x80,format=rgba");
  png("f1.png", "color=c=green:s=120x80,format=rgba");
  png("blank.png", "color=c=black@0.0:s=120x80,format=rgba");
  png("border.png", `color=c=yellow@0.6:s=${W}x${H},format=rgba`);
  png("oborder.png", "color=c=cyan@0.6:s=128x256,format=rgba");
  png("shadow.png", `color=c=black@0.4:s=${W}x${H},format=rgba`);
  png("cap.png", `color=c=white@0.8:s=${W}x${H},format=rgba`);
  png("sub_blank.png", `color=c=black@0.0:s=${W}x${H},format=rgba`);
  ff([
    "-f", "lavfi", "-i", `color=c=gray:s=${W}x${H}:d=6:r=24`,
    "-pix_fmt", "yuv420p", path.join(tmpDir, "matte.mp4"),
  ]);

  // Timeline: 1.6s (sped-up cover crop) + 2s (graded, masked, keyed)
  // + 1s gap + 1.5s regioned still = 6.1s.
  return {
    projectId: "e2e",
    width: W,
    height: H,
    fps: 24,
    crf: 30,
    preset: "ultrafast",
    duration: 6.1,
    background: "#102030",
    clips: [
      {
        file: "a.mp4", in: 0, out: 2, muted: false, volume: 0.8,
        fit: "fill", zoom: 1.4, panX: 0.3, panY: -0.2,
        speed: 1.25,
        look: "vhs", lookAmount: 0.7,
        animIn: { style: "pop", seconds: 0.4 },
        transition: 0.5, transitionStyle: "crosszoom",
      },
      {
        file: "b.mp4", in: 0, out: 2, muted: false,
        fit: "fit", reverse: true,
        grade: { brightness: 5, contrast: 8, saturation: -10, temperature: 12, hue: 10 },
        mask: { file: "mask.png" },
        kf: [
          { t: 0, x: 0.5, y: 0.5, scale: 1, rotation: 0, opacity: 1 },
          { t: 1.5, x: 0.6, y: 0.4, scale: 0.8, rotation: 15, opacity: 1 },
        ],
        animOut: { style: "fade", seconds: 0.4 },
        transition: 0.4, transitionStyle: "wipeleft",
      },
      { file: "", in: 0, out: 1, muted: true, hidden: true },
      {
        file: "img.png", in: 0, out: 1.5, muted: true, image: true,
        frame: { x: 0.5, y: 0.45, w: 0.45, h: 0.5 }, fit: "fill",
        mask: { subject: { feather: 1 } },
        border: "border.png",
        shadow: { file: "shadow.png" },
      },
    ],
    overlayVideos: [
      {
        file: "o.mp4", in: 0.2, out: 1.8, start: 0.8, track: 1,
        frame: { x: 0.55, y: 0.5, w: 0.4, h: 0.45 },
        fit: "fill", zoom: 1.3, panX: -0.4,
        muted: false, volume: 0.5, speed: 2,
        headFade: 0.3,
        mask: { file: "omask.png" },
        border: "oborder.png",
        kf: [
          { t: 0, x: 0.75, y: 0.7, scale: 1, rotation: 0, opacity: 1 },
          { t: 0.6, x: 0.65, y: 0.75, scale: 1.1, rotation: -10, opacity: 1 },
        ],
      },
    ],
    audio: [
      { file: "music.m4a", in: 0, out: 4, start: 0, volume: 0.6, fadeIn: 0.2, fadeOut: 0.4 },
      { file: "a.mp4", in: 0, out: 1, start: 2, volume: 1, duck: 0.3, speed: 1.1 },
    ],
    overlays: [
      { file: "el.png", start: 0.5, end: 2.5, lane: 1 },
      {
        frames: [
          { file: "f0.png", duration: 0.5 },
          { file: "f1.png", duration: 0.5 },
        ],
        blank: "blank.png", x: 40, y: 60, start: 1, end: 2,
        subject: { invert: true, feather: 2 }, lane: 0,
      },
    ],
    behindMask: { file: "matte.mp4", from: 0.5 },
    effects: [
      { effect: "vignette", amount: 0.6, start: 0.5, end: 2, lane: 0 },
      { effect: "zoom", amount: 0.4, focus: { x: 0.5, y: 0.4 }, ramp: 0.4, start: 2, end: 3, lane: 1 },
    ],
    captions: [
      { file: "cap.png", start: 0.3, end: 1.2 },
      { file: "cap.png", start: 1.4, end: 2.0 },
    ],
  };
}

for (const delivery of DELIVERIES) describe("export pipeline end to end", () => {
  test.skipIf(!tools)(
    `a project using every pipeline feature renders through real ffmpeg as ${delivery.name}`,
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-job-"));
      try {
        const spec: ExportSpec = {
          ...(await everyFeature(mediaDir, tmpDir)),
          ...delivery.over,
        };

        const job: RenderHandle = {
          tmpDir,
          outPath: path.join(tmpDir, `out.${delivery.ext}`),
          progress: 0,
          log: [],
        };
        await runExport(job, spec, (file) => path.join(mediaDir, file));

        const info = await stat(job.outPath);
        expect(info.size).toBeGreaterThan(0);
        const meta = probe(job.outPath);
        expect(Number(meta.format.duration)).toBeGreaterThan(spec.duration - 0.3);
        expect(Number(meta.format.duration)).toBeLessThan(spec.duration + 0.3);
        const video = meta.streams.find((s) => s.codec_type === "video");
        expect(video?.width).toBe(W);
        expect(video?.height).toBe(H);
        expect(video?.codec_name).toBe(delivery.codec);
        // The chroma the composite was built in is the chroma the file holds:
        // 4:4:4 all the way through for the master, 4:2:0 for the MP4.
        expect(video?.pix_fmt).toBe(delivery.pixFmt);
        // The header signals the delivery's transfer whatever the container:
        // a MOV takes it from the frames, an MP4 from the bitstream.
        expect(video?.color_transfer).toBe(delivery.trc);
        expect(meta.streams.some((s) => s.codec_type === "audio")).toBe(true);
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});

/** Every frame and sample a file decodes to, one hash per frame. */
// A render's content: each picture's hash, and every decoded sample as
// 16-bit — a single pass hands the muxer sound in whatever packets the graph
// made, a join in even ones, so the samples compare whole.
const ffmpegOut = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { maxBuffer: 256 << 20 });
  if (r.status !== 0) {
    throw new Error(`ffmpeg ${args.join(" ")} failed:\n${r.stderr}`);
  }
  return r.stdout;
};
const framesOf = (file: string) => ({
  pictures: ffmpegOut(["-i", file, "-map", "0:v?", "-f", "framemd5", "-"]).toString().split("\n").filter((l) => !l.startsWith("#")),
  samples: new Int16Array(new Uint8Array(ffmpegOut(["-i", file, "-map", "0:a?", "-f", "s16le", "-c:a", "pcm_s16le", "-"])).buffer),
});

// The largest gap between two runs of samples, which must be as long.
const sampleGap = (a: Int16Array, b: Int16Array) => {
  expect(a.length).toBe(b.length);
  return a.reduce((gap, v, i) => Math.max(gap, Math.abs(v - b[i])), 0);
};

/** The spec rendered in passes of `pieces`, at the default memory budget. */
const inPieces = (spec: ExportSpec, pieces: number): ExportSpec => ({ ...spec, passes: { holdMB: 2048, pieces } });
/** More pieces than any fixture has: the whole delivery in one pass. */
const ONE_PASS = 10_000;

describe("a delivery rendered in passes", () => {
  // The same every-feature project rendered in one pass and in passes of two
  // pieces. ProRes is intra-only and the sound is PCM, so the same frames and
  // samples encode to the same bits whichever pass made them: the joined
  // file, its mastered mix and its stems decode exactly as the one pass's do.
  // Both sounds are resampled (the mix to 48kHz, the stems to theirs), the
  // case where a pass cut off the sample grid would show.
  test.skipIf(!tools)(
    "joins into the frames, mix and stems one pass renders",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-media-"));
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-job-"));
      const jobsDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-jobs-"));
      try {
        const spec: ExportSpec = {
          ...(await everyFeature(mediaDir, tmpDir)),
          codec: "prores4444",
          container: "mov",
          audioCodec: "pcm",
          audioSampleRate: 48000,
          loudness: -16,
          truePeakCeiling: -1,
          stemPlan: [
            { name: "Dialogue", lane: null, file: "1 Dialogue.wav" },
            { name: "Music", lane: 0, file: "2 Music.wav" },
          ],
        };
        expect(passWindows(inPieces(spec, 2), () => ({ pixels: 0, fps: 30 })).length).toBeGreaterThan(2);

        // Each render runs in its own copy of the job dir, so the stems it
        // packs stay on disk beside its file.
        const render = async (name: string, passPieces: number) => {
          const dir = path.join(jobsDir, name);
          await cp(tmpDir, dir, { recursive: true });
          const job: RenderHandle = {
            tmpDir: dir,
            outPath: path.join(dir, "out.mov"),
            stemsPath: path.join(dir, "stems.zip"),
            progress: 0,
            log: [],
          };
          await runExport(job, inPieces(spec, passPieces), (file) => path.join(mediaDir, file));
          return { file: job.outPath, stems: spec.stemPlan!.map((_, i) => path.join(dir, `stem_${i}.wav`)) };
        };
        const whole = await render("whole", ONE_PASS);
        const passes = await render("passes", 2);

        expect(framesOf(passes.file)).toEqual(framesOf(whole.file));
        for (const [i, stem] of passes.stems.entries()) {
          expect(framesOf(stem)).toEqual(framesOf(whole.stems[i]));
        }
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
        await rm(tmpDir, { recursive: true, force: true });
        await rm(jobsDir, { recursive: true, force: true });
      }
    },
    240_000
  );
});

describe("a long recording cut out of order", () => {
  // Cuts from all over one 40s recording, played out of source order, with
  // sound handles, a split edit, a transition, a cross dissolve, a layered
  // clip and a sound entry reading the same file late. Rendered in passes of
  // three, each pass opens the file at its own earliest read; the file
  // decodes exactly as the one pass's does.
  test.skipIf(!tools)(
    "renders in passes as in one",
    async () => {
      const mediaDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-media-"));
      const jobsDir = await mkdtemp(path.join(os.tmpdir(), "cut-e2e-jobs-"));
      try {
        ff([
          "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=40",
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=40",
          "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", "-g", "48",
          path.join(mediaDir, "talk.mp4"),
        ]);
        const at = [31, 4, 22, 12, 36, 8, 27, 17, 2, 33, 14, 25];
        const clips: ExportSpec["clips"] = at.map((from, k) => ({
          file: "talk.mp4",
          in: from,
          // 37 frames: window edges fall between milliseconds.
          out: from + 37 / 24,
          muted: false,
          soundBack: 0.4,
          soundAhead: 0.4,
          ...(k === 3 ? { speed: 1.5 } : {}),
          ...(k === 5 ? { transition: 0.4 } : {}),
          ...(k === 7 ? { soundCross: 0.2 } : {}),
          ...(k === 9 ? { soundLead: 0.3, splitFade: 0.05 } : {}),
        }));
        const spec: ExportSpec = {
          projectId: "e2e",
          width: W,
          height: H,
          fps: 24,
          crf: 30,
          preset: "ultrafast",
          duration: clips.reduce((sum, c) => sum + (c.out - c.in) / (c.speed ?? 1), 0),
          clips,
          overlayVideos: [
            {
              file: "talk.mp4", in: 29, out: 31, start: 12, track: 1,
              frame: { x: 0.55, y: 0.5, w: 0.4, h: 0.45 }, muted: false, volume: 0.5,
            },
          ],
          audio: [{ file: "talk.mp4", in: 35, out: 38, start: 9, volume: 0.4 }],
          overlays: [],
          codec: "prores4444",
          container: "mov",
          audioCodec: "pcm",
        };
        expect(passWindows(inPieces(spec, 3), () => ({ pixels: 0, fps: 30 })).length).toBeGreaterThan(3);

        const render = async (name: string, passPieces: number) => {
          const dir = path.join(jobsDir, name);
          await mkdir(dir);
          const job: RenderHandle = { tmpDir: dir, outPath: path.join(dir, "out.mov"), progress: 0, log: [] };
          await runExport(job, inPieces(spec, passPieces), (file) => path.join(mediaDir, file));
          return job.outPath;
        };
        const whole = await render("whole", ONE_PASS);
        const passes = await render("passes", 3);
        // An AAC decoder fills noise-coded bands from a generator a seek
        // restarts, so a pass that reads from its window's first source
        // second carries the same sound to within one 16-bit step.
        const [got, want] = [framesOf(passes), framesOf(whole)];
        expect(got.pictures).toEqual(want.pictures);
        expect(sampleGap(got.samples, want.samples)).toBeLessThanOrEqual(1);
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
        await rm(jobsDir, { recursive: true, force: true });
      }
    },
    240_000
  );
});
