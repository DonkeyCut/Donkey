import { describe, expect, test } from "bun:test";
import { BREATH, REACH, refineEdge, type SilenceSpan } from "./cutRefine";

/**
 * Edges refine against detected silence: speech runs everywhere a span
 * doesn't. The spans here draw a take with pauses at known places, and each
 * case asks where a model-made edge should really sit.
 */

const spans: SilenceSpan[] = [
  { start: 0, end: 1 }, // lead-in silence
  { start: 4, end: 5 }, // pause between sentences
  { start: 9, end: 9.3 }, // a short breath
  { start: 12, end: 20 }, // long trailing silence
];

describe("out edges (a clip's end)", () => {
  test("an edge inside a pause settles a breath past the speech", () => {
    expect(refineEdge(spans, 4.8, "out")).toEqual({ t: 4 + BREATH, pause: true });
  });

  test("an edge clipping a word moves outward to the next pause", () => {
    expect(refineEdge(spans, 3.6, "out")).toEqual({ t: 4 + BREATH, pause: true });
  });

  test("a pause shorter than a breath still holds the cut at its far side", () => {
    expect(refineEdge(spans, 9.1, "out")).toEqual({ t: 9.25, pause: true });
  });

  test("continuous speech leaves the edge alone, flagged", () => {
    expect(refineEdge([{ start: 0, end: 1 }], 6, "out")).toEqual({ t: 6, pause: false });
  });

  test("a long pause tightens only within reach", () => {
    expect(refineEdge(spans, 19, "out")).toEqual({ t: 19 - REACH, pause: true });
  });
});

describe("in edges (a clip's start)", () => {
  test("an edge inside a pause settles a breath ahead of the speech", () => {
    expect(refineEdge(spans, 4.2, "in")).toEqual({ t: 5 - BREATH, pause: true });
  });

  test("an edge clipping a lead word moves back to the pause before it", () => {
    expect(refineEdge(spans, 5.4, "in")).toEqual({ t: 5 - BREATH, pause: true });
  });

  test("an edge at the source head trims the lead-in to a breath", () => {
    expect(refineEdge(spans, 0, "in")).toEqual({ t: 1 - BREATH, pause: true });
  });

  test("continuous speech leaves the edge alone, flagged", () => {
    expect(refineEdge(spans, 7.5, "in")).toEqual({ t: 7.5, pause: false });
  });

  test("a pause further back than reach does not pull the edge", () => {
    expect(refineEdge([{ start: 0, end: 1 }], 3.5, "in")).toEqual({ t: 3.5, pause: false });
  });
});
