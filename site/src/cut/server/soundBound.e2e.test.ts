import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExport, type ExportSpec, type RenderHandle } from "./exportPipeline";

// A clip's sound away from its own track and its own picture, through a real
// ffmpeg: a recording bound to the video (laid on the video's clock, then
// read through the clip's map) and a split edit's lead and tail. Each source
// is silence with one click at a known second; where the click lands in the
// exported file says which source second played at which timeline second.

const available = (cmd: string) => spawnSync(cmd, ["-version"], { stdio: "ignore" }).status === 0;
const tools = available("ffmpeg");
const RATE = 44100;

const ff = (args: string[]) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed:\n${r.stderr}`);
};

/** A click: 2 ms of a loud square at `at` seconds, silence elsewhere. */
const click = (at: number, secs: number) =>
  `aevalsrc=exprs='if(between(t\\,${at}\\,${at + 0.002})\\,0.9\\,0)':s=${RATE}:d=${secs}`;

let media = "";
let tmp = "";

beforeAll(async () => {
  if (!tools) return;
  media = await mkdtemp(path.join(os.tmpdir(), "cut-sound-media-"));
  tmp = await mkdtemp(path.join(os.tmpdir(), "cut-sound-job-"));
  const video = (name: string, audio: string, secs: number) =>
    ff([
      "-f", "lavfi", "-i", `testsrc2=size=160x120:rate=24:duration=${secs}`,
      "-f", "lavfi", "-i", audio,
      "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "pcm_s16le",
      path.join(media, name),
    ]);
  // The camera's own scratch track clicks at 2.5; the recording at 3.0 of
  // its own clock.
  video("cam.mov", click(2.5, 8), 8);
  ff(["-f", "lavfi", "-i", click(3, 8), "-c:a", "pcm_s16le", path.join(media, "rec.wav")]);
  video("quiet.mov", `anullsrc=r=${RATE}:cl=stereo:d=8`, 8);
  video("lead.mov", click(0.8, 8), 8);
  video("tail.mov", click(2.3, 8), 8);
});

afterAll(async () => {
  if (media) await rm(media, { recursive: true, force: true });
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Render `over` and return the timeline second of the first click, or null. */
const clickIn = async (over: Partial<ExportSpec> & Pick<ExportSpec, "clips" | "duration">, name: string) => {
  const spec: ExportSpec = {
    projectId: "sound",
    width: 160,
    height: 120,
    fps: 24,
    crf: 35,
    preset: "ultrafast",
    container: "mov",
    audioCodec: "pcm",
    audio: [],
    overlays: [],
    ...over,
  };
  const job: RenderHandle = { tmpDir: tmp, outPath: path.join(tmp, `${name}.mov`), progress: 0, log: [] };
  await runExport(job, spec, (file) => path.join(media, file));
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", job.outPath, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const buf = r.stdout as Buffer;
  const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > 0.3) return i / RATE;
  return null;
};

/** Every click in a rendered file, as the timeline second it starts on. */
const clicksOf = (file: string): number[] => {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const buf = r.stdout as Buffer;
  const data = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const at: number[] = [];
  let quietSince = 0;
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) <= 0.3) continue;
    if (i - quietSince > RATE * 0.1) at.push(i / RATE);
    quietSince = i;
  }
  return at;
};

const near = (got: number | null, want: number) => {
  expect(got).not.toBeNull();
  expect(Math.abs(got! - want)).toBeLessThan(0.005);
};

const bound = { file: "rec.wav", offset: -1, duration: 8 };

describe("a recording bound to the video, through ffmpeg", () => {
  test.skipIf(!tools)("plays the recording on the video's clock, and the camera's track stays out", async () => {
    // Recording 3.0 is video 4.0, which a clip from video 1 plays at 3.0.
    near(await clickIn({ duration: 4, clips: [{ file: "cam.mov", in: 1, out: 5, muted: false, soundFrom: bound }] }, "bound"), 3);
  });

  test.skipIf(!tools)("a reversed clip turns the recording with it", async () => {
    // Reversed over video 1..5, timeline t shows video 5 − t: video 4 at 1.
    near(
      await clickIn(
        { duration: 4, clips: [{ file: "cam.mov", in: 1, out: 5, muted: false, reverse: true, soundFrom: bound }] },
        "bound-reverse"
      ),
      1
    );
  });

  test.skipIf(!tools)("a soundtrack entry detached from the video plays the recording", async () => {
    near(
      await clickIn(
        {
          duration: 4,
          clips: [{ file: "quiet.mov", in: 0, out: 4, muted: true }],
          audio: [{ file: "cam.mov", in: 2, out: 5, start: 1, volume: 1, soundFrom: bound }],
        },
        "bound-audio"
      ),
      3
    );
  });

  test.skipIf(!tools)("a recording that holds nothing of the clip leaves it silent", async () => {
    expect(
      await clickIn(
        { duration: 1, clips: [{ file: "cam.mov", in: 0, out: 1, muted: false, soundFrom: { ...bound, offset: 20 } }] },
        "bound-gone"
      )
    ).toBeNull();
  });
});

describe("a mastered export with stems, through ffmpeg", () => {
  test.skipIf(!tools)("the dialogue stem carries the bound recording and the split edit, and the mix masters them", async () => {
    // Recording 3.0 is video 4.0, which the first clip (video 3..5) plays at
    // 1.0. The second clip starts at 2 on source 1; its lead plays source
    // 0.8 at 1.8. The soundtrack's click at 3.0 belongs to its own lane.
    const spec: ExportSpec = {
      projectId: "sound",
      width: 160,
      height: 120,
      fps: 24,
      crf: 35,
      preset: "ultrafast",
      container: "mov",
      audioCodec: "pcm",
      overlays: [],
      duration: 4,
      loudness: -16,
      truePeakCeiling: -1,
      clips: [
        { file: "cam.mov", in: 3, out: 5, muted: false, soundFrom: bound },
        { file: "lead.mov", in: 1, out: 3, muted: false, soundBack: 0.5, soundLead: 0.5, splitFade: 0.03 },
      ],
      audio: [{ file: "rec.wav", in: 0, out: 4, start: 0, volume: 1, lane: 0 }],
      stemPlan: [
        { name: "Dialogue", lane: null, file: "1 Dialogue.wav" },
        { name: "rec", lane: 0, file: "2 rec.wav" },
      ],
    };
    const job: RenderHandle = {
      tmpDir: tmp,
      outPath: path.join(tmp, "stems.mov"),
      stemsPath: path.join(tmp, "stems.zip"),
      progress: 0,
      log: [],
    };
    await runExport(job, spec, (file) => path.join(media, file));
    const unzipped = path.join(tmp, "stems");
    expect(spawnSync("unzip", ["-o", "-q", job.stemsPath!, "-d", unzipped]).status).toBe(0);

    const dialogue = clicksOf(path.join(unzipped, "1 Dialogue.wav"));
    expect(dialogue).toHaveLength(2);
    near(dialogue[0], 1);
    near(dialogue[1], 1.8);
    const lane = clicksOf(path.join(unzipped, "2 rec.wav"));
    expect(lane).toHaveLength(1);
    near(lane[0], 3);
    const mix = clicksOf(job.outPath);
    expect(mix).toHaveLength(3);
    [1, 1.8, 3].forEach((want, i) => near(mix[i], want));
  });
});

describe("split edits, through ffmpeg", () => {
  test.skipIf(!tools)("a J-cut plays the incoming clip's sound ahead of its picture", async () => {
    // The second clip starts at 2 on source 1; its lead plays source 0.8 at 1.8.
    near(
      await clickIn(
        {
          duration: 4,
          clips: [
            { file: "quiet.mov", in: 0, out: 2, muted: false },
            { file: "lead.mov", in: 1, out: 3, muted: false, soundBack: 0.5, soundLead: 0.5, splitFade: 0.03 },
          ],
        },
        "jcut"
      ),
      1.8
    );
  });

  test.skipIf(!tools)("an L-cut carries the outgoing clip's sound past its picture", async () => {
    near(
      await clickIn(
        {
          duration: 4,
          clips: [
            { file: "tail.mov", in: 0, out: 2, muted: false, soundAhead: 0.5, soundTail: 0.5, splitFade: 0.03 },
            { file: "quiet.mov", in: 0, out: 2, muted: false },
          ],
        },
        "lcut"
      ),
      2.3
    );
  });

  test.skipIf(!tools)("an upper-track clip's lead lands ahead of its start", async () => {
    near(
      await clickIn(
        {
          duration: 4,
          clips: [{ file: "quiet.mov", in: 0, out: 4, muted: true }],
          overlayVideos: [
            {
              file: "lead.mov", in: 1, out: 2, start: 2, track: 1, muted: false,
              soundBack: 0.5, soundLead: 0.5, splitFade: 0.03,
            },
          ],
        },
        "overlay-jcut"
      ),
      1.8
    );
  });

  test.skipIf(!tools)("without a split edit the trimmed-away sound stays out", async () => {
    expect(
      await clickIn(
        {
          duration: 4,
          clips: [
            { file: "tail.mov", in: 0, out: 2, muted: false },
            { file: "lead.mov", in: 1, out: 3, muted: false },
          ],
        },
        "plain"
      )
    ).toBeNull();
  });
});
