import { describe, expect, test } from "bun:test";
import { Canvas, loadImage } from "skia-canvas";
import { cutAtFaces, cycleFaceAt, cycleFaceTag, fontCycleCuts, fontCycleVariants, withFontCycle } from "./fontCycle";
import { planAnimatedLayers, renderOverlayFrames, settleCycleFace, textRoom, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";

const title = (fonts?: NonNullable<TextOverlay["anim"]>["fonts"]): TextOverlay => ({
  id: "t",
  kind: "text",
  text: "STAY TUNED",
  start: 2,
  end: 4,
  x: 0.5,
  y: 0.5,
  size: 50,
  font: "montserrat",
  weight: 700,
  color: "#ffffff",
  letterSpacing: 0.3,
  shadow: false,
  plate: false,
  ...(fonts ? { anim: { fonts } } : {}),
});

const CYCLE = {
  faces: [{ font: "caveat", weight: 400 as const, scale: 2 }, { font: "anton" }],
  at: 0.5,
  seconds: 1,
  rate: 10,
};

describe("the font cycle", () => {
  test("a new face every step, in order, wrapping round", () => {
    expect(cycleFaceAt(CYCLE, 0.5)?.font).toBe("caveat");
    expect(cycleFaceAt(CYCLE, 0.6)?.font).toBe("anton");
    expect(cycleFaceAt(CYCLE, 0.75)?.font).toBe("caveat");
  });

  test("the title keeps its own face outside the run", () => {
    expect(cycleFaceAt(CYCLE, 0.4)).toBeNull();
    expect(cycleFaceAt(CYCLE, 1.5)).toBeNull();
    const o = title(CYCLE);
    expect(withFontCycle(o, 0.2)).toBe(o);
  });

  test("a face sets the font, weight, size and keeps what it leaves out", () => {
    const set = withFontCycle(title(CYCLE), 0.52);
    expect(set.font).toBe("caveat");
    expect(set.weight).toBe(400);
    expect(set.size).toBe(100);
    expect(set.letterSpacing).toBe(0.3);
    // The face carries no cycle, so resolving it again changes nothing.
    expect(withFontCycle(set, 0.62)).toBe(set);
    expect(withFontCycle(title(CYCLE), 0.62).weight).toBe(700);
  });

  test("samplers cut at every face change and the run's end", () => {
    expect(fontCycleCuts(title(CYCLE), 2)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
    expect(cutAtFaces([{ start: 0, end: 2 }], [0.5, 1.5])).toEqual([
      { start: 0, end: 0.5 },
      { start: 0.5, end: 1.5 },
      { start: 1.5, end: 2 },
    ]);
  });

  test("a sampler sees every face, tagged apart from the title's own", () => {
    expect(fontCycleVariants(title(CYCLE)).map((v) => v.font)).toEqual(["caveat", "anton"]);
    expect(cycleFaceTag(title(CYCLE), 0.65)).toBe("|face1");
    expect(cycleFaceTag(title(CYCLE), 0.1)).toBe("");
    expect(fontCycleCuts(title(), 2)).toEqual([]);
  });

  test("a face's hold sets its own step, so the changes land on the beat", () => {
    const held = {
      faces: [{ font: "caveat", hold: 0.25 }, { font: "anton", italic: true }, { font: "bebas", hold: 0.05 }],
      at: 0.5,
      seconds: 1,
      rate: 10,
    };
    expect(cycleFaceAt(held, 0.5)?.font).toBe("caveat");
    expect(cycleFaceAt(held, 0.74)?.font).toBe("caveat");
    expect(cycleFaceAt(held, 0.75)?.font).toBe("anton");
    expect(cycleFaceAt(held, 0.85)?.font).toBe("bebas");
    expect(cycleFaceAt(held, 0.9)?.font).toBe("caveat");
    expect(withFontCycle(title(held), 0.8).italic).toBe(true);
    expect(withFontCycle(title(held), 0.6).italic).toBeUndefined();
    expect(fontCycleCuts(title(held), 2)).toEqual([0.5, 0.75, 0.85, 0.9, 1.15, 1.25, 1.3, 1.5]);
    expect(fontCycleVariants(title(held)).map((v) => v.font)).toEqual(["caveat", "anton", "bebas"]);
  });

  test("the canvas and ffmpeg exports change face at the held steps", async () => {
    const held = { faces: [{ font: "caveat", hold: 0.25 }, { font: "anton" }, { font: "bebas", hold: 0.05 }], at: 0.5, seconds: 1, rate: 10 };
    const o = title(held);
    const cuts = [0.5, 0.75, 0.85, 0.9, 1.15, 1.25, 1.3, 1.5].map((t) => +(o.start + t).toFixed(3));
    const layers = planAnimatedLayers(o, 10);
    const starts = layers.map((l) => +l.start.toFixed(3));
    for (const c of cuts) expect(starts.includes(c)).toBe(true);
    expect((layers.find((l) => Math.abs(l.start - 2.75) < 1e-6)?.overlay as TextOverlay | undefined)?.font).toBe("anton");
    const env: RenderEnv = {
      fontStack: () => "Arial",
      createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
      canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
    };
    const set = await renderOverlayFrames(o, 270, 480, 30, env);
    let t = o.start;
    const edges = set.entries.map((e) => +(t += e.duration).toFixed(3));
    for (const c of cuts) expect(edges.includes(c)).toBe(true);
  });
});

describe("a face keeps the title's own lines", () => {
  // A one-line title whose cycle shows a wide face at 1.6×: in that face the
  // line is wider than the room the title wraps in, and it must stay one line,
  // set smaller, rather than break in two over whatever sits above it.
  const wide = { faces: [{ font: "wide", scale: 1.6 }], at: 0, seconds: 1, rate: 10 };
  const travel = (): TextOverlay => ({ ...title(wide), text: "TRAVEL DESTINATION", size: 60, letterSpacing: 0, start: 0, end: 2 });
  /** Advance per character: the title's own face 0.6 em, the wide one 0.9 em. */
  const measure = (type: Pick<TextOverlay, "font" | "size" | "letterSpacing">, line: string) =>
    line.length * type.size * ((type.font === "wide" ? 0.9 : 0.6) + (type.letterSpacing ?? 0));
  const room = textRoom(0.5, 1080);

  test("a face too wide for the room shrinks to it and keeps the line whole", () => {
    const own = travel();
    expect(measure(own, own.text)).toBeLessThan(room);
    const face = settleCycleFace(withFontCycle(own, 0.5), room, measure);
    expect(face.font).toBe("wide");
    expect(face.text).toBe("TRAVEL DESTINATION");
    expect(measure(face, face.text)).toBeLessThanOrEqual(room);
    expect(face.size).toBeLessThan(60 * 1.6);
  });

  test("a face that fits keeps its size, and the title's own breaks stay where they were", () => {
    const own = { ...travel(), text: "WELCOME TO\nTRAVEL DESTINATION", size: 30 };
    const face = settleCycleFace(withFontCycle(own, 0.5), room, measure);
    expect(face.text).toBe("WELCOME TO\nTRAVEL DESTINATION");
    expect(face.size).toBe(48);
    // A title broken by its own room keeps those breaks in a narrower face too.
    const long = { ...travel(), text: "A VERY LONG TITLE THAT BREAKS IN ITS OWN FACE", size: 60 };
    const ownLines = settleCycleFace({ ...long, cycleOwn: { font: long.font, weight: long.weight, size: long.size, letterSpacing: 0 } }, room, measure).text;
    const narrow = settleCycleFace(withFontCycle({ ...long, anim: { fonts: { ...wide, faces: [{ font: "narrow", scale: 0.6 }] } } }, 0.5), room, measure);
    expect(narrow.text).toBe(ownLines);
  });

  test("the canvas and ffmpeg exports draw the wide face on one line", async () => {
    const env: RenderEnv = {
      fontStack: () => "Arial",
      createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
      canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
    };
    const o: TextOverlay = { ...travel(), font: "own", anim: { fonts: { faces: [{ font: "own", scale: 1.6 }], at: 0, seconds: 1, rate: 10 } } };
    const set = await renderOverlayFrames(o, 270, 480, 30, env);
    // The bands of rows with ink in a picture: one per line of type.
    const bands = async (blob: Blob) => {
      const img = await loadImage(Buffer.from(await blob.arrayBuffer()));
      const c = new Canvas(img.width, img.height);
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      let inked = false;
      for (let y = 0; y < img.height; y++) {
        let row = false;
        for (let x = 0; x < img.width && !row; x++) row = data[(y * img.width + x) * 4 + 3] > 40;
        if (row && !inked) n++;
        inked = row;
      }
      return n;
    };
    // The first picture is the cycle's face, the last the title's own.
    expect(await bands(set.images[set.entries[0].image])).toBe(1);
    expect(await bands(set.images[set.entries[set.entries.length - 1].image])).toBe(1);
  });
});
