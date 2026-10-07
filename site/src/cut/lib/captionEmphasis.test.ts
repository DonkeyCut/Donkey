import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import {
  cueEmphasis,
  emphasisIndicesOf,
  emphasisRuns,
  remapEmphasis,
  typedToggle,
  toggleEmphasis,
  wordIndicesIn,
} from "./captionEmphasis";
import { chunkLaneCues } from "./cueChunk";
import { partialWrites } from "./cueSync";
import { ITEM_KINDS } from "./itemKinds";
import { useEditor } from "./store";
import {
  CAPTION_EMPHASIS_DEFAULT,
  CAPTION_STYLES,
  cueAnchor,
  cueOverlay,
  trackPos,
} from "./subtitles";
import { emptySubtitles, type SubtitleCue, type SubtitlesBlock } from "./types";

/**
 * Emphasized caption words and a caption's own spot.
 *
 * Emphasis is word indices on the cue, so the thing to hold is that every path
 * that rewrites a cue's words moves the indices with the words: a re-cut, a
 * split, a merge, a hand-edit, a realign. A caption's own spot wins over its
 * track's in every place that draws it.
 */

const STYLE = CAPTION_STYLES.clean;

/** Measured words at 0.5s apiece from `start`. */
function timed(id: string, text: string, start: number, emphasis?: number[]): SubtitleCue {
  const words = text.split(" ").map((w, i) => ({ w, t0: start + i * 0.5, t1: start + i * 0.5 + 0.45 }));
  return {
    id,
    start,
    end: start + words.length * 0.5,
    text,
    words,
    ...(emphasis ? { emphasis } : {}),
  };
}

const emphasized = (c: SubtitleCue) => {
  const words = c.text.split(/\s+/).filter(Boolean);
  return cueEmphasis(c).map((i) => words[i]);
};

describe("emphasis rides its words", () => {
  test("a re-cut moves each emphasized word into the caption it lands in", () => {
    const cue = timed("c1", "we shipped Figma plugins in six days flat", 0, [2, 5]);
    const out = chunkLaneCues([cue], 3);
    expect(out.map((c) => c.text)).toEqual(["we shipped Figma", "plugins in six", "days flat"]);
    expect(out.map(emphasized)).toEqual([["Figma"], ["six"], []]);
    // And back: re-cut to one long caption, the words find their places again.
    const back = chunkLaneCues(out, 12);
    expect(back).toHaveLength(1);
    expect(emphasized(back[0])).toEqual(["Figma", "six"]);
  });

  test("captions with no measured words keep their emphasis through a re-cut", () => {
    const cue: SubtitleCue = { id: "t1", start: 0, end: 4, text: "Try the free plan today", emphasis: [2] };
    const out = chunkLaneCues([cue], 2);
    expect(out.every((c) => !c.words)).toBe(true);
    expect(out.flatMap(emphasized)).toEqual(["free"]);
  });

  test("a re-cut caption sits where the cue it opens on sat", () => {
    const a = { ...timed("a", "one two three four", 0), x: 0.5, y: 0.2 };
    const b = timed("b", "five six", 2.05);
    const out = chunkLaneCues([a, b], 2);
    expect(out[0]).toMatchObject({ x: 0.5, y: 0.2 });
    expect(out[out.length - 1].x).toBeUndefined();
  });

  test("realigning keeps emphasis: only the times move", () => {
    const cue = timed("c1", "buy it now", 1, [2]);
    const [moved] = partialWrites([{ ...cue, start: 1.2, end: 2.6 }], [cue], () => true);
    expect(moved.start).toBe(1.2);
    expect(moved.emphasis).toEqual([2]);
  });

  test("a rewrite keeps the emphasis on every word still there", () => {
    expect(remapEmphasis("we shipped Figma plugins", "we shipped the Figma, plugin", [2])).toEqual([3]);
    expect(remapEmphasis("save 50 percent today", "save fifty percent today", [1])).toEqual([]);
    expect(remapEmphasis("one two three", "ONE two three", [0, 2])).toEqual([0, 2]);
  });

  test("indices past the text are never drawn", () => {
    expect(cueEmphasis({ text: "two words", emphasis: [1, 5, 1, -1] })).toEqual([1]);
  });

  test("a timeline split hands each half the emphasis of its own words", () => {
    const cue = timed("c1", "one two three four", 0, [1, 3]);
    const [left, right] = ITEM_KINDS.cue.split!(cue, 1.0);
    expect(left.text).toBe("one two");
    expect(emphasized(left)).toEqual(["two"]);
    expect(emphasized(right)).toEqual(["four"]);
  });
});

describe("picking words", () => {
  test("by the cue's own words, case and punctuation aside", () => {
    const cue = { text: "Download Notion, it's free!" };
    expect(emphasisIndicesOf(cue, ["notion", "FREE"])).toEqual({ indices: [1, 3], missing: [] });
    expect(emphasisIndicesOf(cue, ["Figma"]).missing).toEqual(["Figma"]);
  });

  test("a caret names the word it is in, a selection every word it touches", () => {
    const text = "one two  three";
    expect(wordIndicesIn(text, 5, 5)).toEqual([1]);
    expect(wordIndicesIn(text, 3, 3)).toEqual([0]);
    expect(wordIndicesIn(text, 8, 8)).toEqual([2]);
    expect(wordIndicesIn(text, 2, 6)).toEqual([0, 1]);
  });

  test("the editor's runs are the text exactly", () => {
    const runs = emphasisRuns("a  big win", [1, 2]);
    expect(runs.map((r) => r.text).join("")).toBe("a  big win");
    expect(runs.filter((r) => r.em).map((r) => r.text)).toEqual(["big", "win"]);
  });

  test("a toggle on unsaved typing reads the emphasis on the words typed", () => {
    const cue: SubtitleCue = { id: "c", start: 0, end: 1, text: "buy Notion now", emphasis: [1] };
    const typed = "please buy Notion now";
    const at = typed.indexOf("Notion");
    expect(typedToggle(cue, typed, at, at + 6)).toEqual({ indices: [2], on: false, label: "Notion" });
    const buy = typed.indexOf("buy");
    expect(typedToggle(cue, typed, buy, buy + 3)?.on).toBe(true);
  });

  test("toggling flips each word and drops the field when empty", () => {
    const cue: SubtitleCue = { id: "c", start: 0, end: 1, text: "a b c" };
    const on = toggleEmphasis(cue, [0, 2]);
    expect(on.emphasis).toEqual([0, 2]);
    const off = toggleEmphasis(on, [0, 2]);
    expect("emphasis" in off).toBe(false);
  });
});

describe("drawing", () => {
  const subs = (patch: Partial<SubtitlesBlock> = {}) =>
    ({ ...emptySubtitles(), ...patch }) as SubtitlesBlock;

  test("with no word effect, emphasized words wear the emphasis face and the rest stay plain", () => {
    const cue = timed("c1", "get Donkey free", 0, [1]);
    const ov = cueOverlay(cue, STYLE, false, trackPos(subs(), STYLE, 0), undefined, 1080);
    const draws = ov.wordDraw!;
    expect(draws).toHaveLength(3);
    expect(draws[0]).toMatchObject({ color: STYLE.color, scale: 1 });
    expect(draws[0].font).toBeUndefined();
    expect(draws[1]).toMatchObject({
      color: CAPTION_EMPHASIS_DEFAULT.color,
      font: CAPTION_EMPHASIS_DEFAULT.font,
      italic: true,
      weight: 700,
    });
  });

  test("a cue with nothing emphasized draws as plain text", () => {
    const ov = cueOverlay(timed("c1", "plain words", 0), STYLE, false, trackPos(subs(), STYLE, 0), undefined, 1080);
    expect(ov.wordDraw).toBeUndefined();
  });

  test("the track's emphasis style dresses the words, scale on top of the effect's", () => {
    const cue = timed("c1", "one two", 0, [0]);
    const pos = trackPos(
      subs({ emphasisColor: "#00FF00", emphasisFont: "serif", emphasisItalic: false, emphasisScale: 1.25 }),
      STYLE,
      0
    );
    const draws = cueOverlay(cue, STYLE, false, pos, undefined, 1080).wordDraw!;
    expect(draws[0]).toMatchObject({ color: "#00FF00", font: "serif", italic: false, scale: 1.25, layoutScale: 1.25 });
  });

  test("a word effect still plays on an emphasized word, starting from its color", () => {
    // Color effect, the first word's moment: it runs to the accent; the second
    // word waits at the emphasis color in the emphasis face.
    const style = { ...STYLE, accentMode: "color", accent: "#FF0000" };
    const cue = timed("c1", "one two", 0, [1]);
    const pos = trackPos(subs(), style, 0);
    const first = cueOverlay(cue, style, false, pos, 0.1, 1080).wordDraw!;
    expect(first[1]).toMatchObject({ color: CAPTION_EMPHASIS_DEFAULT.color, font: CAPTION_EMPHASIS_DEFAULT.font });
    const second = cueOverlay(cue, style, false, pos, 0.9, 1080).wordDraw!;
    expect(second[1].color.toLowerCase()).toBe("#ff0000");
    expect(second[1].font).toBe(CAPTION_EMPHASIS_DEFAULT.font);
  });

  test("the resting picture is held between frames", () => {
    const cue = timed("c1", "hold this", 0, [0]);
    const pos = trackPos(subs(), STYLE, 0);
    const a = cueOverlay(cue, STYLE, false, pos, undefined, 1080).wordDraw;
    const b = cueOverlay(cue, STYLE, false, trackPos(subs(), STYLE, 0), undefined, 1080).wordDraw;
    expect(a).toBe(b);
  });
});

describe("a caption's own spot", () => {
  const block = { ...emptySubtitles(), tracks: [{ x: 0.5, y: 0.7 }] } as SubtitlesBlock;
  const track = trackPos(block, STYLE, 0);

  test("wins over its track's, and the track's fills in without one", () => {
    expect(cueAnchor({ x: 0.3, y: 0.2 }, track, STYLE)).toEqual({ x: 0.3, y: 0.2 });
    expect(cueAnchor({}, track, STYLE)).toEqual({ x: 0.5, y: 0.7 });
    expect(cueAnchor({}, undefined, STYLE)).toEqual({ x: STYLE.x, y: STYLE.y });
  });

  test("every burn-in reads it through cueOverlay", () => {
    const ov = cueOverlay({ ...timed("c", "hi there", 0), x: 0.4, y: 0.15 }, STYLE, false, track, undefined, 1080);
    expect({ x: ov.x, y: ov.y }).toEqual({ x: 0.4, y: 0.15 });
    const follows = cueOverlay(timed("d", "hi there", 0), STYLE, false, track, undefined, 1080);
    expect({ x: follows.x, y: follows.y }).toEqual({ x: 0.5, y: 0.7 });
  });
});

describe("the editor and the tools", () => {
  beforeEach(() => {
    useEditor.setState({
      clips: [],
      overlays: [],
      transitions: [],
      audioClips: [],
      subtitles: {
        ...emptySubtitles(),
        cues: [
          timed("c1", "we shipped Figma plugins", 0),
          timed("c2", "in six days", 2.1),
          { id: "c3", start: 4, end: 6, text: "try it free today" },
        ],
      },
    });
  });
  const cue = (id: string) => useEditor.getState().subtitles.cues.find((c) => c.id === id)!;

  test("set_caption_emphasis marks by index and by word across cues in one undo step", async () => {
    await runAiTool("set_caption_emphasis", {
      marks: [
        { cue_id: "c1", words: ["Figma"] },
        { cue_id: "c3", indices: [2] },
      ],
    });
    expect(emphasized(cue("c1"))).toEqual(["Figma"]);
    expect(emphasized(cue("c3"))).toEqual(["free"]);
    useEditor.getState().undo();
    expect(cue("c1").emphasis).toBeUndefined();
    expect(cue("c3").emphasis).toBeUndefined();
  });

  test("a word the cue does not have is refused and nothing is written", async () => {
    await expect(
      runAiTool("set_caption_emphasis", {
        marks: [
          { cue_id: "c1", words: ["Figma"] },
          { cue_id: "c2", words: ["weeks"] },
        ],
      })
    ).rejects.toThrow(/no word "weeks"/);
    expect(cue("c1").emphasis).toBeUndefined();
  });

  test("clear_all wipes before marking", async () => {
    useEditor.getState().setCueEmphasis([{ id: "c1", indices: [2] }]);
    await runAiTool("set_caption_emphasis", { clear_all: true, marks: [{ cue_id: "c2", words: ["six"] }] });
    expect(cue("c1").emphasis).toBeUndefined();
    expect(emphasized(cue("c2"))).toEqual(["six"]);
  });

  test("hand-edits, splits and merges keep emphasis on its words", () => {
    const s = () => useEditor.getState();
    s().setCueEmphasis([{ id: "c1", indices: [2] }]);
    s().setCueText("c1", "we finally shipped Figma plugins");
    expect(emphasized(cue("c1"))).toEqual(["Figma"]);
    s().splitCue("c1", "we finally shipped".length);
    const halves = s().subtitles.cues.filter((c) => c.text.includes("Figma"));
    expect(halves.map(emphasized)).toEqual([["Figma"]]);
    s().setCueEmphasis([{ id: "c2", indices: [1] }]);
    s().mergeCueIntoPrev("c2");
    const merged = s().subtitles.cues.find((c) => c.text.endsWith("six days"))!;
    expect(emphasized(merged)).toEqual(["Figma", "six"]);
  });

  test("update_cue gives a caption its own spot and follow_track hands it back", async () => {
    await runAiTool("update_cue", { id: "c2", y: 0.2 });
    expect(cue("c2").y).toBe(0.2);
    expect(cue("c2").x).toBe(STYLE.x);
    await runAiTool("update_cue", { id: "c2", follow_track: true });
    expect(cue("c2").x).toBeUndefined();
    expect(cue("c2").y).toBeUndefined();
  });
});
