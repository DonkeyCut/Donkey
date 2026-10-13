import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { cutAtFaces, cycleFaceAt, cycleFaceTag, fontCycleCuts, fontCycleVariants, withFontCycle } from "./fontCycle";
import { planAnimatedLayers, renderOverlayFrames, type RenderEnv } from "./render";
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
