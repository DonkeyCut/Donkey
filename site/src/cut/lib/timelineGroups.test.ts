import { describe, expect, test } from "bun:test";
import type { ItemLists } from "./itemKinds";
import { createSelectedGroupSelector } from "./timelineGroups";
import type { Selection } from "./types";

const empty = (): ItemLists & { multiSelection: Selection[] } => ({
  clips: [], audioClips: [], overlays: [], transitions: [], subtitles: { cues: [] }, multiSelection: [],
});

describe("group toolbar selector", () => {
  test("updates after grouping, ungrouping, selection changes and document replacement", () => {
    const select = createSelectedGroupSelector();
    const s = empty();
    s.subtitles.cues = [{ id: "caption", start: 0, end: 2, text: "Hello" }];
    s.multiSelection = [{ kind: "cue", id: "caption" }];
    expect(select(s)).toBe(false);
    const grouped = { ...s, subtitles: { cues: [{ ...s.subtitles.cues[0], groupId: "g" }] } };
    expect(select(grouped)).toBe(true);
    expect(select({ ...grouped, multiSelection: [] })).toBe(false);
    expect(select(grouped)).toBe(true);
    expect(select(s)).toBe(false);
    expect(select({ ...empty(), multiSelection: s.multiSelection })).toBe(false);
  });

  test("detects selected groups across item kinds and ignores unselected groups", () => {
    const select = createSelectedGroupSelector();
    const s = empty();
    s.clips = [{ id: "same-id", assetId: "v", track: 0, start: 0, in: 0, out: 2, muted: false, groupId: "g" }];
    s.subtitles.cues = [{ id: "same-id", start: 0, end: 2, text: "Hello" }];
    s.multiSelection = [{ kind: "cue", id: "same-id" }];
    expect(select(s)).toBe(false);
    expect(select({ ...s, multiSelection: [...s.multiSelection, { kind: "clip", id: "same-id" }] })).toBe(true);
  });

  test("a large selection is scanned once and unrelated updates reuse the result", () => {
    let reads = 0;
    const s = empty();
    s.subtitles.cues = Array.from({ length: 10_000 }, (_, i) => ({
      id: String(i), start: i, end: i + 1, text: "Caption",
      get groupId() { reads++; return undefined; },
    }));
    s.multiSelection = s.subtitles.cues.map((cue) => ({ kind: "cue", id: cue.id }));
    const select = createSelectedGroupSelector();
    expect(select(s)).toBe(false);
    expect(reads).toBe(10_000);
    for (let i = 0; i < 100; i++) expect(select({ ...s })).toBe(false);
    expect(reads).toBe(10_000);
    // A change on an unselected row must not rescan the captions.
    expect(select({ ...s, clips: [{ id: "video", assetId: "v", start: 0, track: 0, in: 0, out: 2, muted: false }] })).toBe(false);
    expect(reads).toBe(10_000);
  });
});
