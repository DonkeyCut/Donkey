import { beforeAll, expect, test } from "bun:test";
import { FontLibrary } from "skia-canvas";
import { installSkiaRaster } from "./headless/skiaRaster";
import { renderProjectFrame } from "./exportRender";
import { inkOffset } from "./fontMatch";
import type { ExportDoc } from "./renderSnapshot";
import { fontStack, registerFonts, type TextOverlay } from "./types";

/** skia's font registry, under a name the hook lint leaves alone. */
const fontLibrary = FontLibrary;

/**
 * A headless export sets a title's lines where the in-tab export does.
 *
 * Each line is drawn about its middle, and where a face's baseline sits under
 * that middle used to be the canvas's own reading of textBaseline "middle".
 * Chrome reads it off the face's em box; skia reads it off the line box a CSS
 * line centres, so the same Jost title stood 12 px apart in the two exports.
 *
 * Chrome's numbers at 110 px, read off its canvas: how far under the line's
 * middle it draws each face's baseline.
 */
const CHROME_110: [font: string, weight: number, drop: number][] = [
  ["jost", 700, 26.453125],
  // A face whose em box is not its line box: Chrome sets Prompt by the em
  // box, which its line box overhangs at both ends.
  ["prompt", 900, 27.5],
  // skia reads Poppins' line box off its Windows metrics.
  ["poppins", 700, 27.5],
];

const size = { width: 1080, height: 1920 };

// The staged faces, as a headless render loads them. Only these: skia's
// registry outlives the file, and the stand-ins would answer for Arial.
const FACES: [id: string, family: string, file: string][] = [
  ["jost", "Jost", "jost-latin-700-normal.woff2"],
  ["prompt", "Prompt", "prompt-latin-900-normal.woff2"],
  ["poppins", "Poppins", "poppins-latin-700-normal.woff2"],
];

beforeAll(async () => {
  expect(await installSkiaRaster()).toBe(true);
  for (const [id, family, file] of FACES) {
    fontLibrary.use(family, [new URL(`../../../public/cut-fonts/${file}`, import.meta.url).pathname]);
    registerFonts([{ id, label: family, stack: `"${family}"` }]);
  }
});

const title = (font: string, weight: number): TextOverlay => ({
  id: "t",
  text: "HIH",
  start: 0,
  end: 3,
  x: 0.5,
  y: 0.5,
  size: 110,
  font,
  weight: weight as TextOverlay["weight"],
  color: "#ffffff",
  plate: false,
  shadow: false,
});

/** The title's ink rows through the export frame: its top and the row under
 * its last, which is the baseline for capitals. */
async function inkRows(o: TextOverlay): Promise<{ top: number; base: number }> {
  const doc: ExportDoc = {
    aspect: "9:16", assets: [], clips: [], audioClips: [], overlays: [o],
    subtitles: { cues: [], showOnVideo: false, showOnTimeline: false },
  };
  const frame = await renderProjectFrame(doc, 1, size, () => "");
  const data = (frame.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, size.width, size.height).data;
  frame.width = frame.height = 1;
  let top = -1;
  let base = -1;
  for (let y = 0; y < size.height; y++) {
    for (let x = 400; x < 680; x++) {
      const i = (y * size.width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > 3 * 200) {
        if (top < 0) top = y;
        base = y + 1;
        break;
      }
    }
  }
  return { top, base };
}

for (const [font, weight, drop] of CHROME_110) {
  test(`a ${font} title sits on the baseline Chrome draws it on`, async () => {
    const { base } = await inkRows(title(font, weight));
    expect(Math.abs(base - (size.height / 2 + drop))).toBeLessThanOrEqual(1);
  });
}

test("suggest_font reads a face's ink where the export draws it", async () => {
  // A title set at the reference's ink centre less this offset lands its ink
  // on the reference's, so it has to be the offset the export draws.
  const { top, base } = await inkRows(title("jost", 700));
  const off = await inkOffset({ font: "jost", weight: 700 }, 110, 0, "HIH", fontStack);
  expect(off).not.toBeNull();
  expect(Math.abs(off!.dy - ((top + base) / 2 - size.height / 2))).toBeLessThanOrEqual(1);
});
