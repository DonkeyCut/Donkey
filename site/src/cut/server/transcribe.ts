import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertLocalRuntime } from "./local-only";
import { createJobRegistry } from "./jobRegistry";
import { mediaPath, readProject } from "./projects";
import { atempoChain, findOnPath, hasStream, num, round } from "./util";

/** The audible slice of the cut, in timeline time (mirrors ExportSpec). */
export interface TranscribeSpec {
  projectId: string;
  duration: number;
  locale?: string;
  clips: {
    file: string;
    in: number;
    out: number;
    muted: boolean;
    speed?: number;
    /** Cross-dissolve overlap into the next clip, timeline seconds. */
    transition?: number;
  }[];
  audio: { file: string; in: number; out: number; start: number; volume: number; speed?: number }[];
}

interface Word {
  t0: number;
  t1: number;
  w: string;
}

export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface TranscribeJob {
  id: string;
  projectId: string;
  status: "running" | "done" | "error";
  stage: "audio" | "model" | "transcribe";
  error?: string;
  cues?: Cue[];
}

const MAX_RUNNING = 1; // on-device transcription is heavy; one at a time
// Survives dev-server module reloads; caps the terminal backlog.
const { jobs, runningCount, retire } = createJobRegistry<TranscribeJob>("__veditorSttJobs");

export function getTranscribeJob(id: string) {
  return jobs.get(id);
}

function run(cmd: string, args: string[], notFound?: string, timeoutMs = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    timer.unref();
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e.message.includes("ENOENT") && notFound ? new Error(notFound) : e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim().split("\n").slice(-4).join("\n") || `${cmd} exited ${code}`));
    });
  });
}

/**
 * The speech engine: Apple's on-device SpeechAnalyzer (macOS 26+), wrapped by
 * a tiny Swift CLI. The packaged engine ships cut-stt beside its own binary
 * (that directory leads PATH) and resolves it exclusively from PATH, so a dev
 * machine exercises the exact prod lookup; the plain dev server compiles the
 * source on first use into ~/.cache/cut. Nothing ever leaves the machine.
 */
export async function ensureStt(): Promise<string> {
  const prebuilt = await findOnPath("cut-stt");
  if (prebuilt) return prebuilt;
  if (process.env.DONKEY_CUT_ENGINE) {
    throw new Error("The speech tool is missing. Update Donkey to restore transcription.");
  }

  const src = path.join(process.cwd(), "src", "cut", "server", "native", "cut-stt.swift");
  const bin = path.join(os.homedir(), ".cache", "cut", "cut-stt");
  const [b, s] = await Promise.all([stat(bin).catch(() => null), stat(src).catch(() => null)]);
  if (b?.isFile() && (!s || b.mtimeMs >= s.mtimeMs)) return bin;
  if (!s) {
    throw new Error("The speech tool is missing. Update Donkey to restore transcription.");
  }
  await mkdir(path.dirname(bin), { recursive: true });
  await run(
    "swiftc",
    ["-O", "-parse-as-library", src, "-o", bin],
    "Swift compiler not found. Install the Xcode Command Line Tools: xcode-select --install"
  ).catch((e: Error) => {
    throw new Error(`Could not build the on-device speech engine (needs macOS 26+).\n${e.message}`);
  });
  return bin;
}

/** Group word timings into short caption-sized cues (CapCut/Opus style). */
export function groupWords(words: Word[]): Cue[] {
  const MAX_CHARS = 38;
  const MAX_DUR = 3.5;
  const GAP = 0.6;
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const start = round(cur[0].t0);
    cues.push({
      id: crypto.randomUUID().slice(0, 8),
      start,
      end: round(Math.max(cur[cur.length - 1].t1, start + 0.3)),
      text: cur.map((w) => w.w).join(" "),
      words: cur.map((w) => ({ t0: round(w.t0), t1: round(w.t1), w: w.w })),
    });
    cur = [];
  };
  for (const w of words) {
    if (cur.length > 0) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      if (
        w.t0 - last.t1 > GAP ||
        chars > MAX_CHARS ||
        w.t1 - cur[0].t0 > MAX_DUR ||
        /[.!?…]$/.test(last.w)
      )
        flush();
    }
    cur.push(w);
  }
  flush();
  return cues;
}

/** Cues from one cut-stt run: drop what the model emits degenerate, clamp to
 * the audio's own length, and group the words into caption-sized cues. */
function cuesFromStt(out: string, duration: number): Cue[] {
  const parsed = JSON.parse(out) as { words: Word[] };
  const words = parsed.words
    .filter((w) => w.w.trim().length > 0 && w.t1 > w.t0 - 0.001)
    .map((w) => ({
      t0: Math.max(0, Math.min(w.t0, duration)),
      t1: Math.max(0, Math.min(w.t1, duration)),
      w: w.w.trim(),
    }))
    .filter((w) => w.t1 > w.t0);
  return groupWords(words);
}

/**
 * Transcribe audio the caller hands over, for a project this engine does not
 * store. A cloud project's media lives in R2, so the browser renders its
 * audible mix (the same graph runTranscribe builds with ffmpeg) and posts the
 * wav here — on-device speech then works whatever holds the project, and its
 * real word timings beat the hosted route's interpolated ones. Shares the
 * registry with the project path, so heavy speech still runs one at a time.
 */
export async function createAudioTranscribeJob(
  audio: Uint8Array,
  opts: { locale?: string; duration?: number } = {}
): Promise<TranscribeJob> {
  assertLocalRuntime();
  const id = crypto.randomUUID().slice(0, 12);
  if (runningCount() >= MAX_RUNNING) return busyJob(id, "");
  const job: TranscribeJob = { id, projectId: "", status: "running", stage: "model" };
  jobs.set(job.id, job);
  void runAudioTranscribe(job, audio, opts)
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => retire(job));
  return job;
}

async function runAudioTranscribe(
  job: TranscribeJob,
  audio: Uint8Array,
  { locale, duration }: { locale?: string; duration?: number }
) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "veditor-stt-"));
  try {
    const wav = path.join(tmpDir, "mix.wav");
    await writeFile(wav, audio);
    const bin = await ensureStt();
    job.stage = "transcribe";
    const out = await run(bin, [wav, locale ?? "en-US"]);
    job.cues = cuesFromStt(out, duration && duration > 0 ? duration : Infinity);
    job.status = "done";
  } finally {
    void rm(tmpDir, { recursive: true, force: true });
  }
}

function busyJob(id: string, projectId: string): TranscribeJob {
  const job: TranscribeJob = {
    id,
    projectId,
    status: "error",
    stage: "audio",
    error: "A transcription is already running — wait for it to finish.",
  };
  jobs.set(id, job);
  retire(job);
  return job;
}

export async function createTranscribeJob(spec: TranscribeSpec): Promise<TranscribeJob> {
  assertLocalRuntime();
  const id = crypto.randomUUID().slice(0, 12);
  if (runningCount() >= MAX_RUNNING) return busyJob(id, spec.projectId);
  const job: TranscribeJob = {
    id,
    projectId: spec.projectId,
    status: "running",
    stage: "audio",
  };
  jobs.set(job.id, job);
  void runTranscribe(job, spec)
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => retire(job));
  return job;
}

async function runTranscribe(job: TranscribeJob, spec: TranscribeSpec) {
  if (!(await readProject(spec.projectId))) throw new Error("Project not found.");
  // Video clips or a soundtrack clip are both valid speech sources (the render
  // below mixes either), so an audio-only cut — a voiceover with no video, or a
  // brief-to-video run transcribing its audio spine — transcribes fine.
  if (spec.clips.length === 0 && spec.audio.length === 0)
    throw new Error("Add audio or video to the timeline first.");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "veditor-stt-"));
  try {
    // Render the cut's audible mix (clip audio + soundtrack, in timeline
    // time) to a 16 kHz mono wav — the same graph the export uses, minus
    // video, so cue times line up with the timeline exactly. Gap spacers
    // (empty file) reference no media — they mix in as silence.
    const files = [...new Set([...spec.clips, ...spec.audio].map((c) => c.file).filter(Boolean))];
    const inputs: string[] = [];
    const inputIndex = new Map<string, number>();
    const audible = new Map<string, boolean>();
    const paths = files.map((f) => mediaPath(spec.projectId, f));
    await Promise.all(
      paths.map(async (p, i) => {
        if (!(await stat(p).catch(() => null)))
          throw new Error(`Media file missing: ${files[i]}`);
      })
    );
    files.forEach((f, i) => {
      inputIndex.set(f, inputs.length / 2);
      inputs.push("-i", paths[i]);
    });
    await Promise.all(
      files.map(async (f, i) => audible.set(f, await hasStream(paths[i], "a")))
    );

    const hasSpeechSource =
      spec.clips.some((c) => !c.muted && audible.get(c.file)) ||
      spec.audio.some((a) => audible.get(a.file));
    if (!hasSpeechSource) {
      job.cues = [];
      job.status = "done";
      return;
    }

    const filters: string[] = [];
    // Per-clip timeline length: a sped-up clip is shorter and time-stretched,
    // so the transcript's cue times line up with what the user sees. A gap
    // spacer (no file) keeps its exact length — flooring it at 0.1s would
    // land every cue after the gap late.
    const clipDur = (c: TranscribeSpec["clips"][number]) => {
      const speed = c.speed && c.speed > 0 ? c.speed : 1;
      return c.file ? Math.max(0.1, (c.out - c.in) / speed) : Math.max(0, c.out - c.in);
    };
    spec.clips.forEach((c, j) => {
      const speed = c.speed && c.speed > 0 ? c.speed : 1;
      const dur = clipDur(c);
      if (!c.muted && audible.get(c.file)) {
        const tempo = speed !== 1 ? `${atempoChain(speed)},` : "";
        filters.push(
          `[${inputIndex.get(c.file)}:a]atrim=${num(c.in)}:${num(c.out)},asetpts=PTS-STARTPTS,${tempo}` +
            `aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,` +
            `apad=whole_dur=${num(dur)},atrim=0:${num(dur)}[a${j}]`
        );
      } else {
        filters.push(`anullsrc=r=16000:cl=mono,atrim=0:${num(dur)},asetpts=PTS-STARTPTS[a${j}]`);
      }
    });
    // Join clip audio exactly as the timeline (and export) do: adjacent clips
    // with a cross-dissolve overlap by the transition length (acrossfade), the
    // rest concatenate. A flat concat would run longer than the timeline, so
    // every cue after a dissolve would land progressively late.
    // Skipped entirely for an audio-only cut (no clips) — there is no clip-audio
    // chain to build, only the soundtrack, mixed below. (`spec.clips[0]` would be
    // undefined otherwise.)
    let aAcc: string | null = null;
    if (spec.clips.length > 0) {
      aAcc = "a0";
      let acc = clipDur(spec.clips[0]);
      for (let j = 1; j < spec.clips.length; j++) {
        const prev = spec.clips[j - 1];
        const durJ = clipDur(spec.clips[j]);
        const d = Math.min(prev.transition ?? 0, acc * 0.9, durJ * 0.9);
        const out = `aj${j}`;
        if (d > 0.01) {
          filters.push(`[${aAcc}][a${j}]acrossfade=d=${num(d)}[${out}]`);
          acc = acc + durJ - d;
        } else {
          filters.push(`[${aAcc}][a${j}]concat=n=2:v=0:a=1[${out}]`);
          acc = acc + durJ;
        }
        aAcc = out;
      }
    }

    const soundLabels: string[] = [];
    spec.audio.forEach((a, k) => {
      if (!audible.get(a.file)) return;
      const speed = a.speed && a.speed > 0 ? a.speed : 1;
      const tempo = speed !== 1 ? `${atempoChain(speed)},` : "";
      filters.push(
        `[${inputIndex.get(a.file)}:a]atrim=${num(a.in)}:${num(a.out)},asetpts=PTS-STARTPTS,${tempo}` +
          `aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,` +
          `volume=${num(a.volume)},adelay=${Math.max(0, Math.round(a.start * 1000))}:all=1[snd${k}]`
      );
      soundLabels.push(`snd${k}`);
    });

    // Mix the clip chain (when present) with the soundtrack. A single source
    // needs no amix; hasSpeechSource above guarantees at least one input here.
    // duration=longest spans every input (a late soundtrack clip must not be
    // cut off — with no video clip chain, `first` would truncate the mix to the
    // earliest-finishing clip and drop later speech); the outer `-t
    // spec.duration` then trims to the timeline.
    const mixInputs = [...(aAcc ? [aAcc] : []), ...soundLabels];
    let aLabel: string;
    if (mixInputs.length <= 1) {
      aLabel = mixInputs[0];
    } else {
      filters.push(
        mixInputs.map((l) => `[${l}]`).join("") +
          `amix=inputs=${mixInputs.length}:duration=longest:dropout_transition=0:normalize=0[amix]`
      );
      aLabel = "amix";
    }

    const wav = path.join(tmpDir, "mix.wav");
    await run(
      "ffmpeg",
      [
        "-y",
        ...inputs,
        "-filter_complex", filters.join(";"),
        "-map", `[${aLabel}]`,
        "-ac", "1",
        "-ar", "16000",
        "-t", num(spec.duration),
        wav,
      ],
      "ffmpeg was not found. Install it with: brew install ffmpeg"
    );

    job.stage = "model";
    const bin = await ensureStt();

    job.stage = "transcribe";
    const out = await run(bin, [wav, spec.locale ?? "en-US"]);
    job.cues = cuesFromStt(out, spec.duration);
    job.status = "done";
  } finally {
    void rm(tmpDir, { recursive: true, force: true });
  }
}
