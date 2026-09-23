import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { download, playableMedia } from "./urlDownload";

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

const downloadTools = tools && spawnSync("yt-dlp", ["--version"], { stdio: "ignore" }).status === 0;

test.skipIf(!downloadTools)("imports media from a signed attachment URL with a long query", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cut-attachment-"));
  const file = source(dir, "fixture.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]);
  const bytes = await readFile(file);
  const signature = "a".repeat(600);
  const server = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname !== "/raw" || url.searchParams.get("sig") !== signature) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": bytes.length });
    response.end(request.method === "HEAD" ? undefined : bytes);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const url = `http://127.0.0.1:${address.port}/raw?sig=${signature}`;
    const result = await download(url, dir);
    expect(result.files).toHaveLength(1);
    const landed = result.files[0].file;
    expect(Buffer.byteLength(path.basename(landed))).toBeLessThan(100);
    expect(path.basename(landed)).not.toContain("sig");
    expect(await readFile(landed)).toEqual(bytes);
    expect(probe(landed).video).toBe("h264");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { force: true, recursive: true });
  }
}, 60_000);

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
