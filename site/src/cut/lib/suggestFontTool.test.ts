import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { Canvas, FontLibrary } from "skia-canvas";

/** skia's font registry, under a name the hook lint leaves alone. */
const fontLibrary = FontLibrary;
import { CUT_FONT_MATCH } from "./fontMatchSettings";
import { stubModule } from "@/lib/testing/stubModule";
import { setRasterFactory, type RasterFactory, type RasterSurface } from "./raster";
import { registerFonts } from "./types";

// suggest_font reads a reference's frame where its type sits and ranks the
// faces Donkey can set a title in against it.

const FILES = new URL("../../../node_modules/@fontsource/", import.meta.url).pathname;
fontLibrary.use("Oswald", [400, 500, 600, 700].map((w) => `${FILES}oswald/files/oswald-latin-${w}-normal.woff2`));
fontLibrary.use("Anton", [`${FILES}anton/files/anton-latin-400-normal.woff2`]);
fontLibrary.use("Great Vibes", [`${FILES}great-vibes/files/great-vibes-latin-400-normal.woff2`]);

/** What the reference shows: a 1920×1080 frame with one line of type. */
let shows: { text: string; css: string; rotate?: number; at?: [number, number] } = { text: "TRAVEL DESTINATION", css: '700 72px "Oswald"' };
const reads: number[] = [];
async function frameAt(_src: string | Blob, time: number) {
  reads.push(time);
  const c = new Canvas(1920, 1080);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#20304a";
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.font = shows.css;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const [ax, ay] = shows.at ?? [960, 540];
  ctx.translate(ax, ay);
  ctx.rotate(((shows.rotate ?? 0) * Math.PI) / 180);
  ctx.fillText(shows.text, 0, 0);
  return { canvas: c, timestamp: time, duration: 1 / 30 } as never;
}
await stubModule<typeof import("./mediaRead")>("./mediaRead", import.meta.url, { frameAt });

const { runAiTool } = await import("./aiTools");
const { useEditor } = await import("./store");

let restore: RasterFactory | undefined;
beforeAll(() => {
  registerFonts([
    { id: "oswald", label: "Oswald", stack: '"Oswald"' },
    { id: "anton", label: "Anton", stack: '"Anton"' },
  ]);
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

beforeEach(() => {
  reads.length = 0;
  shows = { text: "TRAVEL DESTINATION", css: '700 72px "Oswald"' };
  useEditor.setState({
    projectId: "p",
    aspect: "16:9",
    clips: [],
    overlays: [],
    audioClips: [],
    assets: [
      { id: "ref", fileName: "ref.mp4", name: "Reference", type: "video", duration: 20, url: "" },
      { id: "song", fileName: "song.mp3", name: "Song", type: "audio", duration: 20, url: "" },
    ],
  } as never);
});

// Centre and size, frame fractions, like every picture tool.
const REGION = { x: 0.5, y: 0.5, w: 0.6, h: 0.2 };
type Out = {
  verdict: string;
  ink: { x: number; y: number; w: number; h: number };
  matches: { font: string; weight: number; score: number; size: number; tracking: number }[];
  note: string;
};
const message = async (p: Promise<unknown>) =>
  p.then(() => "", (e: unknown) => (e instanceof Error ? e.message : String(e)));

test("the face the reference is set in comes first, with the size that matches its ink", async () => {
  const out = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: REGION, text: "TRAVEL DESTINATION" })) as Out;
  expect(reads).toEqual([3]);
  expect(out.verdict).toBe("match");
  expect(out.matches[0]).toMatchObject({ font: "oswald", weight: 700 });
  // 72px type on a 1080-tall frame is 72px at the 1080 short side.
  expect(Math.abs(out.matches[0].size - 72)).toBeLessThanOrEqual(3);
  expect(Math.abs(out.matches[0].tracking)).toBeLessThan(0.03);
  // The ink's centre, in frame fractions, is where it was drawn: the x/y
  // add_title takes as they are.
  expect(Math.abs(out.ink.x - 0.5)).toBeLessThan(0.01);
  expect(out.matches.length).toBeLessThanOrEqual(5);
});

test("type in a face Donkey does not bundle is reported as that", async () => {
  shows = { text: "Travel Destination", css: '400 110px "Great Vibes"' };
  const out = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: REGION, text: "Travel Destination" })) as Out;
  expect(out.verdict).toBe("no_match");
  expect(out.matches[0].score).toBeLessThan(CUT_FONT_MATCH.goodScore);
  expect(out.note).toContain("does not bundle");
});

test("a region with no type, a sound, and missing words are refused", async () => {
  expect(await message(runAiTool("suggest_font", { asset_id: "ref", t: 3, region: { x: 0.05, y: 0.05, w: 0.1, h: 0.1 }, text: "TRAVEL" }))).toContain("No type");
  expect(await message(runAiTool("suggest_font", { asset_id: "song", t: 3, region: REGION, text: "TRAVEL" }))).toContain("audio");
  expect(await message(runAiTool("suggest_font", { asset_id: "ref", t: 3, region: REGION, text: " " }))).toContain("text");
  expect(await message(runAiTool("suggest_font", { asset_id: "ref", t: 3, region: { x: 0.5, y: 0.5, w: 0, h: 0.1 }, text: "TRAVEL" }))).toContain("region");
});

test("inside a picture box, the region, the ink and the size are the box's", async () => {
  // The picture is the frame's middle half: 1920×540. The same crop as REGION,
  // given in the box's fractions, and 72px type is 144px at the box's 1080.
  useEditor.getState().updateAsset("ref", { picture: { x: 0.5, y: 0.5, w: 1, h: 0.5 } });
  const out = (await runAiTool("suggest_font", {
    asset_id: "ref",
    t: 3,
    region: { x: 0.5, y: 0.5, w: 0.6, h: 0.4 },
    text: "TRAVEL DESTINATION",
  })) as Out & { picture?: unknown };
  expect(out.matches[0]).toMatchObject({ font: "oswald", weight: 700 });
  expect(Math.abs(out.matches[0].size - 144)).toBeLessThanOrEqual(6);
  expect(Math.abs(out.ink.y - 0.5)).toBeLessThan(0.02);
  expect(out.picture).toBeDefined();
});

test("a word set sideways is read upright, and the rotation that sets it comes back", async () => {
  // A column word reading bottom to top: a title at rotation -90.
  shows = { text: "PLEASE", css: '700 120px "Oswald"', rotate: -90, at: [192, 540] };
  const column = { x: 0.1, y: 0.5, w: 0.12, h: 0.7 };
  const out = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: column, text: "PLEASE" })) as Out & { rotation: number };
  expect(out.rotation).toBe(-90);
  expect(out.matches[0]).toMatchObject({ font: "oswald", weight: 700 });
  expect(Math.abs(out.matches[0].size - 120)).toBeLessThanOrEqual(5);
  expect(Math.abs(out.ink.x - 0.1)).toBeLessThan(0.01);
  expect(Math.abs(out.ink.y - 0.5)).toBeLessThan(0.02);
  // Read upright the word is long; on the frame it stands tall.
  expect(out.ink.h).toBeGreaterThan(out.ink.w);
  // Told the rotation, it reads the same.
  const told = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: column, text: "PLEASE", rotation: -90 })) as Out & { rotation: number };
  expect(told.rotation).toBe(-90);
  expect(told.matches[0]).toMatchObject({ font: "oswald", weight: 700 });
});

test("type too small to tell faces apart says so and lists the faces by kind", async () => {
  // 18px on a 1080 frame: a few pixels of x-height, where glyph overlap
  // sees proportions and not the face.
  shows = { text: "of my life", css: '400 18px "Oswald"' };
  const out = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: { x: 0.5, y: 0.5, w: 0.2, h: 0.08 }, text: "of my life" })) as Out & {
    small?: boolean;
    inkPx: number;
    kinds?: Record<string, string[]>;
  };
  expect(out.small).toBe(true);
  expect(out.inkPx).toBeLessThan(24);
  expect(out.note).toContain("too small");
  // Each face by its id and how it looks, to pick a stand-in by eye.
  expect(out.kinds?.serif).toContain("serif — book serif (New York)");
  expect(out.kinds?.sans).toContain("oswald — condensed grotesque");
  // Type big enough to read is not flagged.
  shows = { text: "TRAVEL DESTINATION", css: '700 72px "Oswald"' };
  const big = (await runAiTool("suggest_font", { asset_id: "ref", t: 3, region: REGION, text: "TRAVEL DESTINATION" })) as Out & { small?: boolean };
  expect(big.small).toBeUndefined();
});
