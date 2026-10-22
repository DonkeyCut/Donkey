import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { Input, InputVideoTrack, WrappedCanvas } from "mediabunny";
import * as mediaRead from "./mediaRead";
import { useEditor } from "./store";

// The measuring tools read a source the way the other senses do — through the
// frame sink — so a synthetic 60 fps video stands in for the file: every
// frame's pixels are painted from its index, and each tool's numbers are
// checked against what was painted.

const FPS = 60;
const FRAMES = 180; // 3 s
const W = 1080;
const H = 1920;

type Rgb = [number, number, number];
const RED: Rgb = [200, 30, 30];
const BLUE: Rgb = [30, 30, 200];
const GREEN: Rgb = [30, 160, 60];
const ORANGE: Rgb = [255, 90, 0];
const WHITE: Rgb = [255, 255, 255];

/** The picture at frame f, as a colour at each frame fraction. Red until 1s,
 * a five-frame blue shot, then green. On the green, an orange bar centred at
 * (0.5, 0.3), 0.1 tall, grows linearly from 0.1 to 0.5 wide over 1.5–2.0s; a
 * white "title" block spans x 0.2–0.8, y 0.7–0.75. */
function colourAt(f: number, fx: number, fy: number): Rgb {
  if (f < 60) return RED;
  if (f < 65) return BLUE;
  const t = f / FPS;
  const p = Math.max(0, Math.min(1, (t - 1.5) / 0.5));
  const bw = 0.1 + 0.4 * p;
  if (Math.abs(fx - 0.5) <= bw / 2 && Math.abs(fy - 0.3) <= 0.05) return ORANGE;
  if (fx >= 0.2 && fx < 0.8 && fy >= 0.7 && fy < 0.75) return WHITE;
  return GREEN;
}

function frameCanvas(f: number, w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) data.set([...colourAt(f, (x + 0.5) / w, (y + 0.5) / h), 255], (y * w + x) * 4);
  const ctx = { getImageData: () => ({ data, width: w, height: h }), drawImage() {}, putImageData() {} };
  return { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const wrap = (f: number, w: number, h: number) =>
  ({ canvas: frameCanvas(f, w, h), timestamp: f / FPS, duration: 1 / FPS }) as WrappedCanvas;
const frameShownAt = (t: number) => Math.max(0, Math.min(FRAMES - 1, Math.floor(t * FPS + 1e-6)));

const decoded: number[] = [];
const input = { dispose() {} } as unknown as Input;
const track = {
  getDisplayWidth: async () => W,
  getDisplayHeight: async () => H,
  getFirstTimestamp: async () => 0,
  displayWidth: W,
  displayHeight: H,
} as unknown as InputVideoTrack;
const spies = [
  spyOn(mediaRead, "openMedia").mockReturnValue(input),
  spyOn(mediaRead, "videoTrackOf").mockResolvedValue(track),
  spyOn(mediaRead, "frameSink").mockImplementation((_track, size) => {
    const w = size?.width ?? W;
    const h = size?.height ?? H;
    return {
      getCanvas: async (t: number) => wrap(frameShownAt(t), w, h),
      async *canvases(start = 0, end = Infinity) {
        for (let f = frameShownAt(start); f < FRAMES && f / FPS < end; f++) {
          decoded.push(f);
          yield wrap(f, w, h);
        }
      },
      async *canvasesAtTimestamps(times: Iterable<number> | AsyncIterable<number>) {
        for await (const t of times) yield wrap(frameShownAt(t), w, h);
      },
    };
  }),
];
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

const { runAiTool } = await import("./aiTools");

beforeEach(() => {
  decoded.length = 0;
  useEditor.setState({
    assets: [
      { id: "ref", fileName: "ref.mp4", name: "Reference", type: "video", duration: FRAMES / FPS, url: "fixture.mp4", width: W, height: H },
      { id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 30, url: "" },
    ],
  });
});

const message = async (p: Promise<unknown>) =>
  p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

test("detect_cuts finds every hard cut to the frame, a five-frame shot included", async () => {
  const out = (await runAiTool("detect_cuts", { asset_id: "ref" })) as {
    fps: number;
    cuts: { t: number; frame: number; change: number }[];
    shots: { from: number; to: number; frames: number }[];
    coveredTo: number;
    truncated: boolean;
  };
  expect(out.fps).toBe(60);
  expect(out.cuts.map((c) => [c.t, c.frame])).toEqual([
    [1, 60],
    [1.083, 65],
  ]);
  expect(out.cuts[0].change).toBe(100);
  expect(out.shots.map((s) => s.frames)).toEqual([60, 5, 115]);
  expect(out.truncated).toBe(false);
  // Every frame of the span was looked at.
  expect(decoded).toHaveLength(FRAMES);
});

test("detect_cuts says when its first read of a source kept the picture box", async () => {
  const first = (await runAiTool("detect_cuts", { asset_id: "ref", from: 1.05, to: 2 })) as { pictureKept?: true };
  expect(first.pictureKept).toBe(true);
  const again = (await runAiTool("detect_cuts", { asset_id: "ref", from: 1.05, to: 2 })) as { pictureKept?: true };
  expect(again.pictureKept).toBeUndefined();
});

test("detect_cuts scans only the span asked for, and a sound has no cuts", async () => {
  const out = (await runAiTool("detect_cuts", { asset_id: "ref", from: 1.05, to: 2 })) as { cuts: { t: number }[] };
  expect(out.cuts.map((c) => c.t)).toEqual([1.083]);
  expect(await message(runAiTool("detect_cuts", { asset_id: "song" }))).toContain("listen_audio");
});

test("sample_color reads a point and a region at their own moments", async () => {
  const out = (await runAiTool("sample_color", {
    asset_id: "ref",
    samples: [
      { t: 0.5, x: 0.5, y: 0.5 },
      { t: 1.03, x: 0.5, y: 0.5 },
      // The bar at full width, over its own box and a strip of green each side.
      { t: 2.5, x: 0.5, y: 0.3, w: 0.6, h: 0.1 },
    ],
    colors: 2,
  })) as { samples: { t: number; hex: string; spread: number; dominant?: { hex: string; share: number }[] }[] };
  expect(out.samples.map((s) => s.hex)).toEqual(["#C81E1E", "#1E1EC8", "#FF5A00"]);
  expect(out.samples[0].spread).toBe(0);
  const bar = out.samples[2].dominant!;
  expect(bar[0].hex).toBe("#FF5A00");
  expect(bar[0].share).toBeCloseTo(0.83, 1);
  expect(bar[1].hex).toBe("#1EA03C");
});

test("sample_color turns away a call with nothing to read", async () => {
  expect(await message(runAiTool("sample_color", { asset_id: "ref", samples: [] }))).toContain("samples");
});

test("track_element follows a growing bar and names its ease", async () => {
  const out = (await runAiTool("track_element", {
    asset_id: "ref",
    from: 1.3,
    to: 2.3,
    seed: { x: 0.5, y: 0.3, w: 0.08, h: 0.08 },
  })) as {
    color: string;
    path: { t: number; x: number; y: number; w: number; h: number }[];
    moves: { prop: string; from: number; to: number; start: number; end: number; ease: string; error: number }[];
  };
  expect(out.color).toBe("#FF5A00");
  expect(out.path[0].w).toBeCloseTo(0.1, 2);
  expect(out.path[out.path.length - 1].w).toBeCloseTo(0.5, 2);
  expect(out.path[0].y).toBeCloseTo(0.3, 2);
  const grow = out.moves.find((m) => m.prop === "w")!;
  expect(grow.ease).toBe("linear");
  expect(grow.from).toBeCloseTo(1.5, 1);
  expect(grow.to).toBeCloseTo(2.0, 1);
  expect(grow.start).toBeCloseTo(0.1, 2);
  expect(grow.end).toBeCloseTo(0.5, 2);
  // The bar grows about its centre: its position never moves.
  expect(out.moves.find((m) => m.prop === "x")).toBeUndefined();
});

test("track_camera reads a held shot as one picture that never moves", async () => {
  const out = (await runAiTool("track_camera", { asset_id: "ref", from: 1.1, to: 1.4 })) as {
    still: boolean;
    path: { t: number; scale: number; dx: number; dy: number; rotation: number }[];
    moves: unknown[];
  };
  expect(out.still).toBe(true);
  expect(out.path.length).toBeGreaterThan(10);
  for (const p of out.path) expect([p.scale, p.dx, p.dy, p.rotation]).toEqual([1, 0, 0, 0]);
  expect(out.moves).toEqual([]);
});

test("track_camera from a cut detect_cuts gave starts on that shot's first frame", async () => {
  // The cut lands on frame 65 (1.0833 s); detect_cuts hands it back to the
  // millisecond, which can sit either side of the frame's own start.
  for (const from of [1.083, 1.084]) {
    const out = (await runAiTool("track_camera", { asset_id: "ref", from, to: 1.3 })) as { path: { t: number }[] };
    expect(out.path[0].t).toBeCloseTo(65 / FPS, 3);
  }
});

test("track_camera needs the stretch's end", async () => {
  expect(await message(runAiTool("track_camera", { asset_id: "ref", from: 1.1 }))).toContain("to");
});

test("track_element's ink box measures a title at one moment", async () => {
  const out = (await runAiTool("track_element", {
    asset_id: "ref",
    from: 2.5,
    match: "ink",
    color: "#FFFFFF",
    seed: { x: 0.5, y: 0.725, w: 0.9, h: 0.15 },
  })) as { path: { x: number; y: number; w: number; h: number }[] };
  expect(out.path).toHaveLength(1);
  const [box] = out.path;
  expect(box.x).toBeCloseTo(0.5, 2);
  expect(box.y).toBeCloseTo(0.725, 2);
  expect(box.w).toBeCloseTo(0.6, 2);
  expect(box.h).toBeCloseTo(0.05, 2);
});

test("detect_cuts says a pass ended at its span bound short of the source", async () => {
  // A long source: one pass covers DETECT_CUTS_SPAN_MAX seconds and hands
  // back where the next one starts.
  const { DETECT_CUTS_SPAN_MAX } = await import("./measure/limits");
  useEditor.setState({
    assets: [{ id: "long", fileName: "long.mp4", name: "Long", type: "video", duration: 500, url: "fixture.mp4", width: W, height: H }],
  });
  const out = (await runAiTool("detect_cuts", { asset_id: "long" })) as { truncated: boolean; note: string };
  expect(out.truncated).toBe(true);
  expect(out.note).toContain("call again");
  expect(DETECT_CUTS_SPAN_MAX).toBeLessThan(500);
});
