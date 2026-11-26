import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerBlobFile } from "./backend/browser/registry";
import { ClipReader } from "./exportRender";
import { setFrameSinkFactory } from "./mediaRead";
import type { MediaAsset } from "./types";

const CLIP = join(dirname(fileURLToPath(import.meta.url)), "../../../public/cut-starter/media/recap-01-6a6c904b.mp4");
const url = registerBlobFile("test/clip-reader-walk.mp4", new File([readFileSync(CLIP)], "clip.mp4", { type: "video/mp4" }));

const FPS = 30;
const SOURCE_FRAMES = 10 * FPS;
const frameAt = (i: number) => ({ canvas: { i, width: 4, height: 4 }, timestamp: i / FPS, duration: 1 / FPS });
const indexAt = (t: number) => Math.floor(t * FPS + 1e-6);

/** A sink over a 30 fps source that counts how it is read: point reads, and
 * the streams started and the frames they decode. Each canvas carries the
 * index of its frame. */
function countingSink() {
  const reads = { points: 0, streams: 0, decoded: 0 };
  setFrameSinkFactory(() => ({
    getCanvas: async (t: number) => {
      reads.points++;
      return frameAt(indexAt(t)) as never;
    },
    canvases: async function* (start = 0) {
      reads.streams++;
      for (let i = indexAt(start); i < SOURCE_FRAMES; i++) {
        reads.decoded++;
        yield frameAt(i) as never;
      }
    },
    canvasesAtTimestamps: async function* () {},
  }));
  return reads;
}

const asset: MediaAsset = { id: "walk", fileName: "clip.mp4", name: "clip", type: "video", duration: 10, url };

/** The source frame index a read handed back. */
async function shownAt(reader: ClipReader, t: number): Promise<number> {
  const frame = await reader.frameAt(t);
  return frame.kind === "ready" ? (frame.image as unknown as { i: number }).i : -1;
}

afterAll(() => setFrameSinkFactory(null));

describe("a render's clip reader", () => {
  test("walks its source once, decoding each frame a single time", async () => {
    const reads = countingSink();
    const reader = new ClipReader(asset, () => url);
    const shown: number[] = [];
    for (let i = 0; i < 90; i++) {
      shown.push(await shownAt(reader, i / FPS));
    }
    reader.dispose();

    expect(shown).toEqual(Array.from({ length: 90 }, (_, i) => i));
    expect(reads.points).toBe(0);
    expect(reads.streams).toBe(1);
    // The 90 frames handed out, plus the one read ahead to see where the last ends.
    expect(reads.decoded).toBe(91);
  });

  test("hands back the frame covering each ask at another output rate", async () => {
    countingSink();
    const reader = new ClipReader(asset, () => url);
    const shown: number[] = [];
    for (let i = 0; i < 48; i++) {
      shown.push(await shownAt(reader, i / 24));
    }
    reader.dispose();

    expect(shown).toEqual(Array.from({ length: 48 }, (_, i) => indexAt(i / 24)));
  });

  test("a step back and the walk after it land on their own frames", async () => {
    countingSink();
    const reader = new ClipReader(asset, () => url);
    for (let i = 0; i < 30; i++) {
      await shownAt(reader, i / FPS);
    }

    expect(await shownAt(reader, 10 / FPS)).toBe(10);
    expect(await shownAt(reader, 40 / FPS)).toBe(40);
    expect(await shownAt(reader, 41 / FPS)).toBe(41);
    reader.dispose();
  });

  test("an ask past the source's end holds its last frame", async () => {
    countingSink();
    const reader = new ClipReader(asset, () => url);
    expect(await shownAt(reader, 9.9)).toBe(297);
    expect(await shownAt(reader, 12)).toBe(SOURCE_FRAMES - 1);
    reader.dispose();
  });
});
