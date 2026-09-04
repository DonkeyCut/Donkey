import { describe, expect, test } from "bun:test";
import { bakeTurnedMedia, turnChunkSeconds, TURN_CHUNK_S, type TurnIO, type TurnSpec } from "./turnMedia";

const FOURK30 = 3840 * 2160 * 1.5 * 30;

/** A bake that records its runs and hands back however much of the span the
 * source actually had. `capped` cuts the file off at that source second. */
const fakeIO = (capped = Infinity) => {
  const runs: string[][] = [];
  let made = 0;
  const io: TurnIO = {
    ffmpeg: async (args) => {
      runs.push(args);
      const at = args.indexOf("-ss");
      const len = args.indexOf("-t");
      if (at < 0 || len < 0) return;
      const from = Number(args[at + 1]);
      made += Math.max(0, Math.min(from + Number(args[len + 1]), capped) - from);
    },
    writeFile: async () => {},
    h264Encoder: async () => "libx264",
    duration: async () => made,
  };
  return { io, runs, chunks: () => runs.filter((a) => a.includes("-ss")) };
};

const spec = (over: Partial<TurnSpec> = {}): TurnSpec => ({
  lo: 0,
  hi: 6,
  video: true,
  audio: true,
  colorFix: "",
  ...over,
});

describe("turnChunkSeconds", () => {
  test("footage nothing is known about gets the plain ceiling", () => {
    expect(turnChunkSeconds()).toBe(TURN_CHUNK_S);
    expect(turnChunkSeconds(0)).toBe(TURN_CHUNK_S);
  });

  test("light footage gets the ceiling, heavy footage gets less", () => {
    expect(turnChunkSeconds(1280 * 720 * 1.5 * 30)).toBe(TURN_CHUNK_S);
    const fourK = turnChunkSeconds(FOURK30);
    expect(fourK).toBeLessThan(TURN_CHUNK_S);
    // Whatever the ceiling is, one chunk of 4K30 stays inside half a gigabyte.
    expect(fourK * FOURK30).toBeLessThan(512 * 1024 * 1024);
    // And 4K60 costs twice as much a second, so it gets half as long a chunk.
    expect(turnChunkSeconds(FOURK30 * 2)).toBeCloseTo(fourK / 2, 6);
  });

  test("even the heaviest source keeps a chunk long enough to encode", () => {
    expect(turnChunkSeconds(7680 * 4320 * 1.5 * 120)).toBeGreaterThanOrEqual(0.2);
  });
});

describe("bakeTurnedMedia", () => {
  test("a heavy source is cut into more, shorter chunks", async () => {
    const light = fakeIO();
    await bakeTurnedMedia(light.io, "/s.mov", spec(), "/out.mov");
    const heavy = fakeIO();
    await bakeTurnedMedia(heavy.io, "/s.mov", spec({ decodeCost: FOURK30 }), "/out.mov");
    expect(heavy.chunks().length).toBeGreaterThan(light.chunks().length);
  });

  test("sound alone is not cut by the picture's weight", async () => {
    const { io, chunks } = fakeIO();
    await bakeTurnedMedia(io, "/s.wav", spec({ video: false, decodeCost: FOURK30 }), "/out.wav");
    expect(chunks().length).toBe(2);
  });

  test("chunks run from the span's end back to its start", async () => {
    const { io, chunks } = fakeIO();
    await bakeTurnedMedia(io, "/s.mov", spec({ lo: 1, hi: 7 }), "/out.mov");
    const starts = chunks().map((a) => Number(a[a.indexOf("-ss") + 1]));
    expect(starts).toEqual([4, 1]);
  });

  test("a whole span pivots on the second it was asked for", async () => {
    const { io } = fakeIO();
    expect(await bakeTurnedMedia(io, "/s.mov", spec({ lo: 2, hi: 8 }), "/out.mov")).toBeCloseTo(8, 6);
  });

  test("a span reaching past the source's end pivots on what came back", async () => {
    // Asked for source [2, 8] of a file that stops at 5.
    const { io } = fakeIO(5);
    expect(await bakeTurnedMedia(io, "/s.mov", spec({ lo: 2, hi: 8 }), "/out.mov")).toBeCloseTo(5, 6);
  });

  test("a file it cannot read back is an error", async () => {
    const { io } = fakeIO();
    io.duration = async () => null;
    let thrown: unknown;
    await bakeTurnedMedia(io, "/s.mov", spec(), "/out.mov").catch((e) => (thrown = e));
    expect(String(thrown).includes("read back")).toBe(true);
  });
});
