import { describe, expect, test } from "bun:test";
import { cutAtFaces, cycleFaceAt, cycleFaceTag, fontCycleCuts, fontCycleVariants, withFontCycle } from "./fontCycle";
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
});
