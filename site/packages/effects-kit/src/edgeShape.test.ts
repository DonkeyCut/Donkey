import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { paintElement, type RenderEnv } from "./render";
import type { TextOverlay } from "./types";
import { edgeMaxSeconds, edgeMotion, evalOverlayAnim, glyphStateAt, OVERLAY_ANIM_MAX_SECONDS, type OverlayEdge } from "./anim";
import { evalOverlayFrame } from "./keys";
import { presetExtent } from "./motion/evaluate";

// "YOUR LOCATION" dropping in over 2.4s, its letters falling from high above.
const TEXT = "YOUR LOCATION";
const N = [...TEXT].length;

/** The moment letter `i` first shows, in seconds. */
function firstShow(edge: OverlayEdge, i: number): number {
  for (let t = 0; t <= edge.seconds; t += 1 / 120) {
    const g = glyphStateAt(evalOverlayAnim({ in: edge }, t, 6, true), i, N);
    if (g.alpha > 0.001) return t;
  }
  return Infinity;
}

describe("an edge's letter order", () => {
  test("shuffle deals the letters their turns out of reading order", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 2.4, stagger: 0.8, order: "shuffle" };
    const starts = [...Array(N).keys()].map((i) => firstShow(edge, i));
    const ranked = [...starts.keys()].sort((a, b) => starts[a] - starts[b]);
    expect(ranked).not.toEqual([...Array(N).keys()]);
    // Still one at a time, evenly spaced across the hand-off.
    const sorted = [...starts].sort((a, b) => a - b);
    for (let i = 1; i < N; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(0.1);
  });

  test("absent, the letters go in reading order", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 2.4, stagger: 0.8 };
    const starts = [...Array(N).keys()].map((i) => firstShow(edge, i));
    for (let i = 1; i < N; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
  });
});

describe("an edge's distance", () => {
  test("a letter starts that far from rest, and the crop pads for it", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 2, distance: 500 };
    const g = glyphStateAt(evalOverlayAnim({ in: edge }, 0, 6, true), 0, N);
    expect(g.dy).toBeCloseTo(-500, 0);
    expect(presetExtent(edgeMotion(edge)!).travel).toBeGreaterThanOrEqual(500);
    // Absent, the style's own reach.
    const own = glyphStateAt(evalOverlayAnim({ in: { style: "drop", seconds: 2 } }, 0, 6, true), 0, N);
    expect(own.dy).toBeCloseTo(-46, 0);
  });
});

describe("a per-letter ramp's length", () => {
  test("runs past the shared cap, so a long title can land letter by letter", () => {
    expect(edgeMaxSeconds("drop")).toBeGreaterThan(OVERLAY_ANIM_MAX_SECONDS);
    expect(edgeMaxSeconds("fade")).toBe(OVERLAY_ANIM_MAX_SECONDS);
  });
});

describe("a falling letter's motion blur", () => {
  const title = {
    kind: "text" as const,
    text: TEXT,
    start: 0,
    end: 6,
    x: 0.5,
    y: 0.5,
    anim: { in: { style: "drop" as const, seconds: 2, stagger: 0.5, distance: 500 } },
  };

  test("with the element's motion blur on, a moving letter streaks along its own fall", () => {
    const st = evalOverlayFrame({ ...title, motionBlur: 1 } as never, 0.3, 16 / 9);
    const moving = [...Array(N).keys()].map((i) => glyphStateAt(st, i, N)).find((g) => g.alpha > 0.1 && g.dy < -20);
    expect(moving?.streak).toBeDefined();
    expect(Math.abs(moving!.streak!.y)).toBeGreaterThan(5);
    expect(Math.abs(moving!.streak!.x)).toBeLessThan(1);
    // The element itself never moves, so it carries no streak of its own.
    expect(st.streak).toBeUndefined();
  });

  test("a letter at rest, or a title without motion blur, draws sharp", () => {
    const off = evalOverlayFrame(title as never, 0.3, 16 / 9);
    for (let i = 0; i < N; i++) expect(glyphStateAt(off, i, N).streak).toBeUndefined();
    const landed = evalOverlayFrame({ ...title, motionBlur: 1 } as never, 4, 16 / 9);
    for (let i = 0; i < N; i++) expect(glyphStateAt(landed, i, N).streak).toBeUndefined();
  });
});

describe("the export's frame slices", () => {
  test("carry the slot's order, reach and per-letter streak, as the preview plays them", async () => {
    const { planAnimatedLayers } = await import("./render");
    const o = {
      id: "t",
      kind: "text",
      text: TEXT,
      start: 0,
      end: 6,
      x: 0.5,
      y: 0.5,
      size: 200,
      color: "#ff0000",
      font: "bebas",
      motionBlur: 1,
      anim: { in: { style: "drop", seconds: 2, stagger: 0.8, order: "shuffle", distance: 500 } },
    };
    const layers = planAnimatedLayers(o as never, 6);
    const mid = layers.find((l) => l.phase?.glyphs && l.start >= 0.5)!;
    const live = evalOverlayFrame(o as never, mid.start, 16 / 9);
    for (let i = 0; i < N; i++) {
      const baked = glyphStateAt(mid.phase!, i, N);
      const shown = glyphStateAt(live, i, N);
      expect(baked.dy).toBeCloseTo(shown.dy, 3);
      expect(baked.streak?.y ?? 0).toBeCloseTo(shown.streak?.y ?? 0, 3);
    }
    expect([...Array(N).keys()].some((i) => glyphStateAt(mid.phase!, i, N).streak)).toBe(true);
  });
});

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

describe("a falling letter on canvas", () => {
  test("smears along its fall under motion blur, and keeps its ink", async () => {
    const o: TextOverlay = { id: "t", text: "I", start: 0, end: 4, x: 0.5, y: 0.5, size: 200, font: "sf", weight: 700, color: "#ff0000", plate: false, shadow: false, anim: { in: { style: "drop", seconds: 1, distance: 400 } } };
    const paint = async (motionBlur?: number) => {
      const el = { ...o, ...(motionBlur ? { motionBlur } : {}) };
      const st = evalOverlayFrame(el as never, 0.2, 1);
      const c = new Canvas(1080, 1080);
      const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
      await paintElement(ctx, el, { width: 1080, height: 1080, scale: 1, phase: { glyphs: st.glyphs } }, env);
      const d = ctx.getImageData(0, 0, 1080, 1080).data;
      // The ink's rows, and its total coverage.
      let top = 1080;
      let bottom = 0;
      let ink = 0;
      for (let y = 0; y < 1080; y++)
        for (let x = 500; x < 580; x++) {
          const a = d[(y * 1080 + x) * 4 + 3];
          ink += a;
          if (a > 8) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
        }
      return { h: bottom - top, ink };
    };
    const sharp = await paint();
    const blurred = await paint(1);
    expect(blurred.h).toBeGreaterThan(sharp.h + 10);
    // Averaged, not stacked: the smear spreads the same ink.
    expect(blurred.ink / sharp.ink).toBeGreaterThan(0.9);
    expect(blurred.ink / sharp.ink).toBeLessThan(1.1);
  });
});

describe("an order read off a reference", () => {
  test("letters land in the sequence named, spaces skipped, the last as the ramp ends", () => {
    const { letterSequence } = require("./anim") as typeof import("./anim");
    // O (of LOCATION) first, then L, C, A, T, … Y and N last.
    const letters = [5, 4, 6, 7, 8, 2, 9, 3, 10, 1, 0, 11];
    const order = letterSequence(TEXT, letters);
    expect(order[0]).toBe(6); // the space before LOCATION takes index 4
    const edge: OverlayEdge = { style: "drop", seconds: 2.4, stagger: 0.7, order };
    const starts = order.map((i) => firstShow(edge, i));
    for (let k = 1; k < starts.length; k++) expect(starts[k]).toBeGreaterThan(starts[k - 1]);
    // The last named letter starts its own move at the hand-off's end.
    expect(starts[starts.length - 1]).toBeCloseTo(0.7 * 2.4, 1);
    // An exit sweeps them out in the order they came in, as reading order does.
    const out = (i: number) => {
      for (let t = 0; t <= 2.4; t += 1 / 120) {
        const g = glyphStateAt(evalOverlayAnim({ out: edge }, 6 - 2.4 + t, 6, true), i, N);
        if (g.alpha < 0.999) return t;
      }
      return Infinity;
    };
    expect(out(order[0])).toBeLessThan(out(order[1]));
    expect(out(order[1])).toBeLessThan(out(order[order.length - 1]));
  });
});

describe("an edge's ease and fade", () => {
  const at = (edge: OverlayEdge, t: number) => glyphStateAt(evalOverlayAnim({ in: edge }, t, 6, true), 0, 1);

  test("a named ease replaces the style's own curve on its move", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 1, stagger: 0, distance: 600, ease: "linear" };
    // Halfway through a linear fall, halfway down.
    expect(at(edge, 0.5).dy).toBeCloseTo(-300, 0);
    // The style's own curve is well past halfway by then.
    expect(at({ ...edge, ease: undefined }, 0.5).dy).toBeGreaterThan(-200);
  });

  test("fade off keeps a letter solid the whole way in", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 1, stagger: 0, distance: 600, fade: false };
    expect(at(edge, 0.05).alpha).toBe(1);
    expect(at({ ...edge, fade: undefined }, 0.05).alpha).toBeLessThan(0.2);
  });
});

describe("an edge's defocus", () => {
  const at = (edge: OverlayEdge, t: number) => glyphStateAt(evalOverlayAnim({ in: edge }, t, 6, true), 0, 1);

  test("a letter comes in that soft and sharpens as it lands", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 1, stagger: 0, distance: 600, blur: 18 };
    expect(at(edge, 0).blur).toBeCloseTo(18, 0);
    expect(at(edge, 0.5).blur!).toBeGreaterThan(0);
    expect(at(edge, 0.5).blur!).toBeLessThan(18);
    expect(at(edge, 1.2).blur ?? 0).toBe(0);
    // Absent, a drop stays sharp.
    expect(at({ ...edge, blur: undefined }, 0).blur ?? 0).toBe(0);
  });

  test("0 takes a soft style's own blur away", () => {
    expect(at({ style: "blur", seconds: 1, stagger: 0 }, 0).blur!).toBeGreaterThan(0);
    expect(at({ style: "blur", seconds: 1, stagger: 0, blur: 0 }, 0).blur ?? 0).toBe(0);
  });

  test("the crop pads for it and the export slices carry it", async () => {
    const edge: OverlayEdge = { style: "drop", seconds: 2, stagger: 0.5, distance: 500, blur: 30 };
    expect(presetExtent(edgeMotion(edge)!).travel).toBeGreaterThanOrEqual(500 + 60);
    const { planAnimatedLayers } = await import("./render");
    const o = { id: "t", kind: "text", text: TEXT, start: 0, end: 6, x: 0.5, y: 0.5, size: 200, color: "#ff0000", font: "bebas", anim: { in: edge } };
    const mid = planAnimatedLayers(o as never, 6).find((l) => l.phase?.glyphs && l.start >= 0.5)!;
    const live = evalOverlayFrame(o as never, mid.start, 16 / 9);
    for (let i = 0; i < N; i++) expect(glyphStateAt(mid.phase!, i, N).blur ?? 0).toBeCloseTo(glyphStateAt(live, i, N).blur ?? 0, 3);
  });
});

describe("an edge's fade length", () => {
  const at = (edge: OverlayEdge, t: number) => glyphStateAt(evalOverlayAnim({ in: edge }, t, 6, true), 0, 1);

  test("a share of the move fades the letter up that early, then holds it solid", () => {
    const edge: OverlayEdge = { style: "drop", seconds: 1, stagger: 0, distance: 600, fade: 0.25 };
    expect(at(edge, 0.125).alpha).toBeCloseTo(0.5, 1);
    expect(at(edge, 0.3).alpha).toBe(1);
    // The style's own fade runs the whole move.
    expect(at({ ...edge, fade: undefined }, 0.3).alpha).toBeLessThan(0.5);
  });
});

describe("an order's own timing", () => {
  test("each named letter starts at its share of the hand-off, not evenly spaced", () => {
    const { letterSequence } = require("./anim") as typeof import("./anim");
    const order = letterSequence(TEXT, [5, 4, 0]);
    // O starts at once, L a tenth of the way through the hand-off, Y at its end.
    const edge: OverlayEdge = { style: "drop", seconds: 2, stagger: 0.5, order, orderAt: [0, 0.1, 1] };
    const starts = order.map((i) => firstShow(edge, i));
    expect(starts[0]).toBeCloseTo(0, 1);
    expect(starts[1]).toBeCloseTo(0.1, 1);
    expect(starts[2]).toBeCloseTo(1, 1);
    // Evenly spaced, L would wait for half the hand-off.
    expect(firstShow({ ...edge, orderAt: undefined }, order[1])).toBeCloseTo(0.5, 1);
  });
});
