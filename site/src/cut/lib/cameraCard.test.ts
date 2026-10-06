import { describe, expect, test } from "bun:test";
import {
  aboveShare,
  cameraCardLayout,
  CARD_DEFAULTS,
  defaultCardWidth,
  newCard,
  normalizeCard,
  resolveCardShape,
  traceCardPath,
  type CardLayout,
  type PathSink,
} from "./cameraCard";
import { frameOf } from "./types";

// The reference layout at 1080×1920: card 1210×864 at x −65, y 1200, top
// corners 200; a 16:9 source at 1890×1063 from x −405, y 1008; the head
// fading out over 40px under the card's top edge.

const FRAME = { x: 0, y: 0, w: 1080, h: 1920 };
const near = (a: number, b: number, tol = 2) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe("camera card geometry", () => {
  test("the defaults reproduce the reference layout for a 16:9 source", () => {
    const L = cameraCardLayout(newCard(), FRAME, 1920, 1080, 1);
    expect(L.card.x).toBe(-65);
    expect(L.card.y).toBe(1200);
    expect(L.card.w).toBe(1210);
    // The card runs past the frame bottom, so its bottom edge never shows.
    expect(L.card.y + L.card.h).toBeGreaterThan(1920);
    expect(L.radius).toBe(200);
    near(L.picture.x, -405);
    near(L.picture.y, 1008);
    near(L.picture.w, 1890);
    near(L.picture.h, 1063);
  });

  test("the pop-out band runs from the box top to the card edge and fades over the feather", () => {
    const L = cameraCardLayout(newCard(), FRAME, 1920, 1080, 1);
    expect(L.band).toEqual({ top: 0, edge: 1200, bottom: 1240, left: 0, right: 1080 });
    const flat = cameraCardLayout({ ...newCard(), feather: 0 }, FRAME, 1920, 1080, 1);
    expect(flat.band.bottom).toBe(flat.band.edge);
  });

  test("lengths scale with the frame's design scale", () => {
    const L = cameraCardLayout(newCard(), { x: 0, y: 0, w: 540, h: 960 }, 1920, 1080, 0.5);
    expect(L.card.x).toBe(-32.5);
    expect(L.card.y).toBe(600);
    expect(L.radius).toBe(100);
    expect(L.band.bottom).toBe(620);
  });

  test("a portrait source covers the card and carries the head above its edge", () => {
    const L = cameraCardLayout(newCard(), FRAME, 1080, 1920, 1);
    // Wide enough that the card never shows past the picture's sides.
    expect(L.picture.w).toBeGreaterThanOrEqual(FRAME.w - 1e-6);
    near(L.picture.h / L.picture.w, 1920 / 1080, 0.001);
    // The top 40% of a selfie — where the head sits — clears the card.
    expect(L.picture.y + 0.4 * L.picture.h).toBeLessThanOrEqual(L.card.y);
    // And the picture reaches the frame bottom.
    expect(L.picture.y + L.picture.h).toBeGreaterThanOrEqual(1920);
    expect(aboveShare(9 / 16)).toBeGreaterThan(aboveShare(1));
    expect(aboveShare(1)).toBeGreaterThan(aboveShare(16 / 9));
  });

  test("scale keeps the same share of the picture above the card; offsets shift it", () => {
    const base = cameraCardLayout(newCard(), FRAME, 1920, 1080, 1);
    const big = cameraCardLayout({ ...newCard(), scale: 1.5 }, FRAME, 1920, 1080, 1);
    near(big.picture.w, base.picture.w * 1.5, 0.01);
    near((big.card.y - big.picture.y) / big.picture.h, (base.card.y - base.picture.y) / base.picture.h, 1e-6);
    near(big.picture.x + big.picture.w / 2, 540, 1e-6);
    const moved = cameraCardLayout({ ...newCard(), offsetX: 0.1, offsetY: -0.05 }, FRAME, 1920, 1080, 1);
    near(moved.picture.x - base.picture.x, 108, 1e-6);
    near(moved.picture.y - base.picture.y, -96, 1e-6);
  });

  test("the card follows its top inside a regioned box", () => {
    const box = { x: 100, y: 200, w: 400, h: 800 };
    const L = cameraCardLayout({ ...newCard(), top: 0.5 }, box, 1920, 1080, 1);
    expect(L.card.y).toBe(600);
    expect(L.band.top).toBe(200);
    near(L.picture.x + L.picture.w / 2, 300, 1e-6);
  });

  test("normalize clamps every field and drops identity footage fields", () => {
    const c = normalizeCard({ ...newCard(), top: 5, radius: -3, shadow: 2, scale: 1, offsetX: 0, feather: Number.NaN });
    expect(c.top).toBe(0.9);
    expect(c.radius).toBe(0);
    expect(c.shadow).toBe(1);
    expect(c.feather).toBe(CARD_DEFAULTS.feather);
    expect(c.scale).toBeUndefined();
    expect(c.offsetX).toBeUndefined();
  });

  test("the outline rounds only the top corners", () => {
    const calls: string[] = [];
    const sink: PathSink = {
      moveTo: (x, y) => calls.push(`M${x},${y}`),
      lineTo: (x, y) => calls.push(`L${x},${y}`),
      bezierCurveTo: (_a, _b, _c, _d, x, y) => calls.push(`C${x},${y}`),
      closePath: () => calls.push("Z"),
    };
    traceCardPath(sink, { x: 0, y: 100, w: 1000, h: 500 }, 100);
    expect(calls).toEqual(["M0,600", "L0,230", "C130,100", "L870,100", "C1000,230", "L1000,600", "Z"]);
  });
});

// Every frame shape, with a landscape and a portrait source: the card lands
// on its side and bleeds off the frame there, the footage covers the card's
// part in view, and the head clears the card's top edge inside the frame.

const SHAPES = ["9:16", "4:5", "1:1", "16:9", "21:9"] as const;
const SOURCES = [
  { name: "16:9", w: 1920, h: 1080 },
  { name: "9:16", w: 1080, h: 1920 },
] as const;
const EPS = 1e-6;

function inView(L: CardLayout, box: { x: number; y: number; w: number; h: number }) {
  return { left: Math.max(box.x, L.card.x), right: Math.min(box.x + box.w, L.card.x + L.card.w) };
}

describe("camera card in every frame shape", () => {
  for (const aspect of SHAPES) {
    for (const src of SOURCES) {
      test(`${aspect} frame, ${src.name} source`, () => {
        const fr = frameOf(aspect);
        const box = { x: 0, y: 0, w: fr.w, h: fr.h };
        const ds = Math.min(fr.w, fr.h) / 1080;
        const L = cameraCardLayout(newCard(), box, src.w, src.h, ds);
        const view = inView(L, box);
        const portrait = fr.w < fr.h;

        // The side follows the frame shape.
        expect(L.side).toBe(portrait ? "bottom" : "right");
        // The card bleeds off the bottom, and off both sides or its own side.
        expect(L.card.y + L.card.h).toBeGreaterThan(box.h);
        expect(L.card.x + L.card.w).toBeGreaterThan(box.w);
        if (portrait) {
          expect(L.card.x).toBeLessThan(0);
          // The graphic keeps at least half the frame above the card.
          expect(L.card.y).toBeGreaterThanOrEqual(box.h / 2);
        } else {
          // A side card leaves the graphic most of the frame: a third to two
          // fifths of it wide, its inner edge in view.
          const share = (view.right - view.left) / box.w;
          expect(share).toBeGreaterThanOrEqual(1 / 3 - EPS);
          expect(share).toBeLessThanOrEqual(0.4 + EPS);
          expect(L.card.x).toBeGreaterThan(box.w / 2);
        }
        expect(L.card.y).toBeGreaterThan(box.h * 0.2);
        expect(L.card.y).toBeLessThan(box.h);

        // The footage covers the card's part in view, down past the frame.
        expect(L.picture.x).toBeLessThanOrEqual(view.left + EPS);
        expect(L.picture.x + L.picture.w).toBeGreaterThanOrEqual(view.right - EPS);
        expect(L.picture.y + L.picture.h).toBeGreaterThanOrEqual(box.h - EPS);
        // The speaker keeps a size the card holds: the middle three tenths
        // of the source fit across it.
        expect(0.3 * L.picture.w).toBeLessThanOrEqual(view.right - view.left + EPS);

        // The head clears the card's top edge and stays inside the frame.
        near(L.card.y - L.picture.y, aboveShare(src.w / src.h) * L.picture.h, 1e-6);
        expect(L.picture.y).toBeGreaterThanOrEqual(-EPS);
        // The pop-out band runs over the card's columns, top of frame to edge.
        expect(L.band.left).toBeCloseTo(view.left, 6);
        expect(L.band.right).toBeCloseTo(view.right, 6);
        expect(L.band.top).toBe(0);
        expect(L.band.edge).toBe(L.card.y);
      });
    }
  }

  test("a side card's default width runs from two fifths of a square to a third of 21:9", () => {
    expect(defaultCardWidth(1)).toBeCloseTo(0.4, 6);
    expect(defaultCardWidth(21 / 9)).toBeCloseTo(1 / 3, 6);
    expect(defaultCardWidth(16 / 9)).toBeLessThan(defaultCardWidth(1));
    expect(defaultCardWidth(16 / 9)).toBeGreaterThan(defaultCardWidth(21 / 9));
  });

  test("a picked side holds in any frame", () => {
    const fr = frameOf("16:9");
    const box = { x: 0, y: 0, w: fr.w, h: fr.h };
    const left = cameraCardLayout({ ...newCard(), side: "left" }, box, 1920, 1080, 1);
    expect(left.side).toBe("left");
    expect(left.card.x).toBe(-CARD_DEFAULTS.sideBleed);
    near(left.picture.x + left.picture.w / 2, inView(left, box).right / 2, 1e-6);
    expect(left.band.left).toBe(0);

    const bottom = cameraCardLayout({ ...newCard(), side: "bottom" }, box, 1920, 1080, 1);
    expect(bottom.card.w).toBe(fr.w + 2 * CARD_DEFAULTS.sideBleed);
    expect(bottom.picture.w).toBeGreaterThanOrEqual(fr.w - EPS);

    const tall = frameOf("9:16");
    const side = cameraCardLayout({ ...newCard(), side: "right" }, { x: 0, y: 0, w: tall.w, h: tall.h }, 1920, 1080, 1);
    expect(side.card.x).toBeGreaterThan(0);
    expect(side.picture.y).toBeGreaterThanOrEqual(-EPS);
    expect(side.picture.y + side.picture.h).toBeGreaterThanOrEqual(tall.h - EPS);
  });

  test("a default top moves down for a source that needs the headroom; a named one holds", () => {
    const fr = frameOf("21:9");
    const auto = resolveCardShape({}, fr.w, fr.h, 1080, 1920);
    expect(auto.top).toBeGreaterThan(0.45);
    const named = resolveCardShape({ top: 0.4 }, fr.w, fr.h, 1080, 1920);
    expect(named.top).toBe(0.4);
    // Landscape footage keeps the side card's own default.
    expect(resolveCardShape({}, fr.w, fr.h, 1920, 1080).top).toBe(0.45);
  });

  test("normalize keeps a known side and drops an unknown one", () => {
    expect(normalizeCard({ ...newCard(), side: "left" }).side).toBe("left");
    expect(normalizeCard({ ...newCard(), side: "top" as never }).side).toBeUndefined();
    expect(normalizeCard({ ...newCard(), width: 5 }).width).toBe(0.7);
    expect(normalizeCard(newCard()).top).toBeUndefined();
  });
});
