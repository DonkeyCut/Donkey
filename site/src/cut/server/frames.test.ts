import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeFreezeFrame } from "./frames";
import { mediaDir } from "./projects";

// A freeze frame is baked by the ffmpeg the editor ships: the LGPL build,
// which has no libx264, so the still has to encode with what that build has.

const VENDOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../vendor/donkey-tools");
const PROJECT = "freeze-test";
let data = "";
let pathBefore: string | undefined;
let dataBefore: string | undefined;

beforeAll(async () => {
  data = await mkdtemp(path.join(os.tmpdir(), "cut-freeze-"));
  dataBefore = process.env.DONKEY_CUT_DATA_DIR;
  pathBefore = process.env.PATH;
  process.env.DONKEY_CUT_DATA_DIR = data;
  process.env.PATH = `${VENDOR}:${pathBefore}`;
  await mkdir(mediaDir(PROJECT), { recursive: true });
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x336699:s=64x36", "-frames:v", "1", path.join(mediaDir(PROJECT), "src.png")]);
  if (made.status !== 0) throw new Error(String(made.stderr));
});

afterAll(async () => {
  process.env.PATH = pathBefore;
  if (dataBefore === undefined) delete process.env.DONKEY_CUT_DATA_DIR;
  else process.env.DONKEY_CUT_DATA_DIR = dataBefore;
  await rm(data, { recursive: true, force: true });
});

test("a freeze frame bakes with the shipped ffmpeg", async () => {
  const still = await makeFreezeFrame(PROJECT, "src.png", 0, 1, { w: 128, h: 72 }, { fit: "fill", panX: 0, panY: 0 });
  expect(still).toMatchObject({ duration: 1, width: 128, height: 72 });
  expect((await stat(path.join(mediaDir(PROJECT), still.fileName))).size).toBeGreaterThan(0);
});
