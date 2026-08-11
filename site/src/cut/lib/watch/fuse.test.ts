import { describe, expect, test } from "bun:test";

import { fuseTimeline, renderFusedTimeline } from "./fuse";

const cue = (start: number, end: number, text: string) => ({ start, end, text });

describe("fuseTimeline", () => {
  test("frames land inside their speech span", () => {
    const spans = fuseTimeline(
      [1, 3.5, 9],
      [cue(0.5, 4, "hello there"), cue(8, 10, "and goodbye")],
      { from: 0, to: 12 }
    );
    const speech = spans.filter((s) => s.text);
    expect(speech[0].frames).toEqual([1, 3.5]);
    expect(speech[1].frames).toEqual([9]);
  });

  test("a long silence becomes its own span; a short gap does not", () => {
    const spans = fuseTimeline([5], [cue(0, 4, "a"), cue(4.5, 8, "b"), cue(11, 12, "c")], {
      from: 0,
      to: 12,
    });
    // 4→4.5 is under the minimum; 8→11 earns a silence span holding no text.
    expect(spans.map((s) => s.text ?? null)).toEqual(["a", "b", null, "c"]);
    expect(spans[2].start).toBe(8);
    expect(spans[2].end).toBe(11);
  });

  test("cues clip to the watched range and empty cues drop", () => {
    const spans = fuseTimeline([], [cue(0, 20, "long"), cue(2, 3, "  ")], { from: 5, to: 10 });
    expect(spans.length).toBe(1);
    expect(spans[0].start).toBe(5);
    expect(spans[0].end).toBe(10);
    expect(spans[0].text).toBe("long");
  });

  test("no cues yields one frame-only span over the range", () => {
    const spans = fuseTimeline([2, 4], [], { from: 0, to: 6 });
    expect(spans.length).toBe(1);
    expect(spans[0].frames).toEqual([2, 4]);
  });

  test("a frame in a crack attaches to the closest span", () => {
    // Overlapping cues leave 4→5 unclaimed by the sweep; 4.9 sits nearest the
    // second cue's span.
    const spans = fuseTimeline([4.9], [cue(0, 4, "a"), cue(5, 8, "b")], { from: 0, to: 8 });
    const b = spans.find((s) => s.text === "b")!;
    expect(b.frames).toEqual([4.9]);
  });
});

describe("renderFusedTimeline", () => {
  test("spans render on one clock with their frames", () => {
    const out = renderFusedTimeline(
      fuseTimeline([1, 6], [cue(0.5, 4, "hello")], { from: 0, to: 8 })
    );
    expect(out).toBe('[0.5s–4s] "hello"  frames: 1s\n[4s–8s] (no speech)  frames: 6s');
  });

  test("spans with nothing to say render nothing", () => {
    expect(renderFusedTimeline(fuseTimeline([], [], { from: 0, to: 8 }))).toBe("");
  });
});
