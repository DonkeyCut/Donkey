import { beforeAll, beforeEach, expect, test } from "bun:test";
import { installSkiaRaster } from "./headless/skiaRaster";
import { renderProjectFrame } from "./exportRender";
import { renderElementFrames } from "./textRender";
import { createRasterCanvas, decodeRasterImage } from "./raster";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { emptySubtitles, isTextOverlay } from "./types";
import type { ExportDoc } from "./renderSnapshot";
import { evalOverlayAnim } from "@donkeycut/effects-kit";

// A label per shot in a reel cut every frame or two runs one frame: it has to
// show on that frame, in the export and in the frames the ffmpeg path burns.

const size = { width: 320, height: 180 };

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
});

beforeEach(() =>
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [],
    clips: [],
    audioClips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  })
);

const ink = (data: Uint8ClampedArray, channel: number) => {
  let n = 0;
  for (let i = channel; i < data.length; i += 4) if (data[i] > 128) n++;
  return n;
};

for (const look of ["serif-mood", "lyric-card", "over-footage"]) {
  test(`a one-frame label in ${look} shows on its frame`, async () => {
    await runAiTool("add_text_sequence", { look, cards: false, lines: [{ text: "SHOT", start: 1, end: 61 / 60, size: 160 }] });
    const word = useEditor.getState().overlays.filter(isTextOverlay)[0];
    expect(evalOverlayAnim(word.anim, 0, word.end - word.start, true).alpha).toBe(1);

    const doc: ExportDoc = {
      aspect: "16:9", assets: [], clips: [], audioClips: [], overlays: [word],
      subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
    };
    const frame = await renderProjectFrame(doc, 1, size, () => "");
    const exported = (frame.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, size.width, size.height).data;
    expect(ink(exported, 0) + ink(exported, 1) + ink(exported, 2)).toBeGreaterThan(50);

    const frames = await renderElementFrames(word, size.width, size.height, 30);
    const first = await decodeRasterImage(frames.images[frames.entries[0].image]);
    expect(first).not.toBeNull();
    const sheet = createRasterCanvas(size.width, size.height);
    const sctx = sheet.getContext("2d") as CanvasRenderingContext2D;
    sctx.drawImage(first!.source, frames.x, frames.y);
    const sampled = sctx.getImageData(0, 0, size.width, size.height).data;
    expect(ink(sampled, 3)).toBeGreaterThan(50);
  });
}
