import { describe, expect, test } from "bun:test";
import { hasOverlayAnim } from "../anim";
import type { TextOverlay } from "../types";
import {
  applyWordDraw,
  displayWords,
  mixHex,
  wordAccent,
  WORD_ACCENT_DEFAULT,
  wordDim,
  wordDrawsAt,
  wordEffect,
  WORD_EFFECT_IDS,
  wordKnobs,
  WORD_POP_SCALE,
  wordSampleWindows,
  wordSwell,
  WORD_SWELL_MAX,
  wordWindows,
} from ".";

const title = (over: Partial<TextOverlay> = {}): TextOverlay => ({
  id: "t1",
  kind: "text",
  text: "one two three",
  start: 2,
  end: 5,
  x: 0.5,
  y: 0.5,
  size: 64,
  font: "sf",
  weight: 700,
  color: "#FFFFFF",
  shadow: true,
  plate: false,
  ...over,
});

describe("word windows", () => {
  test("cover the span end to end with no gaps", () => {
    const wins = wordWindows("one two three", 3);
    expect(wins.length).toBe(3);
    expect(wins[0].start).toBe(0);
    expect(wins[2].end).toBe(3);
    for (let i = 1; i < wins.length; i++) expect(wins[i].start).toBe(wins[i - 1].end);
  });

  test("follow measured onsets when they match the words", () => {
    const wins = wordWindows("one two three", 3, [0, 1.2, 2.4]);
    expect(wins.map((w) => w.start)).toEqual([0, 1.2, 2.4]);
    expect(wins[2].end).toBe(3);
  });

  test("fall back to an even share when the text has outgrown the times", () => {
    const wins = wordWindows("one two three four", 4, [0, 1.2, 2.4]);
    expect(wins.length).toBe(4);
    expect(wins[0].start).toBe(0);
  });

  test("never run backwards", () => {
    const wins = wordWindows("one two three", 3, [0, 2.5, 1]);
    expect(wins[2].start).toBeGreaterThanOrEqual(wins[1].start);
  });

  test("count words across lines", () => {
    expect(displayWords("one two\nthree")).toEqual(["one", "two", "three"]);
  });
});

describe("the catalog", () => {
  test("every effect names its family and settles its three poses", () => {
    for (const id of WORD_EFFECT_IDS) {
      const e = wordEffect(id);
      expect(["emphasis", "build"]).toContain(e.family);
      expect(e.attack).toBeGreaterThanOrEqual(0);
      expect(e.release).toBeGreaterThanOrEqual(0);
    }
  });

  test("an emphasis returns to where it started; a build keeps what it did", () => {
    expect(wordEffect("color").after).toEqual(wordEffect("color").before);
    expect(wordEffect("build").after).toEqual(wordEffect("build").active);
  });

  test("an unknown id falls back rather than throwing", () => {
    expect(wordEffect("nope").label).toBe(wordEffect("color").label);
  });

  test("offers the knobs an effect actually uses", () => {
    expect(wordKnobs(wordEffect("pop"))).toEqual({ size: true, color: true, dim: false });
    expect(wordKnobs(wordEffect("build"))).toEqual({ size: false, color: false, dim: true });
  });
});

describe("word effects", () => {
  const words = { style: "pop", color: "#FF3D00" };

  test("count as animation, so both renderers take the moving path", () => {
    expect(hasOverlayAnim({ words })).toBe(true);
    expect(hasOverlayAnim({})).toBe(false);
  });

  test("mark the word being said and leave the rest alone", () => {
    const draws = wordDrawsAt("one two three", words, "#FFFFFF", 3, 0);
    expect(draws[0].color).toBe("#FF3D00");
    expect(draws[0].scale).toBe(WORD_POP_SCALE);
    expect(draws[1].color).toBe("#FFFFFF");
    expect(draws[1].scale).toBe(1);
  });

  test("are a title's slot; other kinds ride through untouched", () => {
    const sticker = { ...title({ anim: { words } }), kind: "sticker" as const, w: 0.2 };
    expect(applyWordDraw(sticker as never, 0, 3)).toBe(sticker);
  });

  test("stamp one entry per display word", () => {
    const marked = applyWordDraw(title({ anim: { words } }), 1.5, 3) as TextOverlay;
    expect(marked.wordDraw?.length).toBe(3);
  });

  test("a swell keeps the line's own color; the color treatments take the accent", () => {
    expect(wordAccent({ style: "pop" }, "#FFFFFF")).toBe("#FFFFFF");
    expect(wordAccent({ style: "box" }, "#FFFFFF")).toBe(WORD_ACCENT_DEFAULT);
    expect(wordAccent({ style: "pop", color: "#0A84FF" }, "#FFFFFF")).toBe("#0A84FF");
  });

  test("a box puts contrast text on the word so it reads against its own fill", () => {
    const draws = wordDrawsAt("one two", { style: "box", color: "#FFE94A" }, "#FFFFFF", 2, 0);
    expect(draws[0].mark).toBe("box");
    expect(draws[0].markColor).toBe("#FFE94A");
    expect(draws[0].color).toBe("#111114");
  });

  test("swell by the effect's default until something says otherwise", () => {
    expect(wordSwell({ style: "pop" })).toBe(WORD_POP_SCALE);
    expect(wordSwell({ style: "box" })).toBe(1);
    expect(wordSwell({ style: "box", scale: 1.5 })).toBe(1.5);
    expect(wordSwell(undefined)).toBe(1);
  });

  test("hold the swell inside its bounds", () => {
    expect(wordSwell({ style: "pop", scale: 9 })).toBe(WORD_SWELL_MAX);
    expect(wordSwell({ style: "pop", scale: 0.2 })).toBe(1);
    expect(wordSwell({ style: "pop", scale: Number.NaN })).toBe(WORD_POP_SCALE);
  });

  test("an element with no effect rides through untouched", () => {
    const o = title();
    expect(applyWordDraw(o, 1, 3)).toBe(o);
  });
});

describe("a build", () => {
  const words = { style: "build", times: [0, 1, 2] };
  const text = "one two three";

  test("starts with nothing up and finishes with the whole line", () => {
    const first = wordDrawsAt(text, words, "#FFFFFF", 3, 0);
    expect(first[1].opacity).toBe(0);
    expect(first[2].opacity).toBe(0);
    const last = wordDrawsAt(text, words, "#FFFFFF", 3, 2.9);
    expect(last.every((d) => d.opacity === 1)).toBe(true);
  });

  test("keeps every word it has landed", () => {
    const mid = wordDrawsAt(text, words, "#FFFFFF", 3, 1.5);
    expect(mid[0].opacity).toBe(1);
    expect(mid[1].opacity).toBe(1);
    expect(mid[2].opacity).toBe(0);
  });

  test("ramps rather than snapping", () => {
    const e = wordEffect("build");
    const mid = wordDrawsAt(text, words, "#FFFFFF", 3, 1 + e.attack / 2);
    expect(mid[1].opacity).toBeGreaterThan(0);
    expect(mid[1].opacity).toBeLessThan(1);
  });
});

describe("a fill", () => {
  const words = { style: "fill", times: [0, 1, 2] };
  const text = "one two three";

  test("leaves the whole line faintly up before its words land", () => {
    const draws = wordDrawsAt(text, words, "#FFFFFF", 3, 0);
    expect(draws[2].opacity).toBeCloseTo(wordEffect("fill").before.opacity!, 5);
    expect(draws[2].opacity).toBeGreaterThan(0);
  });

  test("takes the caller's transparency over its own", () => {
    const draws = wordDrawsAt(text, { ...words, dim: 0.6 }, "#FFFFFF", 3, 0);
    expect(draws[2].opacity).toBeCloseTo(0.6, 5);
    expect(wordDim({ style: "fill", dim: 0.6 })).toBe(0.6);
    expect(wordDim({ style: "fill" })).toBe(wordEffect("fill").before.opacity);
  });

  test("ends fully opaque all the way along", () => {
    const draws = wordDrawsAt(text, { ...words, dim: 0.6 }, "#FFFFFF", 3, 3);
    expect(draws.every((d) => d.opacity === 1)).toBe(true);
  });
});

describe("sample windows", () => {
  test("an effect that lands on the beat is one still per word", () => {
    const spans = wordSampleWindows("one two three", { style: "color" }, 3);
    expect(spans.length).toBe(3);
    expect(spans[0].start).toBe(0);
    expect(spans[2].end).toBe(3);
  });

  test("a ramping effect is cut finer, still covering the span with no gaps", () => {
    const spans = wordSampleWindows("one two three", { style: "build", times: [0, 1, 2] }, 3);
    expect(spans.length).toBeGreaterThan(3);
    expect(spans[0].start).toBe(0);
    expect(spans[spans.length - 1].end).toBe(3);
    for (let i = 1; i < spans.length; i++) expect(spans[i].start).toBe(spans[i - 1].end);
  });
});

describe("color blending", () => {
  test("runs between the two ends and stops at them", () => {
    expect(mixHex("#000000", "#FFFFFF", 0)).toBe("#000000");
    expect(mixHex("#000000", "#FFFFFF", 1)).toBe("#FFFFFF");
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });
});

describe("a saved swell", () => {
  test("lands on the word's moment even where the effect resizes nothing", () => {
    // The picker used to offer a size on every treatment, so documents carry
    // one on effects whose own poses hold their size.
    const draws = wordDrawsAt("one two", { style: "box", scale: 1.5 }, "#FFFFFF", 2, 0);
    expect(draws[0].scale).toBe(1.5);
    expect(draws[1].scale).toBe(1);
  });

  test("opens its knob wherever a value is in play", () => {
    expect(wordKnobs(wordEffect("box")).size).toBe(false);
    expect(wordKnobs(wordEffect("box"), { scale: 1.5 }).size).toBe(true);
    expect(wordKnobs(wordEffect("color"), { dim: 0.5 }).dim).toBe(true);
  });

  test("leaves a word still growing into place at the size its effect asks", () => {
    const e = wordEffect("bloom");
    const draws = wordDrawsAt("one two", { style: "bloom", times: [0, 1] }, "#FFFFFF", 2, 0.999);
    expect(draws[1].scale).toBeCloseTo(e.before.scale!, 5);
    expect(draws[1].layoutScale).toBe(1);
  });
});

describe("sample slices", () => {
  test("are bounded when the sampler asks for a cap", () => {
    const words = { style: "rise", times: [0, 1, 2] };
    const free = wordSampleWindows("one two three", words, 3);
    const capped = wordSampleWindows("one two three", words, 3, 12, 2);
    expect(capped.length).toBeLessThan(free.length);
    expect(capped.length).toBeLessThanOrEqual(9);
    expect(capped[capped.length - 1].end).toBe(3);
    for (let i = 1; i < capped.length; i++) expect(capped[i].start).toBe(capped[i - 1].end);
  });
});
