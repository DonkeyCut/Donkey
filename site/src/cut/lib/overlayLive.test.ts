import { beforeAll, describe, expect, test } from "bun:test";
import type { ShapeOverlay } from "@donkeycut/effects-kit";
import { behindOverlaysAt, SubjectMaskCompositor } from "./behindPass";
import { liveEffectsAt } from "./effectStack";
import { renderProjectFrame } from "./exportRender";
import { installSkiaRaster } from "./headless/skiaRaster";
import { overlayLiveAt, stageTimeAt } from "./overlayLive";
import type { ExportDoc } from "./renderSnapshot";
import type { Overlay, TextOverlay } from "./types";

// A shot's elements end on the frame the next shot starts. That frame belongs
// to the incoming shot: frame 508 at 30 fps (t = 16.9333) shows the next
// shot's elements alone, in the preview and in the export.

const FPS = 30;
const CUT = 508 / FPS;
const size = { width: 320, height: 180 };

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

const rect = (id: string, start: number, end: number, fill: string): ShapeOverlay => ({
  id, kind: "shape", shape: "rect", start, end,
  x: 0.5, y: 0.5, w: 0.5, h: 0.5, fill,
});

const flash = (id: string, start: number, end: number) =>
  ({ id, kind: "effect", effect: "lightleak", leak: "film", amount: 1, start, end, x: 0.5, y: 0.5, lane: 0 }) as Overlay;

const behind = (id: string, start: number, end: number): TextOverlay => ({
  id, text: "SOON", start, end,
  x: 0.5, y: 0.5, size: 160, font: "sf", weight: 900, color: "#ffffff",
  plate: false, shadow: false,
  mask: { kind: "subject", invert: true } as TextOverlay["mask"],
});

const docOf = (overlays: Overlay[]): ExportDoc => ({
  aspect: "16:9", assets: [], clips: [], audioClips: [], overlays,
  subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
});

/** Pixels where one channel is lit and the other two are dark. */
function inkOf(data: Uint8ClampedArray, channel: number): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const lit = data[i + channel] > 128;
    const others = [0, 1, 2].filter((c) => c !== channel).every((c) => data[i + c] < 64);
    if (lit && others) {
      n++;
    }
  }
  return n;
}

describe("the frame on a cut", () => {
  const outgoing = rect("out", 15, CUT, "#ff0000");
  const incoming = rect("in", CUT, 18.5, "#0000ff");

  test("the preview's elements show the incoming shot's alone", () => {
    const live = [outgoing, incoming].filter((o) => overlayLiveAt(o, stageTimeAt(CUT, 20)));
    expect(live.map((o) => o.id)).toEqual(["in"]);
  });

  test("the preview's effects grade with the incoming shot's alone", () => {
    const live = liveEffectsAt([flash("a", 15, CUT), flash("b", CUT, 18.5)], CUT);
    expect(live.length).toBe(1);
  });

  test("the behind-the-speaker pass draws the incoming shot's alone", async () => {
    const overlays = [behind("out", 15, CUT), behind("in", CUT, 18.5)];
    expect(behindOverlaysAt(overlays, CUT).map((o) => o.id)).toEqual(["in"]);

    // The export prepares a picture for each element it is about to draw.
    const pass = new SubjectMaskCompositor();
    await pass.ready(overlays, 540, 960, [], CUT);
    const rasters = (pass as unknown as { rasters: Map<string, unknown> }).rasters;
    expect([...rasters.keys()]).toEqual(["in"]);
    pass.dispose();
  });

  test("the export draws the incoming shot's alone", async () => {
    const frame = await renderProjectFrame(docOf([outgoing, incoming]), CUT, size, () => "");
    const data = (frame.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, size.width, size.height).data;
    expect(inkOf(data, 0)).toBe(0);
    expect(inkOf(data, 2)).toBeGreaterThan(1000);
  });

  test("a cut every frame shows one shot's element per frame", () => {
    const shots = Array.from({ length: 10 }, (_, i) => rect(`s${i}`, (500 + i) / FPS, (501 + i) / FPS, "#ffffff"));
    for (let i = 0; i < 10; i++) {
      const live = shots.filter((o) => overlayLiveAt(o, stageTimeAt((500 + i) / FPS, 20)));
      expect(live.map((o) => o.id)).toEqual([`s${i}`]);
    }
  });
});

// Playback stops with the playhead on the cut's end. The paused frame there
// is the cut's last frame, so what runs to the end still shows.
describe("paused at the cut's end", () => {
  const total = CUT;

  test("an element running to the end shows", () => {
    expect(overlayLiveAt(rect("last", 15, total, "#ff0000"), stageTimeAt(total, total))).toBe(true);
  });

  test("an effect running to the end grades", () => {
    expect(liveEffectsAt([flash("last", 15, total)], stageTimeAt(total, total)).length).toBe(1);
  });

  test("a moment inside the cut is its own", () => {
    expect(stageTimeAt(3, total)).toBe(3);
  });
});
