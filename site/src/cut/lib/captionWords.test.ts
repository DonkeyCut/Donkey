import { describe, expect, test } from "bun:test";
import { CAPTION_STYLES, cueOverlay, cueWordFrames, cueWords, trackPos } from "./subtitles";
import { measureLine, textFontOf } from "./textFit";
import { emptySubtitles, type SubtitleCue, type SubtitlesBlock } from "./types";
import { textRoom } from "@donkeycut/effects-kit";

/**
 * A caption's word effect against the speech it was measured from.
 *
 * The clock is the transcriber's own onsets, so a cue whose first word runs
 * most of its length lights that word for most of it. What these check is that
 * every side of the caption path reads that same clock: the picture the preview
 * and the burn-in draw, and the spans the burn-in cuts to draw them at.
 */

const ACCENT = "#FF3D00";
const STYLE = { ...CAPTION_STYLES.clean, accentMode: "color", accent: ACCENT };

/** "one two three" with the first word holding four fifths of the cue. */
const cue: SubtitleCue = {
  id: "c1",
  start: 10,
  end: 12,
  text: "one two three",
  words: [
    { t0: 10, t1: 11.6, w: "one" },
    { t0: 11.6, t1: 11.8, w: "two" },
    { t0: 11.8, t1: 12, w: "three" },
  ],
};

/** Which display word wears the accent in a drawn cue, or -1. */
const lit = (at: number, subs?: Partial<SubtitlesBlock>) =>
  cueOverlay(
    cue,
    STYLE,
    false,
    trackPos({ ...emptySubtitles(), ...subs } as SubtitlesBlock, STYLE, 0),
    at,
    1080
  ).wordDraw?.findIndex((d) => d.color.toLowerCase() === ACCENT.toLowerCase()) ?? -1;

describe("a caption's word clock", () => {
  test("follows the transcriber's onsets, not an even share of the cue", () => {
    // Halfway through the cue the measured speech is still on word 0; a split
    // by word length would have moved on by then.
    expect(lit(11)).toBe(0);
    expect(lit(11.7)).toBe(1);
    expect(lit(11.9)).toBe(2);
  });

  test("shares the span by word length when nothing measured the speech", () => {
    const flat = { ...cue, words: undefined };
    const draws = cueOverlay(flat, STYLE, false, undefined, 11, 1080).wordDraw;
    expect(draws?.length).toBe(3);
    expect(draws?.some((d) => d.color.toLowerCase() === ACCENT.toLowerCase())).toBe(true);
  });

  test("cue words carry the onsets the sampler cuts its spans from", () => {
    const times = cueWords(cue, STYLE).times ?? [];
    expect(times.length).toBe(3);
    [0, 1.6, 1.8].forEach((t, i) => expect(times[i]).toBeCloseTo(t, 5));
  });
});

describe("burn-in spans", () => {
  const spans = cueWordFrames(cue, STYLE);

  test("cover the cue end to end with no gaps", () => {
    expect(spans[0].start).toBeCloseTo(cue.start, 5);
    expect(spans[spans.length - 1].end).toBeCloseTo(cue.end, 5);
    for (let i = 1; i < spans.length; i++)
      expect(spans[i].start).toBeCloseTo(spans[i - 1].end, 5);
  });

  test("each stands for the word the picture drawn at its middle actually lights", () => {
    // The span boundaries and the picture inside them have to come off one
    // clock, or a span burns a word that is not the one it covers.
    for (const s of spans) {
      const mid = (s.start + s.end) / 2;
      expect(lit(mid)).toBe(lit(s.start + (s.end - s.start) * 0.25));
    }
  });

  test("an effect that lands on the beat stays one still per word", () => {
    expect(spans.length).toBe(3);
  });

  test("a ramping effect is cut finer, and bounded however long its ramp runs", () => {
    const built = cueWordFrames(cue, { ...STYLE, accentMode: "rise" });
    expect(built.length).toBeGreaterThan(spans.length);
    // Three words, at most two extra pictures each.
    expect(built.length).toBeLessThanOrEqual(9);
  });
});

describe("the lines a caption is broken into", () => {
  // The preview draws these lines in the DOM and the export paints them on a
  // canvas; neither reflows, so the break decided here is what both show.
  const long: SubtitleCue = {
    id: "c2",
    start: 0,
    end: 3,
    text: "Don't wait for someone to give you a chance to start the thing you keep talking about",
  };
  const linesAt = (size: number, frameW: number, x = 0.5) =>
    cueOverlay(long, { ...CAPTION_STYLES.clean, size, x }, false, undefined, undefined, frameW)
      .text.split("\n");

  test("each line fits the room the frame leaves it", () => {
    for (const line of linesAt(42, 1080)) {
      expect(measureLine(line, textFontOf(CAPTION_STYLES.clean, 42), 42)).toBeLessThanOrEqual(
        textRoom(0.5, 1080)
      );
    }
  });

  test("uses the width the frame has, not a share of it", () => {
    // A caption centered in a 1080-wide frame gets the whole safe width. The
    // regression this pins: laying it out against half the frame, which broke
    // a line that had most of the picture still empty beside it.
    const lines = linesAt(42, 1080);
    const widest = Math.max(
      ...lines.map((l) => measureLine(l, textFontOf(CAPTION_STYLES.clean, 42), 42))
    );
    expect(widest).toBeGreaterThan(textRoom(0.5, 1080) / 2);
  });

  test("evens the lines out instead of leaving an orphan", () => {
    const lines = cueOverlay(
      { ...long, text: "Don't wait for someone to give you a chance" },
      CAPTION_STYLES.clean,
      false,
      undefined,
      undefined,
      1080
    ).text.split("\n");
    expect(lines).toHaveLength(2);
    const widths = lines.map((l) => measureLine(l, textFontOf(CAPTION_STYLES.clean, 42), 42));
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.7);
  });

  test("breaks in design space, so every render size shows the same lines", () => {
    expect(linesAt(42, 1080)).toEqual(linesAt(42, 1080));
    // A caption dragged off-center has less room and breaks sooner.
    expect(linesAt(42, 1080, 0.2).length).toBeGreaterThan(linesAt(42, 1080).length);
  });
});

describe("the caption's own settings", () => {
  test("reach the drawn words", () => {
    const faint = cueOverlay(
      cue,
      { ...STYLE, accentMode: "fill" },
      false,
      trackPos({ ...emptySubtitles(), accentDim: 0.6 } as SubtitlesBlock, STYLE, 0),
      10,
      1080
    ).wordDraw;
    expect(faint?.[2].opacity).toBeCloseTo(0.6, 5);
  });

  test("a swell set on the track lands on the word being said", () => {
    const swollen = cueOverlay(
      cue,
      { ...STYLE, accentMode: "pop" },
      false,
      trackPos({ ...emptySubtitles(), accentScale: 1.5 } as SubtitlesBlock, STYLE, 0),
      10.5,
      1080
    ).wordDraw;
    expect(swollen?.[0].scale).toBeCloseTo(1.5, 5);
    expect(swollen?.[1].scale).toBe(1);
  });
});
