import { describe, expect, test } from "bun:test";
import { evalOverlayAnim, glyphStateAt } from "./anim";
import { planAnimatedLayers } from "./render";

// A five-letter title ("TUNED") on screen for 4s.
const LETTERS = 5;
const DUR = 4;

/** Letter `i` of a title whose `slot` edge runs over `seconds`, at `t`. */
function letter(slot: "in" | "out", style: string, seconds: number, t: number, i: number) {
  const anim = { [slot]: { style, seconds } } as Parameters<typeof evalOverlayAnim>[0];
  return glyphStateAt(evalOverlayAnim(anim, t, DUR, true), i, LETTERS);
}

describe("letters that sharpen out of a blur", () => {
  test("each letter starts defocused and lands sharp", () => {
    const early = [...Array(LETTERS).keys()].map((i) => letter("in", "blur", 0.8, 0.02, i));
    expect(Math.max(...early.map((g) => g.blur ?? 0))).toBeGreaterThan(8);
    for (let i = 0; i < LETTERS; i++) {
      expect(letter("in", "blur", 0.8, 0.8, i).blur ?? 0).toBe(0);
    }
  });

  test("the letters land in a shuffled order", () => {
    // The first letter to show is not simply the leftmost one.
    const firstSeen = (i: number) => {
      for (let t = 0; t <= 0.8; t += 1 / 120) {
        if (letter("in", "blur", 0.8, t, i).alpha > 0.05) {
          return t;
        }
      }
      return Infinity;
    };
    const order = [...Array(LETTERS).keys()].sort((a, b) => firstSeen(a) - firstSeen(b));
    expect(order).not.toEqual([0, 1, 2, 3, 4]);
  });
});

describe("letters that glitch in", () => {
  test("a letter arrives split into red and cyan and settles whole", () => {
    const mid = [...Array(LETTERS).keys()].map((i) => letter("in", "glitch", 0.5, 0.15, i));
    expect(Math.max(...mid.map((g) => g.split ?? 0))).toBeGreaterThan(4);
    for (let i = 0; i < LETTERS; i++) {
      expect(letter("in", "glitch", 0.5, 0.5, i).split ?? 0).toBe(0);
    }
  });
});

describe("letters that flicker out", () => {
  test("each letter blinks on its own pattern and the line ends dark", () => {
    // Sampled across the exit, the letters go dark at different moments.
    const seconds = 0.75;
    const start = DUR - seconds;
    const darkAt = (i: number) =>
      [...Array(20).keys()].map((k) => letter("out", "flicker", seconds, start + (k + 0.5) * (seconds / 20), i).alpha < 0.5);
    const patterns = [...Array(LETTERS).keys()].map((i) => darkAt(i).join(""));
    expect(new Set(patterns).size).toBeGreaterThan(2);
    // Every letter blinks at least once and comes back at least once.
    for (const p of [...Array(LETTERS).keys()].map(darkAt)) {
      expect(p.some(Boolean)).toBe(true);
      expect(p.some((d) => !d)).toBe(true);
    }
    // The flicker takes hold early: through the exit's first half, well over
    // a third of the letter samples are out.
    const firstHalf = [...Array(LETTERS).keys()].flatMap((i) => darkAt(i).slice(0, 10));
    expect(firstHalf.filter(Boolean).length / firstHalf.length).toBeGreaterThan(0.35);
    // Before the exit starts the line is steady.
    for (let i = 0; i < LETTERS; i++) {
      expect(letter("out", "flicker", seconds, start - 0.1, i).alpha).toBe(1);
    }
  });
});

describe("the canvas export's ramp pictures", () => {
  test("each frame of a glyph ramp shows the moment the preview shows", () => {
    // A title on a frame boundary with a 0.6s glitch in and a 0.75s flicker
    // out: at every 30 fps frame the window covering it carries the ramp
    // position the live evaluator gives for that frame's time.
    const o = {
      id: "t",
      kind: "text",
      text: "TUNED",
      start: 2,
      end: 2 + DUR,
      x: 0.5,
      y: 0.5,
      anim: { in: { style: "glitch", seconds: 0.6 }, out: { style: "flicker", seconds: 0.75 } },
    } as Parameters<typeof planAnimatedLayers>[0];
    const layers = planAnimatedLayers(o, o.end);
    for (let k = 0; k < DUR * 30; k++) {
      const t = k / 30;
      const live = evalOverlayAnim(o.anim!, t, DUR, true).glyphs;
      if (!live) {
        continue;
      }
      const at = o.start + t + 1e-9;
      const layer = layers.find((l) => l.start <= at && at < l.end)!;
      expect(layer.phase?.glyphs?.p).toBeCloseTo(live.p, 6);
    }
  });
});
