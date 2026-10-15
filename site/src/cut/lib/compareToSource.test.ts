import { beforeEach, expect, test } from "bun:test";
import { stubModule } from "@/lib/testing/stubModule";
import { setRasterFactory, type RasterSurface } from "./raster";
import { useEditor } from "./store";

// A surface that draws nothing but a flat grey level: this pins the shape of
// the reads and the result, and the pixels themselves are the render path's
// own tests. Every call the draw code makes answers; drawing one stub canvas
// onto another carries its level across, and reading pixels hands that level
// back, so a test can say what the source shows at each second and read the
// score it comes to.
type StubCanvas = { width: number; height: number; level: number; getContext: () => unknown };

const contextOf = (canvas: StubCanvas) =>
  new Proxy(
    {
      canvas,
      measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      drawImage: (src: { level?: number }) => {
        if (typeof src?.level === "number") canvas.level = src.level;
      },
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        const data = new Uint8ClampedArray(Math.max(1, w * h * 4));
        for (let i = 0; i < data.length; i += 4) data.set([canvas.level, canvas.level, canvas.level, 255], i);
        return { data, width: w, height: h };
      },
    } as Record<string, unknown>,
    {
      get: (target, prop) =>
        prop in target ? target[prop as string] : typeof prop === "string" ? () => undefined : undefined,
      set: (target, prop, value) => ((target[prop as string] = value), true),
    }
  );

const stubCanvas = (w: number, h: number, level = 0): RasterSurface => {
  const canvas: StubCanvas = { width: Math.max(1, w), height: Math.max(1, h), level, getContext: () => ctx };
  const ctx = contextOf(canvas);
  return canvas as unknown as RasterSurface;
};

setRasterFactory({
  createCanvas: stubCanvas,
  decodeImage: async () => ({ source: {} as CanvasImageSource, width: 90, height: 160 }),
  canvasToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
  snapshot: async (canvas) => canvas as unknown as ImageBitmap,
});

// Checking a replica against its source reads two pictures per moment, so what
// it accepts is worth pinning: the moments it is given, the ones it turns away
// before drawing anything, and the shape of the read it makes of the source.

/** Every time the source was asked for frames, and at what size. */
const reads: { times: number[]; size: unknown }[] = [];
/** The grey level the source shows at a second; the cut always draws 0. */
let sourceLevel: (t: number) => number = () => 0;
/** The source's own frame shape. */
let sourceShape = { w: 90, h: 160 };

async function* framesAt(_src: string | Blob, times: number[], size?: unknown) {
  reads.push({ times: [...times], size });
  for (const t of times) yield { canvas: stubCanvas(sourceShape.w, sourceShape.h, sourceLevel(t)), timestamp: t, duration: 0 } as never;
}

await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, { framesAt });

const { runAiTool } = await import("./aiTools");

beforeEach(() => {
  reads.length = 0;
  sourceLevel = () => 0;
  sourceShape = { w: 90, h: 160 };
  useEditor.setState({
    aspect: "9:16",
    background: "#000000",
    clips: [{ id: "c1", assetId: "block", track: 0, start: 0, in: 0, out: 10, muted: false }],
    overlays: [],
    transitions: [],
    audioClips: [],
    assets: [
      { id: "ref", fileName: "ref.mp4", name: "Reference", type: "video", duration: 33.17, url: "" },
      { id: "unread", fileName: "unread.mp4", name: "Still importing", type: "video", duration: 0, url: "" },
      { id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 33, url: "" },
      {
        id: "block",
        fileName: "",
        name: "Shot 1",
        type: "image",
        duration: 10,
        url: "",
        origin: "block",
        block: { label: "Shot 1", color: "#FF5A00" },
      },
    ],
  });
});

const message = async (p: Promise<unknown>) =>
  p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

test("a moment is required, because there is nothing to compare without one", async () => {
  expect(await message(runAiTool("compare_to_source", { asset_id: "ref", times: [] }))).toContain("Pass times");
});

test("more moments than one call reads are turned away with what to do instead", async () => {
  const error = await message(
    runAiTool("compare_to_source", { asset_id: "ref", times: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
  );
  expect(error).toContain("8 is the most one call reads");
});

test("a sound has no frame to hold up", async () => {
  expect(await message(runAiTool("compare_to_source", { asset_id: "song", times: [1] }))).toContain("listen_audio");
});

test("an unknown source says so before anything is drawn", async () => {
  expect(await message(runAiTool("compare_to_source", { asset_id: "nope", times: [1] }))).toContain("nope");
});

test("a source with no length yet is turned away, because every moment would clamp to 0", async () => {
  expect(await message(runAiTool("compare_to_source", { asset_id: "unread", times: [1, 8] }))).toContain("no length yet");
});

test("a comparison comes back as pictures, one per moment", async () => {
  const out = (await runAiTool("compare_to_source", {
    asset_id: "ref",
    times: [1, { at: 5, source: 20 }],
  })) as { images: string[]; checked: { at: number; source: number }[]; source: { sound: string } };
  expect(out.checked).toMatchObject([
    { at: 1, source: 1 },
    { at: 5, source: 20 },
  ]);
  expect(out.images).toHaveLength(2);
  for (const sheet of out.images) expect(sheet.startsWith("data:image/")).toBe(true);
  // The record every look returns, so a comparison does not erase what the
  // ear already knows about this source.
  expect(out.source.sound).toBeDefined();
});

test("the source is read in one pass, in play order, at a height that keeps its own shape", async () => {
  await runAiTool("compare_to_source", { asset_id: "ref", times: [{ at: 1, source: 20 }, { at: 5, source: 3 }] });
  expect(reads).toHaveLength(1);
  // Each moment brings the few frames either side of it, for the timing read.
  const times = reads[0].times;
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(times.includes(3) && times.includes(20)).toBe(true);
  expect(times.every((t) => Math.abs(t - 3) <= 0.101 || Math.abs(t - 20) <= 0.101)).toBe(true);
  // Both dimensions would squash a widescreen reference into a vertical cut's
  // frame — and mediabunny's sink refuses the pair outright.
  expect(Object.keys(reads[0].size as object)).toEqual(["height"]);
});

test("a cut built only from elements is checked at the moments asked for", async () => {
  // No track-0 clip: the cut's length is its elements' and its soundtrack's.
  useEditor.setState({ clips: [] });
  // A still element is drawn once and reused as a bitmap; the stub surface
  // has no pixels to hand over. Another file's stub may be installed already.
  const was = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async () => ({ width: 1, height: 1, close() {} })) as never;
  try {
    await runAiTool("add_shape", { shape: "rect", start: 0, end: 3, w: 1, h: 1, fill: "#C53CD4" });
    const frame = (await runAiTool("capture_frame", { t: 1.9 })) as { at: number };
    expect(frame.at).toBeCloseTo(1.9, 3);
    const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [2.5] })) as {
      checked: { at: number }[];
    };
    expect(out.checked[0].at).toBeCloseTo(2.5, 3);
  } finally {
    globalThis.createImageBitmap = was;
  }
});

type Checked = { at: number; source: number; diff: number; grid: number[][]; shift?: number; block?: string };

test("every moment comes back with a score and a grid of where it differs", async () => {
  sourceLevel = () => 40;
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1, 2] })) as { checked: Checked[] };
  expect(out.checked).toHaveLength(2);
  for (const c of out.checked) {
    expect(c.diff).toBe(40);
    expect(c.grid).toHaveLength(4);
    expect(c.grid.flat()).toEqual(Array(16).fill(40));
  }
});

test("eight moments fit in one call", async () => {
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1, 2, 3, 4, 5, 6, 7, 8] })) as {
    images: string[];
  };
  expect(out.images).toHaveLength(8);
});

test("a moment that matches a neighbouring source frame says how far to move it", async () => {
  // The source shows what the cut shows two frames after the moment asked for.
  sourceLevel = (t) => (Math.abs(t - (5 + 2 / 30)) < 0.005 ? 0 : 30);
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [5] })) as { checked: Checked[] };
  expect(out.checked[0].diff).toBe(30);
  expect(out.checked[0].shift).toBeCloseTo(0.067, 3);
});

test("a moment with no better neighbour names no shift", async () => {
  sourceLevel = () => 30;
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [5] })) as { checked: Checked[] };
  expect(out.checked[0].shift).toBeUndefined();
});

test("an offset maps every bare moment onto the source", async () => {
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1, { at: 2, source: 9 }], offset: 2 })) as {
    checked: Checked[];
  };
  expect(out.checked.map((c) => c.source)).toEqual([3, 9]);
});

test("a moment over a block says so, because a block stands in for footage", async () => {
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1] })) as { checked: Checked[] };
  expect(out.checked[0].block).toBe("Shot 1");
});

test("a source of another shape is scored letterboxed into the cut's frame, and says so", async () => {
  sourceShape = { w: 160, h: 90 };
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1] })) as { frame?: string };
  expect(out.frame).toContain("letterboxed");
});

test("a recording's picture box is what is held against the cut, read at the cut's size", async () => {
  // A 9:16 phone recording with a 16:9 picture across its middle, against a
  // 16:9 cut: the box is the cut's shape, so nothing is letterboxed.
  useEditor.setState({ aspect: "16:9" });
  useEditor.getState().updateAsset("ref", { picture: { x: 0.5, y: 0.5, w: 1, h: 0.3164 } });
  const out = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1] })) as {
    frame?: string;
    picture?: { h: number };
    pictureNote?: string;
  };
  expect(out.frame).toBeUndefined();
  expect(out.picture?.h).toBe(0.3164);
  expect(out.pictureNote).toContain("fraction");
  // The frame is read tall enough that its picture box is the cut's height.
  const height = (reads[0].size as { height: number }).height;
  expect(height * 0.3164).toBeCloseTo(270, -1);

  const sweep = (await runAiTool("compare_to_source", { asset_id: "ref", mode: "sweep", from: 0, to: 1, step: 0.5 })) as {
    frame?: string;
    picture?: unknown;
  };
  expect(sweep.frame).toBeUndefined();
  expect(sweep.picture).toBeDefined();

  // "full" scores the whole recorded frame, letterboxed.
  const whole = (await runAiTool("compare_to_source", { asset_id: "ref", times: [1], picture: "full" })) as { frame?: string };
  expect(whole.frame).toContain("letterboxed");
});

type Sweep = {
  images?: unknown;
  sampled: number;
  step: number;
  from: number;
  to: number;
  median: number;
  p95: number;
  max: number;
  worst: { from: number; to: number; diff: number; peak: number; at: number; grid: number[][]; block?: string }[];
  coveredTo?: number;
  source: { assetId: string };
};

test("a sweep scores the span at a step and hands back numbers, no pictures", async () => {
  const out = (await runAiTool("compare_to_source", {
    asset_id: "ref",
    mode: "sweep",
    from: 0,
    to: 2,
    step: 0.5,
  })) as Sweep;
  expect(out.images).toBeUndefined();
  expect(out.sampled).toBe(4);
  expect(reads).toHaveLength(1);
  expect(reads[0].times).toEqual([0, 0.5, 1, 1.5]);
  expect([out.median, out.p95, out.max]).toEqual([0, 0, 0]);
  expect(out.worst).toEqual([]);
  expect(out.source.assetId).toBe("ref");
});

test("a sweep reads the source at a constant offset and skips what falls outside it", async () => {
  const out = (await runAiTool("compare_to_source", {
    asset_id: "ref",
    mode: "sweep",
    from: 0,
    to: 2,
    step: 0.5,
    offset: 32,
  })) as Sweep;
  // The source runs to 33.17s, so only the first three samples land in it.
  expect(reads[0].times).toEqual([32, 32.5, 33]);
  expect(out.sampled).toBe(3);
});

test("a sweep points at the stretch that is off, with its grid and its block", async () => {
  sourceLevel = (t) => (t >= 1 && t < 2 ? 50 : 0);
  const out = (await runAiTool("compare_to_source", {
    asset_id: "ref",
    mode: "sweep",
    from: 0,
    to: 4,
    step: 0.5,
  })) as Sweep;
  expect(out.median).toBe(0);
  expect(out.max).toBe(50);
  expect(out.worst).toHaveLength(1);
  expect(out.worst[0]).toMatchObject({ from: 1, to: 2, diff: 50, peak: 50, block: "Shot 1" });
  expect(out.worst[0].grid.flat()).toEqual(Array(16).fill(50));
});

test("a sweep's step never drops under a frame and widens to fit the sample cap", async () => {
  const fine = (await runAiTool("compare_to_source", { asset_id: "ref", mode: "sweep", from: 0, to: 1, step: 0.001 })) as Sweep;
  expect(fine.step).toBeCloseTo(1 / 30, 3);
  expect(fine.sampled).toBe(30);
  const long = (await runAiTool("compare_to_source", { asset_id: "ref", mode: "sweep" })) as Sweep;
  expect(long.sampled).toBeLessThanOrEqual(900);
  expect(long.to).toBeCloseTo(10, 3);
});

test("a sweep that runs out of time says how far it reached", async () => {
  const was = performance.now;
  let calls = 0;
  performance.now = () => (calls++) * 20_000;
  try {
    const out = (await runAiTool("compare_to_source", { asset_id: "ref", mode: "sweep", from: 0, to: 4, step: 0.5 })) as Sweep;
    expect(out.sampled).toBeLessThan(8);
    expect(out.coveredTo).toBeLessThan(4);
  } finally {
    performance.now = was;
  }
});

test("a sweep with nothing inside the source is turned away", async () => {
  const error = await message(
    runAiTool("compare_to_source", { asset_id: "ref", mode: "sweep", from: 0, to: 2, offset: 40 })
  );
  expect(error).toContain("offset");
});
