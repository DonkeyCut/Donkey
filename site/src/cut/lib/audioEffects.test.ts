import { describe, expect, test } from "bun:test";
import { audioFxSpans, audioFxWetAt, hasAudioEffects, liveAudioFxAt } from "./audioEffects";
import type { Overlay } from "./types";

const fx = (over: Partial<Overlay> & { effect: string }): Overlay =>
  ({
    id: over.effect,
    kind: "effect",
    x: 0.5,
    y: 0.5,
    start: 0,
    end: 2,
    ...over,
  }) as Overlay;

describe("audioFxSpans", () => {
  test("picks the audio effects out of the element list, in timeline order", () => {
    const spans = audioFxSpans([
      fx({ effect: "echo", start: 4, end: 6 }),
      fx({ effect: "vignette", start: 0, end: 2 }),
      fx({ effect: "muffle", start: 1, end: 3 }),
      { id: "t", kind: "text", text: "hi", start: 0, end: 2, x: 0.5, y: 0.5 } as Overlay,
    ]);
    expect(spans.map((s) => s.effect)).toEqual(["muffle", "echo"]);
  });

  test("a hidden effect treats nothing", () => {
    expect(audioFxSpans([fx({ effect: "echo", hidden: true })])).toEqual([]);
  });

  test("clips to the cut's length and drops what falls outside it", () => {
    const spans = audioFxSpans(
      [fx({ effect: "echo", start: 1, end: 9 }), fx({ effect: "crush", start: 6, end: 8 })],
      5
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].end).toBe(5);
  });

  test("hasAudioEffects answers for the doc, picture effects aside", () => {
    expect(hasAudioEffects([fx({ effect: "grain" })])).toBe(false);
    expect(hasAudioEffects([fx({ effect: "grain" }), fx({ effect: "reverb" })])).toBe(true);
  });
});

describe("audioFxWetAt", () => {
  const span = { id: "a", effect: "echo" as const, start: 2, end: 6 };

  test("full through the window, silent outside it", () => {
    expect(audioFxWetAt(span, 4)).toBe(1);
    expect(audioFxWetAt(span, 0)).toBe(0);
    expect(audioFxWetAt(span, 9)).toBe(0);
  });

  test("crosses over at the edges rather than switching", () => {
    expect(audioFxWetAt(span, 2)).toBeCloseTo(0.5, 5);
    expect(audioFxWetAt(span, 6)).toBeCloseTo(0.5, 5);
    expect(audioFxWetAt(span, 1.99)).toBeGreaterThan(0);
    expect(audioFxWetAt(span, 1.99)).toBeLessThan(0.5);
  });

  test("a window shorter than the ramp still reaches full and comes back", () => {
    const brief = { id: "b", effect: "echo" as const, start: 1, end: 1.02 };
    expect(audioFxWetAt(brief, 1.01)).toBeGreaterThan(0.5);
    expect(audioFxWetAt(brief, 0.9)).toBe(0);
    expect(audioFxWetAt(brief, 1.2)).toBe(0);
  });
});

describe("liveAudioFxAt", () => {
  const doc = [
    fx({ effect: "echo", start: 0, end: 2 }),
    fx({ effect: "muffle", start: 10, end: 12 }),
  ];

  test("carries the effects near the playhead, so a chain joins while silent", () => {
    const live = liveAudioFxAt(doc, 2.3);
    expect(live.map((l) => l.span.effect)).toEqual(["echo"]);
    expect(live[0].wet).toBe(0);
  });

  test("leaves the far ones out entirely", () => {
    expect(liveAudioFxAt(doc, 5)).toEqual([]);
  });

  test("reports the level the window puts each one at", () => {
    expect(liveAudioFxAt(doc, 1)[0].wet).toBe(1);
  });
});
