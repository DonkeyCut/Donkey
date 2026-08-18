import { describe, expect, test } from "bun:test";

import { mergeSpeech, mergeWatch, mergeWatchNotes, nextUncoveredSpan, uncoveredSeconds, unnotedSpans } from "./merge";
import type { AssetWatch } from "../types";

const frame = (t: number, via: AssetWatch["frames"][number]["via"] = "global") => ({ t, via });

describe("mergeWatch", () => {
  test("a first watch records its span, frames, and cuts", () => {
    const w = mergeWatch(undefined, {
      from: 0,
      to: 10,
      frames: [frame(0, "first"), frame(4.128)],
      sceneChanges: [4.128],
    });
    expect(w.ranges).toEqual([{ from: 0, to: 10 }]);
    expect(w.frames).toEqual([frame(0, "first"), frame(4.13)]);
    expect(w.sceneChanges).toEqual([4.13]);
  });

  test("re-watching a span replaces what it covered", () => {
    const first = mergeWatch(undefined, {
      from: 0,
      to: 10,
      frames: [frame(0, "first"), frame(4), frame(9)],
      sceneChanges: [4],
    });
    const again = mergeWatch(first, { from: 3, to: 10, frames: [frame(5)], sceneChanges: [] });
    expect(again.ranges).toEqual([{ from: 0, to: 10 }]);
    expect(again.frames).toEqual([frame(0, "first"), frame(5)]);
    expect(again.sceneChanges).toEqual([]);
  });

  test("a new span extends coverage and keeps old frames sorted in", () => {
    const first = mergeWatch(undefined, { from: 20, to: 30, frames: [frame(25)], sceneChanges: [] });
    const both = mergeWatch(first, { from: 0, to: 10, frames: [frame(5)], sceneChanges: [] });
    expect(both.ranges).toEqual([
      { from: 0, to: 10 },
      { from: 20, to: 30 },
    ]);
    expect(both.frames).toEqual([frame(5), frame(25)]);
  });

  test("touching spans fuse into one", () => {
    const first = mergeWatch(undefined, { from: 0, to: 10, frames: [], sceneChanges: [] });
    const fused = mergeWatch(first, { from: 10, to: 20, frames: [], sceneChanges: [] });
    expect(fused.ranges).toEqual([{ from: 0, to: 20 }]);
  });

  test("merging leaves the previous record untouched", () => {
    const first = mergeWatch(undefined, { from: 0, to: 10, frames: [frame(4)], sceneChanges: [4] });
    mergeWatch(first, { from: 5, to: 20, frames: [], sceneChanges: [] });
    expect(first.ranges).toEqual([{ from: 0, to: 10 }]);
    expect(first.frames).toEqual([frame(4)]);
  });
});

describe("mergeSpeech", () => {
  const seg = (start: number, end: number, text = "words") => ({ start, end, text });

  test("chunks accumulate in order and empty text drops", () => {
    const a = mergeSpeech(undefined, { from: 0, to: 120, segments: [seg(3, 5), seg(8, 9, "  ")] }, 300);
    const b = mergeSpeech(a, { from: 120, to: 240, segments: [seg(130, 133)] }, 300);
    expect(b.ranges).toEqual([{ from: 0, to: 240 }]);
    expect(b.segments).toEqual([seg(3, 5), seg(130, 133)]);
    expect(b.noSpeech).toBeUndefined();
  });

  test("re-transcribing a span replaces its segments", () => {
    const a = mergeSpeech(undefined, { from: 0, to: 120, segments: [seg(3, 5, "old")] }, 300);
    const b = mergeSpeech(a, { from: 0, to: 120, segments: [seg(3, 5, "new")] }, 300);
    expect(b.segments).toEqual([seg(3, 5, "new")]);
  });

  test("silence settles as a verdict only once the whole source is covered", () => {
    const half = mergeSpeech(undefined, { from: 0, to: 150, segments: [] }, 300);
    expect(half.noSpeech).toBeUndefined();
    const all = mergeSpeech(half, { from: 150, to: 300, segments: [] }, 300);
    expect(all.noSpeech).toBe(true);
  });

  test("the locale rides along", () => {
    const a = mergeSpeech(undefined, { from: 0, to: 100, segments: [], locale: "de-DE" }, 300);
    expect(mergeSpeech(a, { from: 100, to: 200, segments: [] }, 300).locale).toBe("de-DE");
  });
});

describe("nextUncoveredSpan", () => {
  test("an unwatched source starts at zero, capped at the segment size", () => {
    expect(nextUncoveredSpan(undefined, 2000, 600)).toEqual({ from: 0, to: 600 });
  });

  test("coverage from zero continues where it stopped", () => {
    const w = mergeWatch(undefined, { from: 0, to: 600, frames: [], sceneChanges: [] });
    expect(nextUncoveredSpan(w, 900, 600)).toEqual({ from: 600, to: 900 });
  });

  test("a gap before the coverage is filled first, ending at the covered part", () => {
    const w = mergeWatch(undefined, { from: 100, to: 300, frames: [], sceneChanges: [] });
    expect(nextUncoveredSpan(w, 400, 600)).toEqual({ from: 0, to: 100 });
  });

  test("full coverage and tail slivers report done", () => {
    const w = mergeWatch(undefined, { from: 0, to: 599, frames: [], sceneChanges: [] });
    expect(nextUncoveredSpan(w, 600, 600)).toBe(null);
    expect(nextUncoveredSpan(mergeWatch(undefined, { from: 0, to: 600, frames: [], sceneChanges: [] }), 600, 600)).toBe(null);
  });
});

describe("watch notes", () => {
  const note = (from: number, to: number, text: string) => ({ from, to, text });

  test("notes land sorted and empty ones are dropped", () => {
    const w = mergeWatchNotes(undefined, [
      note(30, 60, "the diagram builds"),
      note(0, 30, "opening cards"),
      note(60, 70, "   "),
    ]);
    expect(w.notes).toEqual([note(0, 30, "opening cards"), note(30, 60, "the diagram builds")]);
  });

  test("a closer note replaces the coarse one it covers", () => {
    const coarse = mergeWatchNotes(undefined, [note(0, 60, "titles over b-roll")]);
    const close = mergeWatchNotes(coarse, [
      note(0, 30, 'card: "Yo, I got a Mil in $ idea"'),
      note(30, 60, 'card: "Right?"'),
    ]);
    expect(close.notes).toEqual([
      note(0, 30, 'card: "Yo, I got a Mil in $ idea"'),
      note(30, 60, 'card: "Right?"'),
    ]);
  });

  test("notes outlive a re-watch of the same span", () => {
    const noted = mergeWatchNotes(
      mergeWatch(undefined, { from: 0, to: 10, frames: [], sceneChanges: [] }),
      [note(0, 10, "the hook")]
    );
    const again = mergeWatch(noted, { from: 0, to: 10, frames: [], sceneChanges: [] });
    expect(again.notes).toEqual([note(0, 10, "the hook")]);
  });

  test("what is still undescribed reads off the notes", () => {
    const w = mergeWatchNotes(undefined, [note(0, 30, "opening"), note(60, 90, "the pitch")]);
    expect(unnotedSpans(w, 120)).toEqual([
      { from: 30, to: 60 },
      { from: 90, to: 120 },
    ]);
    expect(unnotedSpans(mergeWatchNotes(w, [note(30, 120, "the rest")]), 120)).toEqual([]);
  });
});

describe("uncoveredSeconds", () => {
  test("a watch aimed at the middle counts the head it skipped", () => {
    const w = mergeWatch(undefined, { from: 120, to: 600, frames: [], sceneChanges: [] });
    expect(uncoveredSeconds(w, 600)).toBe(120);
  });

  test("overlapping spans count once", () => {
    const w = mergeWatch(mergeWatch(undefined, { from: 0, to: 60, frames: [], sceneChanges: [] }), {
      from: 30,
      to: 90,
      frames: [],
      sceneChanges: [],
    });
    expect(uncoveredSeconds(w, 100)).toBe(10);
  });

  test("nothing watched is the whole source", () => {
    expect(uncoveredSeconds(undefined, 64.1)).toBe(64.1);
  });
});
