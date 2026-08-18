import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { TEXT_LOOKS, textLookCatalog } from "./textLooks";
import { emptySubtitles, frameOf, isTextOverlay, isShapeOverlay, type SubtitleCue } from "./types";

/**
 * Text-driven videos: a run of lines becomes a stack of color cards and words
 * carrying a named look, and the same look dresses a caption track.
 */

const reset = () =>
  useEditor.setState({
    projectId: "p1",
    aspect: "16:9",
    assets: [],
    clips: [],
    overlays: [],
    subtitles: emptySubtitles(),
    background: "#000000",
  });

const overlays = () => useEditor.getState().overlays;

describe("add_text_sequence", () => {
  beforeEach(reset);

  test("lays cards under words on their own rows, in the look's colors", async () => {
    const look = TEXT_LOOKS["lyric-card"];
    await runAiTool("add_text_sequence", {
      look: "lyric-card",
      lines: [
        { text: "first line", start: 0, end: 2 },
        { text: "second line", start: 2, end: 4 },
        { text: "third line", start: 4, end: 6 },
      ],
    });
    const cards = overlays().filter(isShapeOverlay);
    const words = overlays().filter(isTextOverlay);
    expect(cards).toHaveLength(3);
    expect(words).toHaveLength(3);
    // Row 0 is the front of the stack: the words own it and the cards sit a
    // row behind, so a card never paints its own line out.
    expect(words.map((w) => w.lane ?? 0)).toEqual([0, 0, 0]);
    expect(cards.map((c) => c.lane ?? 0)).toEqual([1, 1, 1]);
    expect(cards.map((c) => c.fill)).toEqual(look.frame.cards);
    expect(words.map((w) => w.color)).toEqual(look.text.onCards!);
    expect(words.map((w) => w.text)).toEqual(["first line", "second line", "third line"]);
    expect(words[0].font).toBe(look.text.font);
    expect(words[0].anim?.in?.style).toBe(look.motion.in!.style);
    expect(useEditor.getState().background).toBe(look.frame.background);
  });

  test("a look with no cards puts the words straight on the frame", async () => {
    await runAiTool("add_text_sequence", {
      look: "over-footage",
      background: false,
      lines: [{ text: "over the shot", start: 1, end: 3 }],
    });
    expect(overlays().filter(isShapeOverlay)).toHaveLength(0);
    const word = overlays().filter(isTextOverlay)[0];
    expect(word.lane ?? 0).toBe(0);
    expect(word.y).toBeCloseTo(TEXT_LOOKS["over-footage"].text.y, 2);
    expect(useEditor.getState().background).toBe("#000000");
  });

  test("lines with no times follow one another", async () => {
    await runAiTool("add_text_sequence", {
      look: "serif-mood",
      lines: [{ text: "one" }, { text: "two" }, { text: "three" }],
    });
    const words = overlays().filter(isTextOverlay);
    for (let i = 0; i + 1 < words.length; i++)
      expect(words[i].end).toBeLessThanOrEqual(words[i + 1].start + 1e-6);
  });

  test("a long line breaks and shrinks to fit the frame it is in", async () => {
    useEditor.setState({ aspect: "9:16" });
    await runAiTool("add_text_sequence", {
      look: "neon-club",
      lines: [{ text: "Nobody knows my name tonight", start: 0, end: 2 }],
    });
    const word = overlays().filter(isTextOverlay)[0];
    expect(word.text).toContain("\n");
    const frame = frameOf("9:16");
    const ratio = TEXT_LOOKS["neon-club"].text.widthRatio!;
    for (const line of word.text.split("\n"))
      expect(line.length * word.size * ratio).toBeLessThanOrEqual(frame.w * 0.9);
  });

  test("a per-line color overrides the look", async () => {
    await runAiTool("add_text_sequence", {
      look: "lyric-card",
      lines: [{ text: "accent", start: 0, end: 1, color: "#00FF00" }],
    });
    expect(overlays().filter(isTextOverlay)[0].color).toBe("#00FF00");
  });

  test("the caption track can be the running order", async () => {
    const cues: SubtitleCue[] = [
      { id: "q1", start: 0.5, end: 1.5, text: "hold on" },
      { id: "q2", start: 1.5, end: 3, text: "we're going home" },
    ];
    useEditor.setState({ subtitles: { ...emptySubtitles(), cues } });
    await runAiTool("add_text_sequence", { look: "kinetic-scatter", from_captions: 0 });
    const words = overlays().filter(isTextOverlay);
    expect(words.map((w) => w.text)).toEqual(["hold on", "we're going home"]);
    expect(words[0].start).toBeCloseTo(0.5, 2);
    expect(words[1].end).toBeCloseTo(3, 2);
  });

  test("an unknown look is refused rather than quietly swapped", async () => {
    let message = "";
    try {
      await runAiTool("add_text_sequence", {
        look: "karaoke",
        lines: [{ text: "a line", start: 0, end: 1 }],
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Unknown look");
    expect(overlays()).toHaveLength(0);
    expect(useEditor.getState().background).toBe("#000000");
  });

  test("a line with no end of its own never inverts", async () => {
    await runAiTool("add_text_sequence", {
      look: "serif-mood",
      lines: [{ text: "no times" }, { text: "starts earlier", start: 0, end: 1 }],
    });
    for (const w of overlays().filter(isTextOverlay)) expect(w.end).toBeGreaterThan(w.start);
  });

  test("a run with nothing to place is refused", async () => {
    let message = "";
    try {
      await runAiTool("add_text_sequence", { look: "lyric-card", lines: [] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("lines");
  });
});

describe("set_caption_look", () => {
  beforeEach(reset);

  test("a look id sets the whole caption look", async () => {
    await runAiTool("set_caption_look", { look: "karaoke-glow" });
    const look = TEXT_LOOKS["karaoke-glow"];
    const subs = useEditor.getState().subtitles;
    expect(subs.style).toBe(look.captions.style);
    expect(subs.wordHighlight).toBe(true);
    expect(subs.accentColor).toBe(look.captions.accentColor);
    expect(useEditor.getState().background).toBe(look.frame.background);
  });

  test("fields can be set on their own", async () => {
    await runAiTool("set_caption_look", { style: "neon", word_highlight: false, size: 70 });
    const subs = useEditor.getState().subtitles;
    expect(subs.style).toBe("neon");
    expect(subs.wordHighlight).toBe(false);
    expect(subs.size).toBe(70);
  });

  test("an unknown preset is refused", async () => {
    let message = "";
    try {
      await runAiTool("set_caption_look", { style: "sparkle" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("caption style");
  });
});

describe("the look registry", () => {
  test("every look reads as one prompt line", () => {
    const lines = textLookCatalog().split("\n");
    expect(lines).toHaveLength(Object.keys(TEXT_LOOKS).length);
    for (const l of lines) expect(l.startsWith("- ")).toBe(true);
  });

  test("card looks say what color the words go in on each card", () => {
    for (const look of Object.values(TEXT_LOOKS)) {
      if (look.frame.cards.length === 0) continue;
      expect(look.text.onCards).toHaveLength(look.frame.cards.length);
    }
  });
});
