import { describe, expect, test } from "bun:test";
import { retimeOf } from "@donkeycut/effects-kit";
import { formatMark, markAt, markTime, parseMark, splitTimes, syncTimes } from "./timeMark";
import { splitTimelineItems } from "./timelineItems";
import type { AudioClip, VideoClip } from "./types";

const clip = (id: string, start: number, patch: Partial<VideoClip> = {}): VideoClip => ({
  id,
  assetId: id,
  track: 0,
  start,
  in: 0,
  out: 10,
  muted: false,
  ...patch,
});

const sound = (id: string, start: number, patch: Partial<AudioClip> = {}): AudioClip => ({
  id,
  assetId: id,
  start,
  in: 0,
  out: 20,
  volume: 1,
  ...patch,
});

/** a: 0–10, b: 10–20 on track 0. */
const cut = () => ({ clips: [clip("a", 0), clip("b", 10)] });

/** The source second the cut actually shows at `t`. */
function frameAt(s: { clips: VideoClip[] }, t: number): number | null {
  const c = s.clips.find((x) => t >= x.start && t <= x.start + retimeOf(x).len);
  return c ? retimeOf(c).srcAt(t - c.start) : null;
}

describe("time tokens", () => {
  test("format drops a zero tenth and grows an hour field", () => {
    expect(formatMark(94)).toBe("1:34");
    expect(formatMark(94.24)).toBe("1:34.2");
    expect(formatMark(8.02)).toBe("0:08");
    expect(formatMark(3723)).toBe("1:02:03");
    expect(formatMark(-5)).toBe("0:00");
  });

  test("parse reads both shapes", () => {
    expect(parseMark("1:34")).toBe(94);
    expect(parseMark("1:34.5")).toBe(94.5);
    expect(parseMark("1:02:03")).toBe(3723);
    expect(parseMark("nope")).toBe(null);
  });

  test("split keeps the written token and leaves the rest of the text", () => {
    expect(splitTimes("zoom at @1:34 please")).toEqual([
      "zoom at ",
      { text: "@1:34", at: 94 },
      " please",
    ]);
    // A handle that merely starts with digits is not a moment.
    expect(splitTimes("@v2 is loud")).toEqual(["@v2 is loud"]);
    expect(splitTimes("@1:34:56:78")).toEqual(["@1:34:56:78"]);
  });
});

describe("a moment holds its frame", () => {
  test("through a ripple", () => {
    const s = cut();
    const mark = markAt(12, s);
    expect(mark.clipId).toBe("b");
    expect(mark.src).toBeCloseTo(2);
    expect(markTime(mark, { clips: [clip("a", 0), clip("b", 13)] })).toBeCloseTo(15);
  });

  test("through a head trim", () => {
    const mark = markAt(12, cut());
    expect(markTime(mark, { clips: [clip("a", 0), clip("b", 10, { in: 1 })] })).toBeCloseTo(11);
  });

  test("through a split, on either side of the cut", () => {
    const s = cut();
    const early = markAt(12, s);
    const late = markAt(17, s);
    let n = 0;
    const after = splitTimelineItems(
      { ...s, audioClips: [], overlays: [], subtitles: { cues: [] } } as never,
      [{ kind: "clip", id: "b" }],
      15,
      () => `new${++n}`,
    ).next as { clips: VideoClip[] };
    // The right half is a clip the mark has never seen.
    expect(after.clips.map((c) => c.id)).toEqual(["a", "b", "new1"]);
    expect(markTime(early, after)).toBeCloseTo(12);
    expect(markTime(late, after)).toBeCloseTo(17);
    // And it follows that new half when the turn moves it.
    const moved = { clips: after.clips.map((c) => (c.id === "new1" ? { ...c, start: 18 } : c)) };
    expect(markTime(late, moved)).toBeCloseTo(20);
  });

  test("through a speed change, a speed curve and a reverse", () => {
    const s = cut();
    const mark = markAt(17, s);
    expect(mark.src).toBeCloseTo(7);
    for (const patch of [
      { speed: 2 },
      { speed: 0.5 },
      { speedCurve: [[0, 0.5], [0.5, 2], [1, 1]] as [number, number][] },
      { reverse: true },
      { speed: 2, reverse: true },
    ]) {
      const next = { clips: [clip("a", 0), clip("b", 10, patch)] };
      const at = markTime(mark, next);
      // Wherever the moment lands, the cut shows the frame it was written on.
      expect(frameAt(next, at)).toBeCloseTo(7, 4);
    }
  });

  test("through a retime that also moves the clip", () => {
    const mark = markAt(17, cut());
    const next = { clips: [clip("a", 0), clip("b", 30, { speed: 4 })] };
    expect(frameAt(next, markTime(mark, next))).toBeCloseTo(7, 4);
  });

  test("and clamps into the clip when the frame is trimmed away", () => {
    const mark = markAt(17, cut());
    expect(markTime(mark, { clips: [clip("a", 0), clip("b", 10, { out: 5 })] })).toBeCloseTo(15);
  });

  test("on a cut belongs to the incoming clip", () => {
    const mark = markAt(10, cut());
    expect(mark.clipId).toBe("b");
    expect(mark.src).toBeCloseTo(0);
    // Trimming the outgoing clip's tail pulls the cut back, and with it the moment.
    expect(markTime(mark, { clips: [clip("a", 0, { out: 8 }), clip("b", 8)] })).toBeCloseTo(8);
  });

  test("and picks the nearer copy when the source is on the timeline twice", () => {
    const mark = markAt(17, cut());
    const twice = { clips: [clip("a", 0), clip("b", 10), clip("b2", 20, { assetId: "b" })] };
    expect(markTime(mark, twice)).toBeCloseTo(17);
  });
});

describe("a moment off the clips", () => {
  test("in a gap rides the head of the clip ahead of it", () => {
    const s = { clips: [clip("a", 0), clip("b", 14)] };
    const mark = markAt(12, s);
    expect(mark.clipId).toBe("b");
    expect(mark.lead).toBeCloseTo(-2);
    expect(markTime(mark, { clips: [clip("a", 0), clip("b", 19)] })).toBeCloseTo(17);
  });

  test("past the end rides the head of the last clip", () => {
    const s = { clips: [clip("a", 0)] };
    const mark = markAt(13, s);
    expect(mark.clipId).toBe("a");
    expect(mark.lead).toBeCloseTo(13);
    expect(markTime(mark, { clips: [clip("a", 4)] })).toBeCloseTo(17);
  });

  test("in a gap finds the head again after the clip ahead is split", () => {
    const s = { clips: [clip("a", 0), clip("b", 14)] };
    const mark = markAt(12, s);
    // The split leaves b's head where it was; the moment stays two before it.
    let n = 0;
    const after = splitTimelineItems(
      { ...s, audioClips: [], overlays: [], subtitles: { cues: [] } } as never,
      [{ kind: "clip", id: "b" }],
      18,
      () => `new${++n}`,
    ).next as { clips: VideoClip[] };
    expect(markTime(mark, after)).toBeCloseTo(12);
  });

  test("with no clips at all keeps its second", () => {
    const mark = markAt(4, { clips: [] });
    expect(mark.clipId).toBeUndefined();
    expect(markTime(mark, cut())).toBe(4);
  });

  test("whose clip is gone keeps its second", () => {
    const mark = markAt(12, cut());
    expect(markTime(mark, { clips: [clip("a", 0)] })).toBe(12);
  });
});

describe("a project with no picture", () => {
  test("anchors on the soundtrack and rides its ripple", () => {
    const s = { clips: [], audioClips: [sound("vo", 0)] };
    const mark = markAt(12, s);
    expect(mark.clipId).toBe("vo");
    expect(mark.src).toBeCloseTo(12);
    expect(markTime(mark, { clips: [], audioClips: [sound("vo", 5)] })).toBeCloseTo(17);
  });

  test("but the picture wins wherever there is one", () => {
    const mark = markAt(12, { ...cut(), audioClips: [sound("vo", 0)] });
    expect(mark.clipId).toBe("b");
  });
});

describe("syncTimes", () => {
  test("rewrites every token to where its moment sits now", () => {
    const s = cut();
    const written = syncTimes("trim @0:05 and title @0:12", [], s);
    expect(written.text).toBe("trim @0:05 and title @0:12");
    expect(written.marks.map((m) => m.clipId)).toEqual(["a", "b"]);
    const moved = { clips: [clip("a", 0, { out: 14 }), clip("b", 14)] };
    expect(syncTimes(written.text, written.marks, moved).text).toBe("trim @0:05 and title @0:16");
  });

  test("a token typed by hand picks up a mark on the way out", () => {
    const { marks } = syncTimes("cut at @0:12", [], cut());
    expect(marks).toHaveLength(1);
    expect(marks[0].clipId).toBe("b");
  });

  test("a rewrite drops the marks its tokens left behind", () => {
    const s = cut();
    const first = syncTimes("@0:05 and @0:12", [], s);
    expect(syncTimes("@0:12 only", first.marks, s).marks).toHaveLength(1);
  });
});
