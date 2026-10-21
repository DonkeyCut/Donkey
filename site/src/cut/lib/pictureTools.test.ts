import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import type { Input, InputVideoTrack, WrappedCanvas } from "mediabunny";
import * as mediaRead from "./mediaRead";
import { storedAssets, useEditor } from "./store";

// A reference recorded off a phone screen: a 9:16 frame of an editing app with
// the 16:9 picture across its middle, buttons and bars still around it. The
// source-reading tools find that picture, keep it on the asset, read only
// inside it, and speak in its fractions so their numbers land on the cut.

const FPS = 60;
const FRAMES = 120; // 2 s
const W = 1080;
const H = 1920;
/** The picture's rows, as frame fractions: 16:9 across the full width. */
const TOP = 0.342;
const BOTTOM = 0.658;

type Rgb = [number, number, number];
const RED: Rgb = [200, 30, 30];
const BLUE: Rgb = [30, 30, 200];
const GREEN: Rgb = [30, 160, 60];
const WHITE: Rgb = [255, 255, 255];
const CHROME: Rgb = [40, 40, 44];
const BUTTON: Rgb = [220, 220, 220];

/** Picture fractions of the card that lands at frame 90: 30% wide, 40% tall. */
const CARD = { x0: 0.35, x1: 0.65, y0: 0.3, y1: 0.7 };

/** The colour at frame f and frame fractions (fx, fy). Inside the picture:
 * red, then blue from frame 30, then green from 60, with a white card over
 * the green from frame 90 — a change to a small share of the whole frame. */
function colourAt(f: number, fx: number, fy: number): Rgb {
  if (fy < TOP || fy >= BOTTOM) {
    const button = (fx > 0.1 && fx < 0.2 && fy > 0.8 && fy < 0.85) || (fx > 0.7 && fx < 0.9 && fy > 0.05 && fy < 0.1);
    return button ? BUTTON : CHROME;
  }
  const px = fx;
  const py = (fy - TOP) / (BOTTOM - TOP);
  if (f < 30) return RED;
  if (f < 60) return BLUE;
  if (f >= 90 && px >= CARD.x0 && px < CARD.x1 && py >= CARD.y0 && py < CARD.y1) return WHITE;
  return GREEN;
}

function frameCanvas(f: number, w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colourAt(f, (x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  const ctx = { getImageData: () => ({ data, width: w, height: h }), drawImage() {}, putImageData() {} };
  return { width: w, height: h, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

const wrap = (f: number, w: number, h: number) =>
  ({ canvas: frameCanvas(f, w, h), timestamp: f / FPS, duration: 1 / FPS }) as WrappedCanvas;
const frameShownAt = (t: number) => Math.max(0, Math.min(FRAMES - 1, Math.floor(t * FPS + 1e-6)));

/** The sizes frames were read at, newest last. */
const sizes: { width: number; height: number }[] = [];
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
    sizes.push({ width: w, height: h });
    return {
      getCanvas: async (t: number) => wrap(frameShownAt(t), w, h),
      async *canvases(start = 0, end = Infinity) {
        for (let f = frameShownAt(start); f < FRAMES && f / FPS < end; f++) yield wrap(f, w, h);
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
  sizes.length = 0;
  useEditor.setState({
    assets: [{ id: "ref", fileName: "ref.mp4", name: "Recording", type: "video", duration: FRAMES / FPS, url: "fixture.mp4", width: W, height: H }],
  });
});

const message = async (p: Promise<unknown>) =>
  p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));
const stored = () => useEditor.getState().assets.find((a) => a.id === "ref")!.picture;

type Box = { x: number; y: number; w: number; h: number };

test("find_picture finds the picture inside a recording and keeps it on the asset", async () => {
  const out = (await runAiTool("find_picture", { asset_id: "ref" })) as { picture: Box; full: boolean; aspect: number; note: string };
  expect(out.full).toBe(false);
  expect(out.picture.x).toBeCloseTo(0.5, 2);
  expect(out.picture.w).toBeCloseTo(1, 2);
  expect(out.picture.y).toBeCloseTo((TOP + BOTTOM) / 2, 2);
  expect(out.picture.h).toBeCloseTo(BOTTOM - TOP, 2);
  expect(out.aspect).toBeCloseTo(16 / 9, 1);
  expect(out.note).toContain("fractions");

  // Stored as a source fact, so it saves with the project.
  expect(stored()!.h).toBeCloseTo(BOTTOM - TOP, 2);
  expect(storedAssets(useEditor.getState().assets)[0].picture).toEqual(stored());
});

test("find_picture takes a box the model sets, the whole frame included", async () => {
  await runAiTool("find_picture", { asset_id: "ref", box: { x: 0.5, y: 0.4, w: 1, h: 0.3 } });
  expect(stored()).toEqual({ x: 0.5, y: 0.4, w: 1, h: 0.3 });
  const out = (await runAiTool("find_picture", { asset_id: "ref", box: "full" })) as { full: boolean };
  expect(out.full).toBe(true);
  expect(stored()).toEqual({ x: 0.5, y: 0.5, w: 1, h: 1 });
});

test("detect_cuts finds the picture first, then a card that changes a small share of the frame", async () => {
  const out = (await runAiTool("detect_cuts", { asset_id: "ref" })) as {
    cuts: { frame: number }[];
    picture: Box;
    pictureNote: string;
  };
  expect(out.cuts.map((c) => c.frame)).toEqual([30, 60, 90]);
  expect(out.picture.h).toBeCloseTo(BOTTOM - TOP, 2);
  expect(out.pictureNote).toContain("picture");
  expect(stored()).toBeDefined();

  // Over the whole recorded frame, the card is too small a change to call.
  const whole = (await runAiTool("detect_cuts", { asset_id: "ref", picture: "full" })) as { cuts: { frame: number }[]; picture?: Box };
  expect(whole.cuts.map((c) => c.frame)).toEqual([30, 60]);
  expect(whole.picture).toBeUndefined();
});

test("detect_cuts reports a card landing inside a shot as a change, with its box", async () => {
  // Over the whole recorded frame the card is no cut; it is still the moment
  // a card lands, and where it sits.
  const whole = (await runAiTool("detect_cuts", { asset_id: "ref", picture: "full" })) as {
    changes: { frame: number; frames: number; box: Box }[];
  };
  expect(whole.changes.map((c) => c.frame)).toEqual([90]);
  expect(whole.changes[0].frames).toBe(1);
  expect(whole.changes[0].box.x).toBeCloseTo(0.5, 1);
  expect(whole.changes[0].box.y).toBeCloseTo(0.5, 1);
  expect(whole.changes[0].box.w).toBeCloseTo(CARD.x1 - CARD.x0, 1);
});

test("sample_color reads in the picture's fractions once a picture is stored", async () => {
  await runAiTool("find_picture", { asset_id: "ref" });
  const out = (await runAiTool("sample_color", {
    asset_id: "ref",
    samples: [
      { t: 1.2, x: 0.5, y: 0.1 },
      { t: 1.6, x: 0.5, y: 0.5 },
    ],
  })) as { samples: { hex: string; x: number; y: number }[]; picture: Box };
  // y 0.1 of the picture is green footage; of the whole frame it is chrome.
  expect(out.samples.map((s) => s.hex)).toEqual(["#1EA03C", "#FFFFFF"]);
  expect(out.samples[0].y).toBe(0.1);
  expect(out.picture).toBeDefined();
  const whole = (await runAiTool("sample_color", { asset_id: "ref", picture: "full", samples: [{ t: 1.2, x: 0.5, y: 0.1 }] })) as {
    samples: { hex: string }[];
  };
  expect(whole.samples[0].hex).toBe("#28282C");
});

test("track_element measures a card in the picture's fractions", async () => {
  await runAiTool("find_picture", { asset_id: "ref" });
  const out = (await runAiTool("track_element", {
    asset_id: "ref",
    from: 1.6,
    seed: { x: 0.5, y: 0.5, w: 0.05, h: 0.05 },
  })) as { path: Box[] };
  const [box] = out.path;
  expect(box.x).toBeCloseTo(0.5, 2);
  expect(box.y).toBeCloseTo(0.5, 2);
  expect(box.w).toBeCloseTo(CARD.x1 - CARD.x0, 2);
  expect(box.h).toBeCloseTo(CARD.y1 - CARD.y0, 2);
});

test("a picture passed on the call wins over the stored one", async () => {
  useEditor.getState().updateAsset("ref", { picture: { x: 0.5, y: 0.5, w: 1, h: 1 } });
  const out = (await runAiTool("sample_color", {
    asset_id: "ref",
    picture: { x: 0.5, y: (TOP + BOTTOM) / 2, w: 1, h: BOTTOM - TOP },
    samples: [{ t: 1.2, x: 0.5, y: 0.1 }],
  })) as { samples: { hex: string }[] };
  expect(out.samples[0].hex).toBe("#1EA03C");
  expect(await message(runAiTool("sample_color", { asset_id: "ref", picture: "half", samples: [{ t: 1, x: 0.5, y: 0.5 }] }))).toContain(
    "full"
  );
});
