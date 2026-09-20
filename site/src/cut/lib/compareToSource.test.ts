import { beforeEach, expect, mock, test } from "bun:test";
import { setRasterFactory, type RasterSurface } from "./raster";
import { useEditor } from "./store";

// A surface that records nothing and draws nothing: this pins the shape of the
// reads and the result, and the pixels themselves are the render path's own
// tests. Every call the draw code makes answers.
const stubContext = new Proxy(
  {
    canvas: null as unknown,
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
      width: w,
      height: h,
    }),
  } as Record<string, unknown>,
  {
    get: (target, prop) =>
      prop in target ? target[prop as string] : typeof prop === "string" ? () => undefined : undefined,
    set: (target, prop, value) => ((target[prop as string] = value), true),
  }
);

const stubCanvas = (w: number, h: number): RasterSurface =>
  ({ width: Math.max(1, w), height: Math.max(1, h), getContext: () => stubContext }) as unknown as RasterSurface;

setRasterFactory({
  createCanvas: stubCanvas,
  decodeImage: async () => ({ source: {} as CanvasImageSource, width: 90, height: 160 }),
  canvasToBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
});

// Checking a replica against its source reads two pictures per moment, so what
// it accepts is worth pinning: the moments it is given, the ones it turns away
// before drawing anything, and the shape of the read it makes of the source.

const media = await import("./mediaRead");

/** Every time the source was asked for frames, and at what size. */
const reads: { times: number[]; size: unknown }[] = [];

async function* framesAt(_src: string | Blob, times: number[], size?: unknown) {
  reads.push({ times: [...times], size });
  for (let i = 0; i < times.length; i++) yield { canvas: stubCanvas(90, 160), timestamp: 0, duration: 0 } as never;
}

mock.module("./mediaRead", () => ({ ...media, framesAt }));

const { runAiTool } = await import("./aiTools");

beforeEach(() => {
  reads.length = 0;
  useEditor.setState({
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
    runAiTool("compare_to_source", { asset_id: "ref", times: [1, 2, 3, 4, 5] })
  );
  expect(error).toContain("4 is the most one call reads");
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
  expect(out.checked).toEqual([
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
  expect(reads[0].times).toEqual([3, 20]);
  // Both dimensions would squash a widescreen reference into a vertical cut's
  // frame — and mediabunny's sink refuses the pair outright.
  expect(Object.keys(reads[0].size as object)).toEqual(["height"]);
});
