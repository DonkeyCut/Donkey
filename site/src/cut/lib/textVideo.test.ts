import { beforeEach, describe, expect, test } from "bun:test";
import { runAiTool } from "./aiTools";
import { useEditor } from "./store";
import { composeTextRun, TEXT_LAYOUT_IDS, TEXT_LAYOUT_NOTES } from "./textCompose";
import { TEXT_LOOKS, textLookCatalog } from "./textLooks";
import { matchTextMove, TEXT_MOVE_IDS, TEXT_MOVE_NOTES, textMoveKeys } from "./textMotion";
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

  test("a run nobody asked to design comes out plain and leaves the cut alone", async () => {
    useEditor.setState({ background: "#123456" });
    await runAiTool("add_text_sequence", {
      lines: [
        { text: "first line", start: 0, end: 2 },
        { text: "second line", start: 2, end: 4 },
        { text: "third line", start: 4, end: 6 },
      ],
    });
    const words = overlays().filter(isTextOverlay);
    expect(overlays().filter(isShapeOverlay)).toHaveLength(0);
    expect(words).toHaveLength(3);
    // One face, one place, one entrance, no keyframe moves, no tilt.
    expect(new Set(words.map((w) => w.font)).size).toBe(1);
    expect(new Set(words.map((w) => w.y)).size).toBe(1);
    expect(new Set(words.map((w) => w.x)).size).toBe(1);
    expect(new Set(words.map((w) => w.color)).size).toBe(1);
    expect(words.every((w) => (w.rotation ?? 0) === 0)).toBe(true);
    expect(words.every((w) => !w.kf || w.kf.length === 0)).toBe(true);
    expect(words.every((w) => w.anim?.in?.style === "fade")).toBe(true);
    // The frame color is the user's, not the look's.
    expect(useEditor.getState().background).toBe("#123456");
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

describe("composing a run", () => {
  beforeEach(reset);

  const runOf = async (extra: Record<string, unknown> = {}) => {
    await runAiTool("add_text_sequence", {
      look: "kinetic-scatter",
      lines: Array.from({ length: 8 }, (_, i) => ({
        text: `line ${i}`,
        start: i * 2,
        end: i * 2 + 2,
      })),
      ...extra,
    });
    return overlays().filter(isTextOverlay);
  };

  test("lines land in different places instead of stacking on one anchor", async () => {
    const words = await runOf();
    const spots = new Set(words.map((w) => `${w.x},${w.y}`));
    expect(spots.size).toBeGreaterThan(3);
  });

  test("the run walks faces, entrances and holds rather than repeating one", async () => {
    const words = await runOf();
    expect(new Set(words.map((w) => w.font)).size).toBeGreaterThan(1);
    expect(new Set(words.map((w) => w.anim?.in?.style)).size).toBeGreaterThan(1);
    expect(words.filter((w) => (w.kf?.length ?? 0) > 1).length).toBeGreaterThan(0);
  });

  test('variation "none" lays the run exactly as the look describes it', async () => {
    const look = TEXT_LOOKS["kinetic-scatter"];
    const words = await runOf({ variation: "none" });
    expect(new Set(words.map((w) => `${w.x},${w.y}`)).size).toBe(1);
    expect(new Set(words.map((w) => w.font))).toEqual(new Set([look.text.font]));
    expect(words.every((w) => (w.kf?.length ?? 0) === 0)).toBe(true);
  });

  test("a named layout overrides the look's own", async () => {
    const words = await runOf({ layout: "ladder" });
    // The ladder walks down the frame and back; nothing sits left or right.
    expect(new Set(words.map((w) => w.y)).size).toBeGreaterThan(2);
  });

  test("an unknown layout is refused", async () => {
    let message = "";
    try {
      await runOf({ layout: "spiral" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("layout");
  });

  test("hero lines come out bigger than whispers", async () => {
    await runAiTool("add_text_sequence", {
      look: "lyric-card",
      lines: [
        { text: "quiet", start: 0, end: 2, emphasis: "whisper" },
        { text: "quiet", start: 2, end: 4, emphasis: "normal" },
        { text: "LOUD", start: 4, end: 6, emphasis: "hero" },
      ],
    });
    const [w, n, h] = overlays().filter(isTextOverlay);
    expect(w.size).toBeLessThan(n.size);
    expect(h.size).toBeGreaterThan(n.size);
  });

  test("a new section restarts the rotas so passages differ", async () => {
    const look = TEXT_LOOKS["ransom-note"];
    const lines = [
      { text: "one", start: 0, end: 2, section: "verse" },
      { text: "two", start: 2, end: 4, section: "verse" },
      { text: "one", start: 4, end: 6, section: "chorus" },
      { text: "two", start: 6, end: 8, section: "chorus" },
    ];
    const composed = composeTextRun(lines, look, {
      variation: "bold",
      frame: { w: 1920, h: 1080 },
      cards: [],
    });
    expect(composed[0].font).not.toBe(composed[2].font);
  });

  test("per-line fields beat the ensemble", async () => {
    await runAiTool("add_text_sequence", {
      look: "neon-club",
      lines: [
        { text: "a", start: 0, end: 2 },
        { text: "b", start: 2, end: 4, font: "caveat", x: 0.2, y: 0.8, rotation: 12, in_style: "wipe", move: "orbit" },
      ],
    });
    const b = overlays().filter(isTextOverlay)[1];
    expect(b.font).toBe("caveat");
    expect(b.x).toBeCloseTo(0.2, 2);
    expect(b.y).toBeCloseTo(0.8, 2);
    expect(b.rotation).toBe(12);
    expect(b.anim?.in?.style).toBe("wipe");
    expect(b.kf!.length).toBeGreaterThan(2);
  });

  test("a line placed off-axis is broken to the room it actually has", async () => {
    const composed = composeTextRun(
      [{ text: "a long line that would fill the whole frame at center", start: 0, end: 2, x: 0.18 }],
      TEXT_LOOKS["over-footage"],
      { variation: "bold", frame: { w: 1920, h: 1080 }, cards: [] }
    );
    const widest = composed[0].text.split("\n").reduce((n, l) => Math.max(n, l.length), 0);
    // Centered at x 0.18 there is only 36% of the frame to spread into.
    expect(widest * composed[0].size * 0.5).toBeLessThanOrEqual(1920 * 0.4);
  });

  test("a repeated hook steps up rather than repeating flat", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => ({ text: "do", start: i, end: i + 1 }));
    const composed = composeTextRun(lines, TEXT_LOOKS["lyric-card"], {
      variation: "bold",
      frame: { w: 1920, h: 1080 },
      cards: [],
    });
    expect(composed[3].size).toBeGreaterThan(composed[0].size);
  });
});

describe("keyframe moves", () => {
  test("every id has a note and a track, and none outlives its element", () => {
    for (const id of TEXT_MOVE_IDS) {
      expect(TEXT_MOVE_NOTES[id].length).toBeGreaterThan(0);
      const keys = textMoveKeys(id, { x: 0.5, y: 0.5, rotation: 0 }, 2);
      if (id === "none") {
        expect(keys).toBeUndefined();
        continue;
      }
      expect(keys!.length).toBeGreaterThan(1);
      for (const k of keys!) {
        expect(k.t).toBeGreaterThanOrEqual(0);
        expect(k.t).toBeLessThanOrEqual(2);
        expect(k.opacity).toBeGreaterThanOrEqual(0);
      }
      // Keys arrive in play order with no duplicate times.
      for (let i = 1; i < keys!.length; i++) expect(keys![i].t).toBeGreaterThan(keys![i - 1].t);
    }
  });

  test("the track bends the way the preset does", () => {
    // A pose track runs straight between its keys, so a move written on a
    // curve has to be sampled off that curve: push's ease and orbit's circle
    // both leave the straight line between the first key and the last.
    const rest = { x: 0.5, y: 0.5, rotation: 0 };
    const strayFrom = (id: string, read: (k: { scale: number; x: number; y: number }) => number) => {
      const keys = textMoveKeys(id, rest, 3)!;
      const first = keys[0];
      const last = keys[keys.length - 1];
      return Math.max(
        ...keys.map((k) => {
          const p = (k.t - first.t) / (last.t - first.t);
          return Math.abs(read(k) - (read(first) + (read(last) - read(first)) * p));
        })
      );
    };
    expect(strayFrom("push", (k) => k.scale)).toBeGreaterThan(0.01);
    expect(strayFrom("orbit", (k) => k.x)).toBeGreaterThan(0.01);
  });

  test("a line too short to read gets no track", () => {
    expect(textMoveKeys("push", { x: 0.5, y: 0.5, rotation: 0 }, 0.1)).toBeUndefined();
  });
});

describe("the ensemble registry", () => {
  test("entry 0 of every rota is the look's own setting", () => {
    for (const look of Object.values(TEXT_LOOKS)) {
      expect(look.ensemble.faces[0].font).toBe(look.text.font);
      expect(look.ensemble.faces[0].weight).toBe(look.text.weight);
      expect(look.ensemble.faces[0].scale ?? 1).toBe(1);
      expect(look.ensemble.motion[0]).toBe(look.motion.in?.style ?? "fade");
      expect(TEXT_LAYOUT_IDS).toContain(look.ensemble.layout);
      for (const m of look.ensemble.moves) expect(TEXT_MOVE_IDS).toContain(m);
      if (look.ensemble.heroMove) expect(TEXT_MOVE_IDS).toContain(look.ensemble.heroMove);
    }
  });

  test("every layout is described for the prompt", () => {
    for (const id of TEXT_LAYOUT_IDS) expect(TEXT_LAYOUT_NOTES[id].length).toBeGreaterThan(0);
  });
});

describe("moves on an existing element", () => {
  beforeEach(reset);

  const aTitle = async () => {
    await runAiTool("add_text_sequence", {
      look: "serif-mood",
      lines: [{ text: "a line", start: 0, end: 3 }],
    });
    return overlays().filter(isTextOverlay)[0];
  };

  test("a named move writes the element's own pose track", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, move: "push" });
    const after = overlays().filter(isTextOverlay)[0];
    expect(after.kf!.length).toBeGreaterThan(1);
    // A push grows across the hold and never leaves its resting spot.
    expect(after.kf![after.kf!.length - 1].scale).toBeGreaterThan(after.kf![0].scale);
    for (const key of after.kf!) {
      expect(key.x).toBeCloseTo(after.x, 3);
      expect(key.t).toBeGreaterThanOrEqual(0);
      expect(key.t).toBeLessThanOrEqual(after.end - after.start + 1e-6);
    }
  });

  test('move "none" clears the track', async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, move: "swing" });
    expect(overlays().filter(isTextOverlay)[0].kf!.length).toBeGreaterThan(1);
    await runAiTool("set_overlay_animation", { id: o.id, move: "none" });
    expect(overlays().filter(isTextOverlay)[0].kf ?? []).toHaveLength(0);
  });

  test("an unknown move is refused", async () => {
    const o = await aTitle();
    let message = "";
    try {
      await runAiTool("set_overlay_animation", { id: o.id, move: "wobble" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("Unknown move");
  });

  test("a move and an entrance sit on the element together", async () => {
    const o = await aTitle();
    await runAiTool("set_overlay_animation", { id: o.id, in_style: "rise", move: "float" });
    const after = overlays().filter(isTextOverlay)[0];
    expect(after.anim?.in?.style).toBe("rise");
    expect(after.kf!.length).toBeGreaterThan(1);
  });
});

describe("every move is real motion", () => {
  test("each id moves the element somewhere", () => {
    for (const id of TEXT_MOVE_IDS) {
      const keys = textMoveKeys(id, { x: 0.5, y: 0.5, rotation: 0 }, 2.5);
      if (id === "none") {
        expect(keys).toBeUndefined();
        continue;
      }
      expect(keys!.length).toBeGreaterThan(1);
      const moves = keys!.some(
        (k) =>
          Math.abs(k.x - keys![0].x) > 1e-4 ||
          Math.abs(k.y - keys![0].y) > 1e-4 ||
          Math.abs(k.scale - keys![0].scale) > 1e-3 ||
          Math.abs(k.rotation - keys![0].rotation) > 1e-3 ||
          Math.abs(k.opacity - keys![0].opacity) > 1e-3
      );
      expect(moves).toBe(true);
    }
  });
});

describe("move strength", () => {
  const rest = { x: 0.5, y: 0.5, rotation: 0 };

  test("scales every offset from rest and leaves the timing alone", () => {
    const full = textMoveKeys("push", rest, 3, 1)!;
    const half = textMoveKeys("push", rest, 3, 0.5)!;
    expect(half.map((k) => k.t)).toEqual(full.map((k) => k.t));
    for (let i = 0; i < full.length; i++)
      expect(half[i].scale - 1).toBeCloseTo((full[i].scale - 1) / 2, 5);
  });

  test("a move at any strength is found again on the element", () => {
    for (const id of TEXT_MOVE_IDS) {
      if (id === "none") continue;
      for (const strength of [0.25, 0.5, 1, 1.5, 2]) {
        const keys = textMoveKeys(id, rest, 2.5, strength)!;
        expect(matchTextMove(keys, rest, 2.5)).toEqual({ id, strength });
      }
    }
  });

  test("keys the user has dragged stop matching", () => {
    const keys = textMoveKeys("swing", rest, 2.5, 1)!;
    keys[1] = { ...keys[1], x: keys[1].x + 0.2 };
    expect(matchTextMove(keys, rest, 2.5)).toBeUndefined();
    expect(matchTextMove(undefined, rest, 2.5)).toBeUndefined();
  });

  test("the tool takes a strength and clamps it", async () => {
    reset();
    await runAiTool("add_text_sequence", {
      look: "serif-mood",
      lines: [{ text: "a line", start: 0, end: 3 }],
    });
    const o = overlays().filter(isTextOverlay)[0];
    await runAiTool("set_overlay_animation", { id: o.id, move: "push", move_strength: 0.5 });
    const after = overlays().filter(isTextOverlay)[0];
    expect(
      matchTextMove(after.kf, { x: after.x, y: after.y, rotation: after.rotation ?? 0 }, 3)
    ).toEqual({ id: "push", strength: 0.5 });
  });
});
