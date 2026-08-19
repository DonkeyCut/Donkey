import { describe, expect, test } from "bun:test";
import {
  GLYPH_ANIM_STYLE_IDS,
  GLYPH_LOOP_STYLE_IDS,
  OVERLAY_ANIM_STYLE_IDS,
  OVERLAY_LOOP_STYLE_IDS,
  bakesPixels,
  evalOverlayAnim,
  glyphAnimAt,
  glyphStateAt,
  loopExtent,
  loopPeriod,
} from "../anim";
import { MOTION, presetsFor } from "./catalog";
import { evalPreset, sampleProperties, sampleTrack } from "./evaluate";
import type { MotionPreset, PropertyKey } from "./types";

/**
 * The catalog is the whole animation library, so what it has to satisfy is
 * structural: keys in order inside the window, loops that close, and ids the
 * saved-doc unions still name.
 */

const everyPreset = (): [string, MotionPreset][] => [
  ...Object.entries(MOTION.edges),
  ...Object.entries(MOTION.loops),
  ...Object.entries(MOTION.holds),
];

const tracks = (p: MotionPreset): PropertyKey<never>[][] =>
  [p.animate, p.animateOut].flatMap((props) =>
    props ? (Object.values(props) as PropertyKey<never>[][]) : []
  );

describe("the motion catalog", () => {
  test("every preset keys inside its window, in order", () => {
    for (const [, preset] of everyPreset()) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.slots.length).toBeGreaterThan(0);
      expect(tracks(preset).length).toBeGreaterThan(0);
      for (const track of tracks(preset)) {
        expect(track.length).toBeGreaterThan(0);
        for (let i = 0; i < track.length; i++) {
          expect(track[i].t).toBeGreaterThanOrEqual(0);
          expect(track[i].t).toBeLessThanOrEqual(1);
          if (i > 0) expect(track[i].t).toBeGreaterThan(track[i - 1].t);
          if (track[i].ease)
            expect(track[i].ease!.length).toBe(4);
        }
      }
    }
  });

  test("a loop closes on itself, so one rendered cycle can repeat forever", () => {
    for (const [id, preset] of Object.entries(MOTION.loops)) {
      expect(preset.period).toBeGreaterThan(0);
      const start = evalPreset(preset, 0);
      const end = evalPreset(preset, 1);
      // Spin is the exception every rotation system has: a full turn lands
      // back where it started, 360 degrees on.
      const turn = id === "spin" ? 360 : 0;
      expect(Math.abs(end.dx - start.dx)).toBeLessThan(0.5);
      expect(Math.abs(end.dy - start.dy)).toBeLessThan(0.5);
      expect(Math.abs(end.sx - start.sx)).toBeLessThan(0.01);
      expect(Math.abs(end.rotate - start.rotate - turn)).toBeLessThan(0.5);
      expect(Math.abs(end.alpha - start.alpha)).toBeLessThan(0.02);
    }
  });

  test("a ramp starts away from rest and lands on it", () => {
    for (const [, preset] of Object.entries(MOTION.edges)) {
      const end = evalPreset(preset, 1);
      expect(Math.abs(end.dx)).toBeLessThan(0.5);
      expect(Math.abs(end.dy)).toBeLessThan(0.5);
      expect(Math.abs(end.sx - 1)).toBeLessThan(0.01);
      expect(Math.abs(end.rotate)).toBeLessThan(0.5);
      expect(Math.abs(end.alpha - 1)).toBeLessThan(0.01);
      expect(Math.abs(end.tracking)).toBeLessThan(0.5);
    }
  });

  test("the saved-doc ids and the data name the same presets", () => {
    expect([...OVERLAY_ANIM_STYLE_IDS].sort()).toEqual(Object.keys(MOTION.edges).sort());
    expect([...OVERLAY_LOOP_STYLE_IDS].sort()).toEqual(Object.keys(MOTION.loops).sort());
    for (const id of GLYPH_ANIM_STYLE_IDS) expect(!!MOTION.edges[id].selector).toBe(true);
    for (const id of GLYPH_LOOP_STYLE_IDS) expect(!!MOTION.loops[id].selector).toBe(true);
    for (const slot of ["in", "out", "loop", "hold"] as const)
      expect(presetsFor(slot).length).toBeGreaterThan(0);
  });

  test("a hold move says what it is for", () => {
    for (const [, preset] of Object.entries(MOTION.holds))
      expect(preset.note?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("the evaluator", () => {
  test("a track holds before its first key and after its last", () => {
    const keys: PropertyKey<number>[] = [
      { t: 0.25, v: 10 },
      { t: 0.75, v: 20 },
    ];
    expect(sampleTrack(keys, 0, 0)).toBe(10);
    expect(sampleTrack(keys, 0.5, 0)).toBeCloseTo(15, 5);
    expect(sampleTrack(keys, 1, 0)).toBe(20);
    expect(sampleTrack(undefined, 0.5, 3)).toBe(3);
  });

  test("a hold key steps instead of ramping", () => {
    const keys: PropertyKey<number>[] = [
      { t: 0, v: 0, hold: true },
      { t: 1, v: 1 },
    ];
    expect(sampleTrack(keys, 0.99, 0)).toBe(0);
  });

  test("easing bends the ramp without moving its ends", () => {
    const eased: PropertyKey<number>[] = [
      { t: 0, v: 0, ease: [0.9, 0, 1, 0.1] },
      { t: 1, v: 1 },
    ];
    expect(sampleTrack(eased, 0, 0)).toBe(0);
    expect(sampleTrack(eased, 1, 0)).toBe(1);
    expect(sampleTrack(eased, 0.5, 0)).toBeLessThan(0.4);
  });

  test("a tMax cap keeps a hit short however long the element runs", () => {
    const props = { scale: [{ t: 0, v: [2, 2] as [number, number] }, { t: 0.5, v: [1, 1] as [number, number], tMax: 0.2 }] };
    // Over six seconds the second key lands at 0.2s, not at three seconds.
    expect(sampleProperties(props, 0.2 / 6, 6).sx).toBeCloseTo(1, 2);
    // Over half a second the cap is not binding and normalized time stands.
    expect(sampleProperties(props, 0.5, 0.5).sx).toBeCloseTo(1, 2);
  });

  test("a selector hands the motion down the line", () => {
    // Early in a rise, the first character has moved further than the last.
    const first = glyphAnimAt({ style: "rise", p: 0.3, exiting: false }, 0, 8);
    const last = glyphAnimAt({ style: "rise", p: 0.3, exiting: false }, 7, 8);
    expect(Math.abs(first.dy)).toBeLessThan(Math.abs(last.dy));
  });

  test("a wiggly entrance still strays on an element with no characters", () => {
    // A scatter's whole motion is its per-unit stray; a shape or a sticker
    // has no characters to hand it to and plays it as one piece.
    const st = evalOverlayAnim({ in: { style: "scatter", seconds: 1 } }, 0.2, 3, false);
    expect(Math.hypot(st.dx, st.dy)).toBeGreaterThan(1);
  });

  test("every style evaluates over its whole window without going wild", () => {
    for (const style of OVERLAY_ANIM_STYLE_IDS) {
      for (const isText of [false, true]) {
        for (let i = 0; i <= 20; i++) {
          const st = evalOverlayAnim(
            { in: { style, seconds: 1 }, out: { style, seconds: 1 } },
            (i / 20) * 3,
            3,
            isText
          );
          expect(Number.isFinite(st.dx)).toBe(true);
          expect(Number.isFinite(st.scale)).toBe(true);
          expect(st.alpha).toBeGreaterThanOrEqual(0);
          expect(st.alpha).toBeLessThanOrEqual(1.001);
        }
      }
    }
  });

  test("loop speed divides the period", () => {
    for (const style of OVERLAY_LOOP_STYLE_IDS) {
      const base = loopPeriod({ loop: { style, speed: 1 } })!;
      expect(loopPeriod({ loop: { style, speed: 2 } })).toBeCloseTo(base / 2, 5);
    }
  });
});

describe("presets are data, not code", () => {
  test("a preset invented at runtime evaluates like any other", () => {
    const invented: MotionPreset = {
      label: "Test",
      slots: ["in"],
      selector: { basedOn: "characters", shape: "rampDown", spread: 0.5 },
      animate: {
        position: [
          { t: 0, v: [0, 200] },
          { t: 1, v: [0, 0] },
        ],
      },
    };
    // rampDown deals the last character first, so it is the one already on
    // its way home while the first has not started.
    expect(Math.abs(evalPreset(invented, 0.2, 0, 4).dy)).toBeGreaterThan(
      Math.abs(evalPreset(invented, 0.2, 3, 4).dy)
    );
    expect(evalPreset(invented, 1, 0, 4).dy).toBeCloseTo(0, 5);
  });
});

/**
 * A composed animation is a preset the project carries instead of naming, so
 * what has to hold is that nothing downstream can tell the two apart: the
 * evaluator, the per-character path, the crop padding and the bake decision
 * all read the preset, never the id.
 */
describe("a slot's own preset", () => {
  const DIVE: MotionPreset = {
    label: "Dive",
    slots: ["in"],
    animate: {
      position: [
        { t: 0, v: [0, -300] },
        { t: 1, v: [0, 0] },
      ],
      opacity: [
        { t: 0, v: 0 },
        { t: 0.4, v: 1 },
      ],
    },
  };
  const SWEEP: MotionPreset = {
    ...DIVE,
    label: "Sweep",
    selector: { basedOn: "characters", shape: "rampUp", spread: 0.6 },
  };

  test("plays instead of the style it is filed under", () => {
    const at = (anim: Parameters<typeof evalOverlayAnim>[0]) => evalOverlayAnim(anim, 0.25, 2);
    const named = at({ in: { style: "fade", seconds: 1 } });
    const composed = at({ in: { style: "fade", seconds: 1, preset: DIVE } });
    expect(named.dy).toBe(0);
    expect(composed.dy).toBeLessThan(-100);
    // It lands where any ramp lands: at rest by the end of its window.
    const done = evalOverlayAnim({ in: { style: "fade", seconds: 1, preset: DIVE } }, 1, 2);
    expect(done.dy).toBeCloseTo(0, 5);
  });

  test("reaches the characters when it carries a selector", () => {
    const st = evalOverlayAnim({ in: { style: "fade", seconds: 1, preset: SWEEP } }, 0.3, 2, true);
    expect(!!st.glyphs).toBe(true);
    const first = glyphStateAt(st, 0, 8);
    const last = glyphStateAt(st, 7, 8);
    // rampUp deals the first character first, so it is nearer home.
    expect(Math.abs(first.dy)).toBeLessThan(Math.abs(last.dy));
  });

  test("a loop of its own sets the period and the extent", () => {
    const spin: MotionPreset = {
      label: "Turn",
      slots: ["loop"],
      period: 3,
      animate: {
        position: [
          { t: 0, v: [0, 0] },
          { t: 0.5, v: [80, 0] },
          { t: 1, v: [0, 0] },
        ],
      },
    };
    expect(loopPeriod({ loop: { style: "float", speed: 2, preset: spin } })).toBeCloseTo(1.5, 5);
    expect(loopExtent({ style: "float", speed: 1, preset: spin }).travel).toBe(80);
  });

  test("decides its own bake from its channels", () => {
    expect(bakesPixels({ style: "fade", seconds: 1, preset: DIVE }, true)).toBe(false);
    expect(bakesPixels({ style: "fade", seconds: 1, preset: SWEEP }, true)).toBe(true);
    const wipe: MotionPreset = {
      ...DIVE,
      animate: { reveal: [{ t: 0, v: 0 }, { t: 1, v: 1 }] },
    };
    expect(bakesPixels({ style: "fade", seconds: 1, preset: wipe }, false)).toBe(true);
  });
});
