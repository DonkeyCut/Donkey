import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { playableMedia } from "./urlDownload";

// What a link import lands has to play on every surface it reaches: the
// phone's viewer and the Mac's player go through AVFoundation, which decodes
// H.264 and nothing like VP9 or AV1. This hands the gate real files in the
// codecs those sites actually serve and checks what comes out the other side.

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
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt", "-of", "json", file],
    { encoding: "utf8" }
  );
  const streams = (JSON.parse(r.stdout).streams ?? []) as {
    codec_type?: string;
    codec_name?: string;
    pix_fmt?: string;
  }[];
  return {
    audio: streams.find((s) => s.codec_type === "audio")?.codec_name,
    pixFmt: streams.find((s) => s.codec_type === "video")?.pix_fmt,
    video: streams.find((s) => s.codec_type === "video")?.codec_name,
  };
};

const source = (dir: string, name: string, encode: string[]) => {
  const file = path.join(dir, name);
  ff([
    "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    ...encode,
    file,
  ]);
  return file;
};

// Without ffmpeg on the box there is nothing to hand the gate, so the suite
// stands down.
const suite = tools ? describe : (() => {});

suite("playableMedia", () => {
  test("an H.264 mp4 is handed back untouched", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cut-play-"));
    try {
      const file = source(dir, "h264.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
      expect(await playableMedia(file)).toBe(file);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a VP9 mp4 comes back as H.264", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cut-play-"));
    try {
      const file = source(dir, "vp9.mp4", [
        "-c:v", "libvpx-vp9", "-b:v", "200k", "-pix_fmt", "yuv420p", "-c:a", "aac",
      ]);
      expect(probe(file).video).toBe("vp9");
      const out = await playableMedia(file);
      expect(out).not.toBe(file);
      expect(probe(out)).toEqual({ audio: "aac", pixFmt: "yuv420p", video: "h264" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 120_000);

  test("HEVC picture and Opus sound both come back playable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cut-play-"));
    try {
      const file = source(dir, "hevc.mp4", [
        "-c:v", "libx265", "-tag:v", "hvc1", "-pix_fmt", "yuv420p", "-c:a", "libopus",
      ]);
      const out = await playableMedia(file);
      expect(probe(out)).toEqual({ audio: "aac", pixFmt: "yuv420p", video: "h264" });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }, 120_000);

  test("sound with no picture is left alone", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cut-play-"));
    try {
      const file = path.join(dir, "audio.m4a");
      ff(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", file]);
      expect(await playableMedia(file)).toBe(file);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
