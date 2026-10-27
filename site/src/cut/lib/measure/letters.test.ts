import { describe, expect, test } from "bun:test";
import { evalOverlayAnim, glyphStateAt, reelBand, slotReel, slotSeed, type OverlayEdge } from "@donkeycut/effects-kit";
import { readLetters, type LetterFrame } from "./letters";

type Rgb = [number, number, number];

// A 240×135 picture of a 1080-short-side design: a pixel is 8 design px.
const W = 240;
const H = 135;
const UNIT = 1080 / H;
const RED: Rgb = [255, 0, 0];
const WHITE: Rgb = [255, 255, 255];
// The ground cuts between two dark colours every few frames, as the shots do.
const GROUNDS: Rgb[] = [
  [0, 42, 51],
  [103, 1, 45],
];
const TEXT = "ABCD EF";
const N = 6;
// Each letter's rest: 14 px wide columns with gaps, 30 px tall, centred at y 80.
const REST = Array.from({ length: N }, (_, i) => ({
  x: 50 + i * 24,
  y: 65,
  w: 14,
  h: 30,
}));
// A line of white type the letters fall through, above where they land.
const LINE = { x: 40, y: 48, w: 160, h: 8 };

/** Abramowitz and Stegun 7.1.26: the error function to 1.5e-7. */
function erf(x: number): number {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * k)) as Rgb;

/** The picture at `t` with the letters on `edge`, the white line behind them
 * or in front of them. */
function frameAt(t: number, edge: OverlayEdge, lineInFront: boolean, frame: number, gradient = false): LetterFrame {
  const ground = GROUNDS[Math.floor(frame / 5) % 2];
  const data = new Uint8ClampedArray(W * H * 4);
  // A gradient ground has no one colour most of it is.
  for (let i = 0; i < W * H; i++) data.set([...(gradient ? mix(ground, [0, 0, 0], (i % W) / W) : ground), 255], i * 4);
  // A rectangle's coverage of each pixel, defocused by `sigma` px.
  const paint = (r: { x: number; y: number; w: number; h: number }, c: Rgb, alpha = 1, sigma = 0) => {
    const reach = Math.ceil(sigma * 3) + 1;
    const cover = (a: number, b: number, p: number) =>
      sigma > 0
        ? (erf((b - p - 0.5) / (sigma * Math.SQRT2)) - erf((a - p - 0.5) / (sigma * Math.SQRT2))) / 2
        : p >= Math.round(a) && p < Math.round(b)
          ? 1
          : 0;
    for (let y = Math.max(0, Math.floor(r.y) - reach); y < Math.min(H, Math.ceil(r.y + r.h) + reach); y++)
      for (let x = Math.max(0, r.x - reach); x < Math.min(W, r.x + r.w + reach); x++) {
        const k = alpha * cover(r.x, r.x + r.w, x) * cover(r.y, r.y + r.h, y);
        if (k <= 0) continue;
        const i = (y * W + x) * 4;
        data.set([...mix([data[i], data[i + 1], data[i + 2]], c, k), 255], i);
      }
  };
  const line = () => paint(LINE, WHITE);
  if (!lineInFront) line();
  const st = evalOverlayAnim({ in: edge }, t, 10, true);
  // Glyph indices count the space, as the title's characters do.
  const chars = [...TEXT];
  let letter = 0;
  chars.forEach((c, gi) => {
    if (!c.trim()) return;
    const g = glyphStateAt(st, gi, chars.length);
    paint({ ...REST[letter], y: REST[letter].y + g.dy / UNIT }, RED, g.alpha, (g.blur ?? 0) / UNIT);
    letter++;
  });
  if (lineInFront) line();
  return { data, width: W, height: H, t };
}

function framesOf(edge: OverlayEdge, lineInFront = false, gradient = false): LetterFrame[] {
  const out: LetterFrame[] = [];
  for (let f = 0; f / 30 <= edge.seconds + 0.3; f++) out.push(frameAt(f / 30, edge, lineInFront, f, gradient));
  return out;
}

const region = { x: 40, y: 58, w: 160, h: 44 };
const read = (frames: LetterFrame[]) => readLetters(frames, { text: TEXT, region, ink: RED, unit: UNIT });

// Letters 3, 1, 5, 0, 4, 2 (spaces skipped) as glyph indices of "ABCD EF".
const ORDER = [3, 1, 6, 0, 5, 2];
const SEQUENCE = [3, 1, 5, 0, 4, 2];

describe("reading a line's letters as they come in", () => {
  // Solid letters falling from well above the picture at a steady speed.
  const edge: OverlayEdge = {
    style: "drop",
    seconds: 2.2,
    stagger: 0.75,
    order: ORDER,
    distance: 1200,
    ease: "linear",
    fade: false,
  };

  test("names the order, the hand-off and one letter's move", () => {
    const r = read(framesOf(edge));
    expect(r.edge?.sequence).toEqual(SEQUENCE);
    // Each letter's own move: 2.2 × 0.25 = 0.55s, of which the part inside the picture shows.
    expect(r.edge!.ease).toBe("linear");
    expect(r.edge!.fade).toBe(false);
    expect(r.edge!.direction).toBe("down");
    // The span of starts is the stagger's share, 1.65s, wherever the moves begin.
    const span = r.edge!.seconds * r.edge!.stagger;
    expect(span).toBeCloseTo(1.65, 1);
  });

  test("its edge, played back, puts every letter where the reference has it", () => {
    const frames = framesOf(edge);
    const e = read(frames).edge!;
    const chars = [...TEXT];
    const glyphOf = (letter: number) =>
      chars.findIndex((c, gi) => c.trim() && chars.slice(0, gi).filter((x) => x.trim()).length === letter);
    const ours: OverlayEdge = {
      style: "drop",
      seconds: e.seconds,
      stagger: e.stagger,
      order: e.sequence.map(glyphOf),
      orderAt: e.sequenceAt,
      distance: e.distance,
      ease: e.ease ?? undefined,
      fade: e.fade,
    };
    for (const f of frames) {
      const theirs = evalOverlayAnim({ in: edge }, f.t, 10, true);
      const mine = evalOverlayAnim({ in: ours }, f.t - e.start, 10, true);
      for (let letter = 0; letter < N; letter++) {
        const gi = glyphOf(letter);
        const a = glyphStateAt(theirs, gi, chars.length);
        const b = glyphStateAt(mine, gi, chars.length);
        // Inside the picture the two agree to within a couple of pixels.
        const bottom = REST[letter].y + REST[letter].h;
        if (bottom + a.dy / UNIT > 0) expect(Math.abs(a.dy - b.dy) / UNIT).toBeLessThan(2.5);
      }
    }
  });

  test("solid, sharp letters read as solid and sharp", () => {
    const r = read(framesOf(edge));
    expect(r.edge!.fade).toBe(false);
    expect(r.edge!.blur).toBe(0);
  });

  test("a short fade and uneven turns read as they are, and play back the same", () => {
    // Starting inside the picture, so the fade shows: fully up a third of the
    // way into each move, turns bunched at the start.
    const ragged: OverlayEdge = { ...edge, distance: 500, fade: 0.3, orderAt: [0, 0.1, 0.2, 0.5, 0.9, 1] };
    const e = read(framesOf(ragged)).edge!;
    expect(typeof e.fade).toBe("number");
    expect(e.fade as number).toBeGreaterThan(0.15);
    expect(e.fade as number).toBeLessThan(0.45);
    expect(e.sequenceAt[1]).toBeCloseTo(0.1, 1);
    expect(e.sequenceAt[3]).toBeCloseTo(0.5, 1);
  });

  test("letters that fade in and sharpen on the way read as fading and soft", () => {
    // Out of focus by 40 design px (5 of these pixels) at the far end.
    const r = read(framesOf({ ...edge, ease: "power3.out", fade: undefined, blur: 40 }));
    expect(r.edge!.fade).toBe(true);
    expect(r.edge!.ease).toBe("power3.out");
    expect(r.edge!.blur).toBeGreaterThan(28);
    expect(r.edge!.blur).toBeLessThan(52);
  });

  test("tells which side of a line they cross the letters pass", () => {
    expect(read(framesOf(edge, false)).passes[0]?.letters).toBe("front");
    expect(read(framesOf(edge, true)).passes[0]?.letters).toBe("behind");
  });

  test("letters filling most of a seed close around them, over a gradient, still read", () => {
    const frames = framesOf(edge, false, true);
    const tight = { x: 49, y: 64, w: 136, h: 32 };
    expect(readLetters(frames, { text: TEXT, region: tight, ink: RED, unit: UNIT }).edge?.sequence).toEqual(SEQUENCE);
  });

  test("a seed at fractions of a pixel, as a frame box maps to one, still reads", () => {
    const frames = framesOf(edge);
    const loose = { x: 40.37, y: 58.6, w: 160.25, h: 44.4 };
    expect(readLetters(frames, { text: TEXT, region: loose, ink: RED, unit: UNIT }).edge?.sequence).toEqual(SEQUENCE);
  });

  test("a seed with none of the colour is refused, not misread", () => {
    const frames = framesOf(edge);
    expect(() => readLetters(frames, { text: TEXT, region: { x: 0, y: 0, w: 30, h: 20 }, ink: RED, unit: UNIT })).toThrow(
      /Found 0 letters/,
    );
  });

  test("a last frame missing a letter is refused, not misread", () => {
    const frames = framesOf(edge).slice(0, 20);
    expect(() => read(frames)).toThrow(/letters? of that colour/);
  });
});

// A 320×180 picture: a pixel is 6 design px. "2026" in teal on black, each
// digit 40 px tall at rest — type of 55.6 px (digits stand 0.72 em), lines
// 1.25 em apart.
const RW = 320;
const RH = 180;
const RUNIT = 1080 / RH;
const TEAL: Rgb = [0, 73, 89];
const DIGITS = "2026";
const EM_PX = 40 / 0.72;
const LINE_PX = EM_PX * 1.25;
const DIGIT_REST = [0, 1, 2, 3].map((i) => ({ x: 100 + i * 32, y: 70, w: 18, h: 40 }));

/** The picture at `t` with "2026" coming in on a slot `edge`, each digit's
 * reel drawn through its band as the renderers draw it. */
function reelFrameAt(t: number, edge: OverlayEdge): LetterFrame {
  const data = new Uint8ClampedArray(RW * RH * 4);
  for (let i = 0; i < RW * RH; i++) data.set([0, 0, 0, 255], i * 4);
  const st = evalOverlayAnim({ in: edge }, t, 10, true);
  const em = 1 / 1.25;
  [...DIGITS].forEach((ch, gi) => {
    const g = glyphStateAt(st, gi, DIGITS.length);
    const rest = DIGIT_REST[gi];
    const mid = rest.y + rest.h / 2;
    const band = g.roll ? reelBand(g.reel, em) * LINE_PX : Infinity;
    const reel = g.roll ? slotReel(ch, gi, g.roll, slotSeed(DIGITS), g.reel, em) : [{ ch, y: 0, alpha: 1 }];
    for (const r of reel) {
      const top = Math.round(mid + r.y * LINE_PX - rest.h / 2);
      for (let y = Math.max(0, top, Math.ceil(mid - band)); y < Math.min(RH, top + rest.h, Math.floor(mid + band)); y++)
        for (let x = rest.x; x < rest.x + rest.w; x++) {
          const k = r.alpha * Math.min(1, Math.max(0, g.alpha));
          const i = (y * RW + x) * 4;
          data.set([...mix([data[i], data[i + 1], data[i + 2]], TEAL, k), 255], i);
        }
    }
  });
  return { data, width: RW, height: RH, t };
}

describe("reading a line whose letters roll in on a slot reel", () => {
  // Turning down, its digits 1.6 em apart behind a band 1 em either side,
  // solid, each landing 0.4 em past its slot and settling back.
  const edge: OverlayEdge = {
    style: "slot",
    seconds: 2,
    stagger: 0.6,
    reel: "down",
    pitch: 1.6,
    band: 1,
    overshoot: 0.4,
    settle: 0.3,
    fade: false,
  };
  const frames = Array.from({ length: Math.round((edge.seconds + 0.3) * 30) }, (_, f) => reelFrameAt(f / 30, edge));
  const r = readLetters(frames, { text: DIGITS, region: { x: 90, y: 55, w: 140, h: 70 }, ink: TEAL, unit: RUNIT });

  test("reads it as a reel: its turn, its spacing, its band and its landing", () => {
    const reel = r.edge?.reel;
    expect(reel).toBeDefined();
    expect(reel!.dir).toBe("down");
    const em = EM_PX * RUNIT;
    expect(reel!.pitch / em).toBeCloseTo(1.6, 1);
    expect(reel!.band / em).toBeGreaterThan(0.9);
    expect(reel!.band / em).toBeLessThan(1.1);
    expect(reel!.overshoot / em).toBeGreaterThan(0.3);
    expect(reel!.overshoot / em).toBeLessThan(0.5);
    expect(reel!.settle).toBeGreaterThan(0.2);
    expect(reel!.settle).toBeLessThan(0.4);
    expect(r.edge!.fade).toBe(false);
  });

  test("times the hand-off and each digit's turn", () => {
    expect(r.edge!.sequence).toEqual([0, 1, 2, 3]);
    // Each digit's move is 2 × 0.4 = 0.8s; the starts span 2 × 0.6 = 1.2s.
    expect(r.edge!.move).toBeCloseTo(0.8, 1);
    expect(r.edge!.seconds * r.edge!.stagger).toBeCloseTo(1.2, 1);
    expect(r.edge!.start).toBeCloseTo(0, 1);
  });
});

describe("reading a line whose letters pop in where they stand", () => {
  // Each letter appears whole at its rest, a character every 0.5s — the
  // space takes its turn too: typing.
  const shows = [0.6, 1.1, 1.6, 2.1, 3.1, 3.6];
  const frames = Array.from({ length: 120 }, (_, f) => {
    const t = f / 30;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) data.set([...GROUNDS[0], 255], i * 4);
    REST.forEach((rest, k) => {
      if (t < shows[k]) return;
      for (let y = rest.y; y < rest.y + rest.h; y++)
        for (let x = rest.x; x < rest.x + rest.w; x++) data.set([...RED, 255], (y * W + x) * 4);
    });
    return { data, width: W, height: H, t };
  });

  test("reads a typewriter whose turns land on each letter's frame", () => {
    const e = read(frames).edge;
    expect(e?.typed).toBe(true);
    // "ABCD EF" is 7 characters, the space among them: letter k is glyph g,
    // shown once the typed share passes g / 7.
    const glyphs = [0, 1, 2, 3, 5, 6];
    glyphs.forEach((g, k) => {
      const at = e!.start + (e!.seconds * g) / 7;
      // Typed share passes g / 7 just after `at`: the letter shows on the
      // frame after, within a frame of the reference.
      expect(Math.abs(at - shows[k])).toBeLessThan(0.05);
    });
  });
});
