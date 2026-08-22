import { describe, expect, test } from "bun:test";
import { hasOverlayAnim } from "./anim";
import type { TextOverlay } from "./types";
import {
  applyWordAccent,
  displayWords,
  wordAccent,
  WORD_ACCENT_DEFAULT,
  wordAccentIndex,
  wordSwell,
  WORD_POP_SCALE,
  WORD_SWELL_MAX,
  wordWindows,
} from "./words";

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

describe("word emphasis", () => {
  const words = { style: "pop" as const, color: "#FF3D00" };

  test("counts as animation, so both renderers take the moving path", () => {
    expect(hasOverlayAnim({ words })).toBe(true);
    expect(hasOverlayAnim({})).toBe(false);
  });

  test("marks the word being said", () => {
    const o = title({ anim: { words } });
    expect(wordAccentIndex(o, 0, 3)).toBe(0);
    expect(wordAccentIndex(o, 2.9, 3)).toBe(2);
  });

  test("is a title's slot; other kinds ignore it", () => {
    const sticker = { ...title({ anim: { words } }), kind: "sticker" as const, w: 0.2 };
    expect(wordAccentIndex(sticker as never, 0, 3)).toBe(-1);
  });

  test("paints through the same highlight fields captions ride", () => {
    const marked = applyWordAccent(title({ anim: { words } }), 1) as TextOverlay;
    expect(marked.highlightWord).toBe(1);
    expect(marked.highlightMode).toBe("pop");
    expect(marked.highlightColor).toBe("#FF3D00");
    expect(marked.highlightText).toBe("#FFFFFF");
    expect(marked.highlightScale).toBe(WORD_POP_SCALE);
  });

  test("a swell keeps the line's own color; the color treatments take the accent", () => {
    const swelled = applyWordAccent(
      title({ color: "#FFFFFF", anim: { words: { style: "pop" } } }),
      0
    ) as TextOverlay;
    expect(swelled.highlightColor).toBe("#FFFFFF");
    const boxed = applyWordAccent(
      title({ color: "#FFFFFF", anim: { words: { style: "box" } } }),
      0
    ) as TextOverlay;
    expect(boxed.highlightColor).toBe(WORD_ACCENT_DEFAULT);
    expect(wordAccent({ style: "pop", color: "#0A84FF" }, "#FFFFFF")).toBe("#0A84FF");
  });

  test("swells by the treatment's default until something says otherwise", () => {
    expect(wordSwell({ style: "pop" })).toBe(WORD_POP_SCALE);
    expect(wordSwell({ style: "box" })).toBe(1);
    expect(wordSwell({ style: "box", scale: 1.5 })).toBe(1.5);
    expect(wordSwell(undefined)).toBe(1);
  });

  test("holds the swell inside its bounds", () => {
    expect(wordSwell({ style: "pop", scale: 9 })).toBe(WORD_SWELL_MAX);
    expect(wordSwell({ style: "pop", scale: 0.2 })).toBe(1);
    expect(wordSwell({ style: "pop", scale: Number.NaN })).toBe(WORD_POP_SCALE);
  });

  test("an element with no emphasis rides through untouched", () => {
    const o = title();
    expect(applyWordAccent(o, 1)).toBe(o);
  });
});
