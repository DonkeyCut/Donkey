import { describe, expect, test } from "bun:test";
import { srtOf, subtitleFiles } from "./subtitleFile";
import type { SubtitleCue, SubtitlesBlock } from "./types";

const cue = (id: string, start: number, end: number, text: string, lane?: number): SubtitleCue => ({
  id,
  start,
  end,
  text,
  ...(lane !== undefined ? { lane } : {}),
});

const block = (cues: SubtitleCue[], over: Partial<SubtitlesBlock> = {}): SubtitlesBlock =>
  ({ cues, showOnVideo: true, showOnTimeline: true, ...over }) as SubtitlesBlock;

describe("srtOf", () => {
  test("numbers cues in time order with comma milliseconds", () => {
    const srt = srtOf([cue("b", 61.5, 63.25, "second"), cue("a", 0, 1.2, "first")]);
    expect(srt).toBe(
      ["1", "00:00:00,000 --> 00:00:01,200", "first", "", "2", "00:01:01,500 --> 00:01:03,250", "second", ""].join("\n")
    );
  });

  test("a range keeps the cues inside it, timed from its start, cut at its edges", () => {
    const srt = srtOf(
      [cue("a", 0, 2, "before"), cue("b", 4, 7, "across"), cue("c", 8, 9, "inside"), cue("d", 12, 13, "after")],
      { start: 5, end: 10 }
    );
    expect(srt).toBe(
      ["1", "00:00:00,000 --> 00:00:02,000", "across", "", "2", "00:00:03,000 --> 00:00:04,000", "inside", ""].join("\n")
    );
  });

  test("skips empty text", () => {
    expect(srtOf([cue("a", 0, 1, "  ")])).toBe("");
  });
});

describe("subtitleFiles", () => {
  test("one file per visible track, named by language when there are several", () => {
    const subs = block(
      [cue("a", 0, 1, "hi", 0), cue("b", 0, 1, "안녕", 1), cue("c", 0, 1, "hola", 2)],
      { tracks: [{ locale: "en-US" }, { locale: "ko-KR" }, { locale: "es-ES", hidden: true }] }
    );
    expect(subtitleFiles(subs, "Cut").map((f) => f.name)).toEqual(["Cut.en-US.srt", "Cut.ko-KR.srt"]);
  });

  test("a single track takes the plain name", () => {
    expect(subtitleFiles(block([cue("a", 0, 1, "hi")]), "Cut").map((f) => f.name)).toEqual(["Cut.srt"]);
  });

  test("nothing to write is no file", () => {
    expect(subtitleFiles(block([cue("a", 0, 1, "hi")]), "Cut", { start: 5, end: 6 })).toEqual([]);
  });
});
