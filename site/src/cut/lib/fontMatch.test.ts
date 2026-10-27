import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import path from "node:path";
import { Canvas, FontLibrary, loadImage } from "skia-canvas";

/** skia's font registry, under a name the hook lint leaves alone. */
const fontLibrary = FontLibrary;
import { CUT_FONT_MATCH } from "./fontMatchSettings";
import { setRasterFactory, type RasterFactory, type RasterSurface } from "./raster";
import { GOOGLE_FONTS } from "./fontCatalog";
import { bundledFaces, inkMaskOf, rankFaces, type TitleFace } from "./fontMatch";
import { fontStack, registerFonts } from "./types";

// Which bundled face a piece of type on a reference frame is set in: the
// reference's ink against each candidate's glyphs for the same words.

const FILES = new URL("../../../node_modules/@fontsource/", import.meta.url).pathname;
const FAMILIES: [id: string, pkg: string, label: string, weights: number[]][] = [
  ["oswald", "oswald", "Oswald", [400, 700]],
  ["montserrat", "montserrat", "Montserrat", [400, 900]],
  ["anton", "anton", "Anton", [400]],
  ["bebas", "bebas-neue", "Bebas Neue", [400]],
  ["playfair", "playfair-display", "Playfair Display", [400, 700]],
  ["lobster", "lobster", "Lobster", [400]],
  ["cinzel", "cinzel", "Cinzel", [400, 700]],
  ["great-vibes", "great-vibes", "Great Vibes", [400]],
];

const CANDIDATES: TitleFace[] = [
  { font: "oswald", weight: 400 },
  { font: "oswald", weight: 700 },
  { font: "montserrat", weight: 400 },
  { font: "montserrat", weight: 900 },
  { font: "anton", weight: 400 },
  { font: "bebas", weight: 400 },
  { font: "playfair", weight: 400 },
  { font: "playfair", weight: 700 },
  { font: "lobster", weight: 400 },
  { font: "cinzel", weight: 400 },
];

let restore: RasterFactory | undefined;
beforeAll(() => {
  for (const [id, pkg, label, weights] of FAMILIES) {
    fontLibrary.use(label, weights.map((w) => `${FILES}${pkg}/files/${pkg}-latin-${w}-normal.woff2`));
    registerFonts([{ id, label, stack: `"${label}"` }]);
  }
  restore = setRasterFactory({
    createCanvas: (w, h) => new Canvas(Math.max(1, w), Math.max(1, h)) as unknown as RasterSurface,
    decodeImage: async () => null,
    canvasToBlob: async () => new Blob([]),
    snapshot: async (c) => c as unknown as ImageBitmap,
  });
});
afterAll(() => {
  if (restore) setRasterFactory(restore);
});

/** A frame region holding `text` set in a face, ink on a plain ground. */
function reference(text: string, css: string, opts: { tracking?: number; ink?: string; ground?: string } = {}) {
  const c = new Canvas(1200, 260);
  const ctx = c.getContext("2d");
  ctx.fillStyle = opts.ground ?? "#1b2a3a";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = css;
  const px = Number(/(\d+)px/.exec(css)![1]);
  ctx.letterSpacing = `${(opts.tracking ?? 0) * px}px`;
  ctx.fillStyle = opts.ink ?? "#f4efe6";
  ctx.textBaseline = "middle";
  text.split("\n").forEach((line, i, all) => ctx.fillText(line, 40, 130 + (i - (all.length - 1) / 2) * px * 1.3));
  const data = ctx.getImageData(0, 0, c.width, c.height);
  return inkMaskOf(data.data, data.width, data.height);
}

const good = CUT_FONT_MATCH.goodScore;

describe("font suggestions", () => {
  test("the face the words are set in ranks first, with its tracking", async () => {
    const ref = reference("TRAVEL DESTINATION", '700 64px "Oswald"', { tracking: 0.12 });
    const ranked = await rankFaces(ref, "TRAVEL DESTINATION", CANDIDATES, fontStack);
    expect(ranked[0]).toMatchObject({ font: "oswald", weight: 700 });
    expect(ranked[0].score).toBeGreaterThan(good);
    expect(Math.abs(ranked[0].tracking - 0.12)).toBeLessThan(0.03);
  });

  test("small, soft, noisy type still finds its face", async () => {
    // Set small, blown up 3× through a blur, with grain on top: a title read
    // off a compressed 720p frame.
    const small = new Canvas(400, 80);
    const s = small.getContext("2d");
    s.fillStyle = "#3a5068";
    s.fillRect(0, 0, 400, 80);
    s.font = '700 26px "Oswald"';
    s.letterSpacing = "2.6px";
    s.fillStyle = "#ffffff";
    s.textBaseline = "middle";
    s.fillText("TRAVEL DESTINATION", 10, 40);
    const big = new Canvas(1200, 240);
    const b = big.getContext("2d");
    b.filter = "blur(2px)";
    b.drawImage(small, 0, 0, 1200, 240);
    const d = b.getImageData(0, 0, 1200, 240);
    let seed = 7;
    for (let i = 0; i < d.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const n = (seed / 2147483648 - 0.5) * 50;
      for (let c = 0; c < 3; c++) d.data[i + c] = Math.max(0, Math.min(255, d.data[i + c] + n));
    }
    const ranked = await rankFaces(inkMaskOf(d.data, 1200, 240), "TRAVEL DESTINATION", CANDIDATES, fontStack);
    expect(ranked[0]).toMatchObject({ font: "oswald", weight: 700 });
    expect(ranked[0].score).toBeGreaterThan(good);
  });

  test("weight tells two cuts of one family apart", async () => {
    const ref = reference("Travel Destination", '900 60px "Montserrat"');
    const ranked = await rankFaces(ref, "Travel Destination", CANDIDATES, fontStack);
    expect(ranked[0]).toMatchObject({ font: "montserrat", weight: 900 });
    const light = ranked.find((m) => m.font === "montserrat" && m.weight === 400)!;
    expect(light.score).toBeLessThan(ranked[0].score);
  });

  test("a face none of the candidates is scores under the good mark", async () => {
    const ref = reference("Travel Destination", '400 90px "Great Vibes"');
    const ranked = await rankFaces(ref, "Travel Destination", CANDIDATES, fontStack);
    expect(ranked[0].score).toBeLessThan(good);
  });

  test("dark type on a light ground reads the same as light on dark", async () => {
    const light = reference("DESTINATION", '400 80px "Anton"', { ink: "#111111", ground: "#f0f0f0" });
    const dark = reference("DESTINATION", '400 80px "Anton"');
    // The same box, give or take the pixel anti-aliasing lands on.
    for (const k of ["x", "y", "w", "h"] as const) expect(Math.abs(light.box![k] - dark.box![k])).toBeLessThanOrEqual(1);
    expect((await rankFaces(light, "DESTINATION", CANDIDATES, fontStack))[0].font).toBe("anton");
  });

  test("two lines are scored line by line, and a line count that differs is refused", async () => {
    const ref = reference("TRAVEL\nDESTINATION", '400 60px "Cinzel"');
    const ranked = await rankFaces(ref, "TRAVEL\nDESTINATION", CANDIDATES, fontStack);
    expect(ranked[0]).toMatchObject({ font: "cinzel", weight: 400 });
    await expect(rankFaces(ref, "TRAVEL DESTINATION", CANDIDATES, fontStack)).rejects.toThrow(/2 lines/);
  });
});

// Type cut off a reference itself: a reel whose "TRAVEL DESTINATION" title
// cycles through faces. Each fixture is one held frame's title line, at the
// frame's own pixels, ranked against every bundled family at its bundled
// weights, the candidates suggest_font hands rankFaces. The system set is
// left out: it draws in whatever faces the host has.
describe("faces off a reference frame", () => {
  const resolve = createRequire(import.meta.url).resolve;
  const pkg = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  let catalog: TitleFace[] = [];

  beforeAll(() => {
    for (const f of GOOGLE_FONTS) {
      const p = pkg(f.label);
      const files = path.join(path.dirname(resolve(`@fontsource/${p}/package.json`)), "files");
      const face = (w: number, style: string) => path.join(files, `${p}-latin-${w}-${style}.woff2`);
      fontLibrary.use(f.label, [...f.weights.map((w) => face(w, "normal")), ...(f.italics ?? []).map((w) => face(w, "italic"))]);
      registerFonts([{ id: f.id, label: f.label, stack: `"${f.label}"` }]);
    }
    const ids = new Set(GOOGLE_FONTS.map((f) => f.id));
    catalog = bundledFaces().filter((f) => ids.has(f.font));
  });

  async function frameInk(name: string) {
    const img = await loadImage(new URL(`./fixtures/${name}`, import.meta.url).pathname);
    const c = new Canvas(img.width, img.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height);
    return inkMaskOf(d.data, d.width, d.height);
  }

  test("the cycle's heavy geometric face matches Prompt Black", async () => {
    // Held from 6.57 s to 6.87 s, yellow on purple, 85 px of crop. Before
    // Prompt was bundled the closest face was Montserrat Black at 0.70, under
    // the good mark, so the tool said nothing bundled matched.
    const ranked = await rankFaces(await frameInk("font-cycle-heavy-geometric.webp"), "TRAVEL DESTINATION", catalog, fontStack);
    expect(ranked[0]).toMatchObject({ font: "prompt", weight: 900 });
    expect(ranked[0].score).toBeGreaterThanOrEqual(good);
    expect(ranked.find((m) => m.font !== "prompt")!.score).toBeLessThan(good);
  });

  test("a lyric template's tall condensed word matches Antonio Bold", async () => {
    // "ALIVE" in red over pink, 280 px of a 720 px frame. Before Antonio was
    // bundled the closest face was Anton at 0.716, and only at a tracking
    // tight enough to run its letters into each other.
    const ranked = await rankFaces(await frameInk("condensed-bold-alive.webp"), "ALIVE", catalog, fontStack);
    expect(ranked[0]).toMatchObject({ font: "antonio", weight: 700 });
    expect(ranked[0].score).toBeGreaterThanOrEqual(good);
    expect(ranked.find((m) => m.font === "anton")!.score).toBeLessThan(ranked[0].score);
  });

  test("a recap template's small display serif ranks Libre Caslon Display over Playfair", async () => {
    // "photo 29" in warm grey over peach, 41 px tall in a 576 px frame: a
    // thin Caslon-style display serif. Before Libre Caslon Display was
    // bundled the closest serif was Playfair Display, far wider and with a
    // taller x-height, at 0.29.
    const ranked = await rankFaces(await frameInk("serif-photo-29.webp"), "photo 29", catalog, fontStack);
    const caslon = ranked.find((m) => m.font === "libre-caslon-display")!;
    const playfair = ranked.find((m) => m.font === "playfair")!;
    expect(caslon.score).toBeGreaterThan(playfair.score + 0.1);
  });
});
