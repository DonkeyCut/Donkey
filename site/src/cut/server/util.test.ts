import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { audioChannels, audioStreamIndex } from "./util";

// A phone recording with spatial sound carries two audio tracks: the spatial
// one first, in a codec ffmpeg has no decoder for, and a plain AAC one after
// it. The fixture is that shape: an AAC track whose sample entry is renamed
// to a codec ffmpeg does not know, then a mono AAC track.

const tools = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

let dir = "";
let plain = "";
let spatial = "";

beforeAll(async () => {
  if (!tools) {
    return;
  }
  dir = await mkdtemp(path.join(os.tmpdir(), "cut-util-"));
  plain = path.join(dir, "plain.mov");
  spatial = path.join(dir, "spatial.mov");
  const made = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=1",
    "-f", "lavfi", "-i", "sine=d=1",
    "-f", "lavfi", "-i", "sine=f=880:d=1",
    "-map", "0", "-map", "1", "-map", "2",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
    "-c:a", "aac", "-ac:a:0", "2", "-ac:a:1", "1",
    plain,
  ], { encoding: "utf8" });
  if (made.status !== 0) {
    throw new Error(made.stderr);
  }

  // Rename the first track's sample entry and its decoder config, so the
  // demuxer reads a codec it has no name for.
  const bytes = Buffer.from(await readFile(plain));
  const entry = bytes.indexOf("mp4a");
  bytes.write("apac", entry, "latin1");
  bytes.write("xsds", bytes.indexOf("esds", entry), "latin1");
  await writeFile(spatial, bytes);
});

afterAll(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("the audio stream ffmpeg reads", () => {
  test.skipIf(!tools)("is the first one when it decodes", async () => {
    expect(await audioStreamIndex(plain)).toBe(0);
    expect(await audioChannels(plain)).toBe(2);
  });

  test.skipIf(!tools)("skips a track this ffmpeg cannot decode", async () => {
    expect(await audioStreamIndex(spatial)).toBe(1);
    expect(await audioChannels(spatial)).toBe(1);
  });
});
