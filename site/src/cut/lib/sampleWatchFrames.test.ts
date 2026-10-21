import { afterEach, expect, spyOn, test } from "bun:test";
import type { Input, InputVideoTrack, WrappedCanvas } from "mediabunny";
import { sampleWatchFrames, watchGeometry } from "./media";
import * as mediaRead from "./mediaRead";
import * as raster from "./raster";

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0)) restore(); });

function fixture(failPixels = false) {
  let closed = 0;
  let disposed = false;
  const asked: number[] = [];
  const context = {
    drawImage() {},
    getImageData(_x: number, _y: number, width: number, height: number) {
      if (failPixels) throw new Error("Frame read failed");
      return { data: new Uint8ClampedArray(width * height * 4) };
    },
  };
  const canvas = { getContext: () => context } as unknown as raster.RasterSurface;
  const frame = { canvas, timestamp: 0, duration: 0.5 } as WrappedCanvas;
  const input = { dispose() { disposed = true; } } as unknown as Input;
  const track = { getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 } as unknown as InputVideoTrack;
  const spies = [
    spyOn(mediaRead, "openMedia").mockReturnValue(input),
    spyOn(mediaRead, "videoTrackOf").mockResolvedValue(track),
    spyOn(raster, "createRasterCanvas").mockReturnValue(canvas),
    spyOn(mediaRead, "frameSink").mockReturnValue({
      getCanvas: async () => frame,
      async *canvases() { yield frame; },
      async *canvasesAtTimestamps(times) {
        try {
          for await (const time of times) {
            asked.push(time);
            yield { ...frame, timestamp: time };
          }
        } finally { closed++; }
      },
    }),
  ];
  restores.push(...spies.map((spy) => () => spy.mockRestore()));
  return { closed: () => closed, disposed: () => disposed, asked: () => asked };
}

test("pausing a scene scan closes its decoded-frame iterator", async () => {
  const run = fixture();
  let checks = 0;
  const result = await sampleWatchFrames("fixture.mp4", {
    from: 0, to: 5, interval: 0.5, metadataOnly: true, shouldPause: () => ++checks > 1,
  });
  expect(result.truncated).toBe(true);
  expect(result.candidates).toBe(1);
  expect(run.closed()).toBe(1);
  expect(run.disposed()).toBe(true);
});

test("a failed frame read closes the iterator and its input", async () => {
  const run = fixture(true);
  await expect(sampleWatchFrames("fixture.mp4", { from: 0, to: 5, metadataOnly: true })).rejects.toThrow("Frame read failed");
  expect(run.closed()).toBe(1);
  expect(run.disposed()).toBe(true);
});

test("a source's own lines aim the candidates", async () => {
  // What a video shows changes when what it says changes, so each cue start
  // earns its own decode on top of the steady sweep.
  const run = fixture();
  const result = await sampleWatchFrames("fixture.mp4", {
    from: 0, to: 10, interval: 2, metadataOnly: true,
    at: [1.2, 3.4, 3.45, 7.8],
  });
  // The floor (every 2s) with each line woven into it in order — and 3.45,
  // landing within a frame of 3.4, folded into the one decode.
  expect(run.asked()).toEqual([0, 1.2, 2, 3.4, 4, 6, 7.8, 8]);
  expect(result.candidates).toBe(8);
});

test("every shot detect_cuts measured gets a decode of its own, however short", async () => {
  // A strobe of flat cards a few frames each: the moments sit closer together
  // than two speech lines may, and each one is a card nothing else shows. A
  // floor sample that would crowd one of them gives way to it.
  const run = fixture();
  const shots = [1.5, 1.583, 1.633, 1.7, 1.767, 2.41];
  await sampleWatchFrames("fixture.mp4", {
    from: 0, to: 4, interval: 0.5, metadataOnly: true, shots,
  });
  const asked = run.asked();
  for (const t of shots) expect(asked.includes(Math.round(t * 100) / 100)).toBe(true);
  expect(asked.includes(2.5)).toBe(false);
  expect(asked.includes(3)).toBe(true);
});

test("a densely spoken source is aimed end to end", async () => {
  // More lines than the budget allows: they thin across the whole span. Taking
  // the first of them would aim the head and leave the tail sampled thinner
  // than the floor alone would have covered it.
  const run = fixture();
  const at = Array.from({ length: 300 }, (_, i) => i * 0.4);
  await sampleWatchFrames("fixture.mp4", {
    from: 0, to: 120, interval: 0.5, metadataOnly: true, at,
  });
  const asked = run.asked();
  expect(asked.length).toBeLessThanOrEqual(150);
  // The aiming reaches the last quarter, and the floor still reaches the end.
  const aimed = asked.filter((t) => Math.abs(t / 0.4 - Math.round(t / 0.4)) < 1e-6 && t % 1 !== 0);
  expect(Math.max(...aimed)).toBeGreaterThan(90);
  expect(Math.max(...asked)).toBeGreaterThan(115);
  // And every second still sits between two candidates at the floor's density.
  const gaps = asked.slice(1).map((t, i) => t - asked[i]);
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1.7);
});

test("the detail ladder trades frames for pixels", () => {
  // Coverage is many small cells; matching a look is a handful of big frames.
  // Every step is the same moments with more pixels spent on each.
  expect(watchGeometry("scan").maxFrames).toBe(36);
  expect(watchGeometry("read").maxFrames).toBe(16);
  expect(watchGeometry("original").maxFrames).toBe(6);
  expect(watchGeometry("scan").cell).toBeLessThan(watchGeometry("read").cell);
  expect(watchGeometry("read").cell).toBeLessThan(watchGeometry("original").cell);
  expect(watchGeometry().maxFrames).toBe(watchGeometry("scan").maxFrames);
});

test("the top of the ladder is bounded, and only it walks twice", () => {
  // Six frames of a 4K source would be several times the whole per-call media
  // budget, so the source's own pixels stop at a ceiling; a phone or 1080p
  // source sits under it and passes through untouched.
  expect(watchGeometry("original").cell).toBe(1920);
  expect(watchGeometry("original").rewalk).toBe(true);
  expect(watchGeometry("scan").rewalk).toBe(false);
  expect(watchGeometry("read").rewalk).toBe(false);
});

test("a hard cut is reported on the first frame of the new shot, to the millisecond", async () => {
  // A 60 fps source whose picture turns from black to white at frame 61
  // (1.0167s). The sweep only says the cut sits between two samples a second
  // apart; the reported time has to be the frame itself.
  const FPS = 60;
  const CUT_FRAME = 61;
  const shade = (t: number) => (Math.floor(t * FPS + 1e-6) >= CUT_FRAME ? 255 : 0);
  type Painted = { getContext: () => unknown; shade: number };
  const surface = (): Painted => {
    const own: Painted = {
      shade: 0,
      getContext: () => ({
        drawImage(src: Painted) { own.shade = src.shade; },
        getImageData(_x: number, _y: number, width: number, height: number) {
          return { data: new Uint8ClampedArray(width * height * 4).fill(own.shade) };
        },
      }),
    };
    return own;
  };
  const shot = (t: number) => {
    const canvas = surface();
    canvas.shade = shade(t);
    return { canvas, timestamp: Math.floor(t * FPS + 1e-6) / FPS, duration: 1 / FPS } as unknown as WrappedCanvas;
  };
  const input = { dispose() {} } as unknown as Input;
  const track = { getDisplayWidth: async () => 320, getDisplayHeight: async () => 180 } as unknown as InputVideoTrack;
  const spies = [
    spyOn(mediaRead, "openMedia").mockReturnValue(input),
    spyOn(mediaRead, "videoTrackOf").mockResolvedValue(track),
    spyOn(raster, "createRasterCanvas").mockImplementation(() => surface() as unknown as raster.RasterSurface),
    spyOn(mediaRead, "frameSink").mockReturnValue({
      getCanvas: async (t) => shot(t),
      async *canvases(start = 0, end = Infinity) {
        for (let f = Math.floor(start * FPS + 1e-6); f / FPS < end; f++) yield shot(f / FPS);
      },
      async *canvasesAtTimestamps(times) {
        for await (const t of times) yield shot(t);
      },
    }),
  ];
  restores.push(...spies.map((spy) => () => spy.mockRestore()));
  const result = await sampleWatchFrames("fixture.mp4", { from: 0, to: 3, interval: 1, metadataOnly: true });
  expect(result.sceneChanges).toEqual([1.017]);
});
