import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertToMp4, selectConversionStreams, streamCodecs } from "./convert";
import { audioTrackOf, openMedia } from "@/cut/lib/mediaRead";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "cut-convert-test-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { timeout: 30_000 });
const handle = (out: string) => ({ tmpDir: dir, outPath: out, progress: 0, log: [] as string[] });

describe("import conversion", () => {
  test("selects stereo AAC when an unsupported spatial track comes first", () => {
    expect(selectConversionStreams([
      { index: 0, codec_type: "video", codec_name: "hevc" },
      { index: 1, codec_type: "audio", codec_tag_string: "apac", disposition: { default: 1 } },
      { index: 2, codec_type: "audio", codec_name: "aac", codec_tag_string: "mp4a" },
    ])).toMatchObject({ video: "hevc", audio: "aac", audioIndex: 2, remux: true });
  });

  test("a file with only unsupported sound fails explicitly", () => {
    expect(() => selectConversionStreams([
      { index: 0, codec_type: "video", codec_name: "hevc" },
      { index: 1, codec_type: "audio", codec_tag_string: "apac" },
    ])).toThrow("no supported audio track");
  });

  test("converts HEVC video and PCM audio to playable H.264/AAC", async () => {
    const src = path.join(dir, "phone.mov");
    const out = path.join(dir, "phone.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=0.3", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
      "-c:v", "libx265", "-x265-params", "log-level=error:pools=1", "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1", "-c:a", "pcm_s16le", "-shortest", src]);
    const before = await readFile(src);
    expect(await convertToMp4(handle(out), src, out)).toMatchObject({ transcodedVideo: true, transcodedAudio: true, width: 64, height: 64 });
    expect(await streamCodecs(out)).toMatchObject({ video: "h264", audio: "aac", videoNeedsEncoding: false });
    expect(await readFile(src)).toEqual(before);
  }, 30_000);

  test("remuxes a MOV with an unknown first audio track using its second AAC track", async () => {
    const src = path.join(dir, "spatial.mov");
    const out = path.join(dir, "stereo.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=s=64x64:r=10:d=0.3", "-f", "lavfi", "-i", "sine=duration=0.3",
      "-map", "0:v", "-map", "1:a", "-map", "1:a", "-c:v", "libx264", "-c:a", "aac", "-shortest", src]);
    const bytes = await readFile(src);
    const audioEntry = bytes.indexOf(Buffer.from("mp4a"));
    expect(audioEntry).toBeGreaterThan(0);
    bytes.write("apac", audioEntry, "ascii");
    await writeFile(src, bytes);
    const input = openMedia(new Blob([bytes]));
    try {
      expect((await audioTrackOf(input))?.codec).toBe("aac");
    } finally { input.dispose(); }
    expect(await streamCodecs(src)).toMatchObject({ audio: "aac", audioIndex: 2, remux: true });
    expect(await convertToMp4(handle(out), src, out)).toMatchObject({ transcodedVideo: false, transcodedAudio: false });
    expect(await streamCodecs(out)).toMatchObject({ audio: "aac", remux: false });
  }, 30_000);

  test("already playable MP4 stays unchanged", async () => {
    const src = path.join(dir, "ready.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=s=64x64:r=10:d=0.2", "-c:v", "libx264", src]);
    expect(await convertToMp4(handle(path.join(dir, "unused.mp4")), src, path.join(dir, "unused.mp4"))).toMatchObject({ unchanged: true });
  });

  test("audio-only phone media becomes playable AAC without a video stream", async () => {
    const src = path.join(dir, "recording.mov");
    const out = path.join(dir, "recording.m4a");
    ffmpeg(["-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "pcm_s16le", src]);
    expect(await convertToMp4(handle(out), src, out)).toMatchObject({ transcodedVideo: false, transcodedAudio: true });
    expect(await streamCodecs(out)).toMatchObject({ video: undefined, audio: "aac" });
  });
});
