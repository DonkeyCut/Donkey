import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import {
  CARET_BLINK_SECONDS,
  caretOn,
  caretToggles,
  evalOverlayAnim,
  hasOverlayAnim,
  hitWindow,
  OVERLAY_HIT_DEFAULT_SECONDS,
  OVERLAY_HIT_STYLE_IDS,
  type OverlayAnim,
} from "./anim";
import { evalOverlayFrame } from "./keys";
import { MOTION, presetsFor } from "./motion/catalog";
import { WORD_EFFECT_IDS } from "./words/catalog";
import { darkenCanvas, ElementFx, elementLook } from "./elementFx";
import { paintElement, planAnimatedLayers, renderOverlayFrames, type RenderEnv } from "./render";
import type { ShapeOverlay, TextOverlay } from "./types";

const B = CARET_BLINK_SECONDS;
const typed = (caret: NonNullable<OverlayAnim["in"]>["caret"]): OverlayAnim => ({
  in: { style: "typewriter", seconds: 1, caret },
});

describe("the typing caret", () => {
  test("holds solid while typing, then blinks lit and dark by turns", () => {
    const anim = typed({ blink: true });
    expect(caretOn(anim, 0, 10)).toBe(true);
    expect(caretOn(anim, 0.99, 10)).toBe(true);
    expect(caretOn(anim, 1 + B * 0.5, 10)).toBe(true);
    expect(caretOn(anim, 1 + B * 1.5, 10)).toBe(false);
    expect(caretOn(anim, 1 + B * 2.5, 10)).toBe(true);
    expect(caretOn(anim, 1 + B * 3.5, 10)).toBe(false);
  });

  test("stops after its blinks, lit or gone", () => {
    const after = 1 + B * 2 * 2 + 0.1;
    expect(caretOn(typed({ blink: true, blinks: 2 }), after, 10)).toBe(true);
    expect(caretOn(typed({ blink: true, blinks: 2 }), after + 3, 10)).toBe(true);
    expect(caretOn(typed({ blink: true, blinks: 2, hide: true }), after, 10)).toBe(false);
    // Without blinking it holds, or goes the moment typing stops.
    expect(caretOn(typed({ blink: false }), 5, 10)).toBe(true);
    expect(caretOn(typed({ blink: false, hide: true }), 5, 10)).toBe(false);
    expect(caretOn(typed({ blink: false, hide: true }), 0.5, 10)).toBe(true);
  });

  test("turns exactly where the samplers cut", () => {
    const toggles = caretToggles(typed({ blink: true, blinks: 2, hide: true }), 10);
    expect(toggles.map((t) => +t.toFixed(3))).toEqual([1 + B, 1 + 2 * B, 1 + 3 * B].map((t) => +t.toFixed(3)));
    const forever = caretToggles(typed({ blink: true }), 4);
    expect(forever.length).toBe(Math.floor((4 - 1 - 1e-9) / B));
    expect(caretToggles(typed({ blink: false, hide: true }), 4)).toEqual([1]);
    expect(caretToggles(typed({ blink: false }), 4)).toEqual([]);
  });

  test("only a typing entrance on a title carries it", () => {
    expect(caretOn({ in: { style: "fade", seconds: 1, caret: { blink: true } } }, 0.5, 4)).toBeUndefined();
    expect(evalOverlayAnim(typed({ blink: true }), 0.5, 4, true).caret).toBe(true);
    expect(evalOverlayAnim(typed({ blink: true }), 0.5, 4, false).caret).toBeUndefined();
    expect(evalOverlayFrame({ start: 0, end: 4, x: 0.5, y: 0.5, anim: typed({ blink: true }) }, 1 + B * 1.5).caret).toBe(false);
  });

  test("the canvas export cuts its windows at every turn", () => {
    const o: TextOverlay = { id: "t", text: "LINK", start: 2, end: 5, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 700, color: "#fff", plate: false, shadow: false, anim: typed({ blink: true }) };
    const layers = planAnimatedLayers(o, 10);
    // Every slice of the typing ramp has the bar lit.
    for (const l of layers.filter((l) => l.end <= 3 + 1e-9)) expect(l.phase?.caret).toBe(true);
    const rest = layers.filter((l) => l.start >= 3 - 1e-9);
    expect(rest.length).toBe(caretToggles(o.anim, 3).length + 1);
    rest.forEach((l, i) => expect(!!l.phase?.caret).toBe(i % 2 === 0));
  });

  test("the canvas export types along a composed typewriter's own keys", () => {
    // The bar blinks alone for half a second, three letters land at once,
    // and the rest at 1s: the preview reads these keys, so the export must.
    const anim: OverlayAnim = {
      in: {
        style: "typewriter",
        seconds: 2,
        caret: { blink: false },
        preset: { label: "Typewriter", slots: ["in", "out"], animate: { typed: [{ t: 0, v: 0, hold: true }, { t: 0.25, v: 0.5, hold: true }, { t: 0.5, v: 1 }] } },
      },
    };
    const o: TextOverlay = { id: "t", text: "MOMENT", start: 0, end: 4, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 500, color: "#fff", plate: false, shadow: false, anim };
    const layers = planAnimatedLayers(o, 10);
    const at = (t: number) => layers.find((l) => l.start <= t && t < l.end)!;
    expect(at(0.1).phase?.typed).toBe(0);
    expect(at(0.1).phase?.caret).toBe(true);
    expect(at(0.6).phase?.typed).toBe(3);
    expect(at(1.5).phase?.typed).toBe(6);
  });
});

const env: RenderEnv = {
  fontStack: () => "Arial",
  createCanvas: (w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement,
  canvasToPngBlob: async (c) => new Blob([new Uint8Array(await (c as unknown as Canvas).toBuffer("png"))]),
};

describe("the caret on canvas", () => {
  test("draws a bar past the last character, in the text's color unless set", async () => {
    const o: TextOverlay = { id: "t", text: "LINK", start: 0, end: 4, x: 0.5, y: 0.5, size: 80, font: "sf", weight: 700, color: "#ffffff", plate: false, shadow: false, anim: typed({ blink: true, color: "#ff0000" }) };
    const paint = async (caret: boolean) => {
      const c = new Canvas(1080, 1080);
      const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
      await paintElement(ctx, o, { width: 1080, height: 1080, scale: 1, phase: caret ? { caret } : undefined }, env);
      return ctx.getImageData(0, 0, 1080, 1080).data;
    };
    const lit = await paint(true);
    const dark = await paint(false);
    let red = 0;
    let redRight = 0;
    for (let i = 0; i < lit.length; i += 4) {
      if (lit[i] > 200 && lit[i + 1] < 60 && lit[i + 2] < 60 && lit[i + 3] > 200) {
        red++;
        if ((i / 4) % 1080 > 540) redRight++;
      }
      if (dark[i] > 200 && dark[i + 1] < 60 && dark[i + 2] < 60 && dark[i + 3] > 200) throw new Error("bar drawn while dark");
    }
    expect(red).toBeGreaterThan(80 * 0.07 * 80 * 0.8);
    expect(redRight).toBe(red);
  });

  test("hugs the last letter however wide the tracking", async () => {
    // The gap from the last typed letter's ink to the bar, in columns. A browser
    // counts the tracking after a run's last letter in its width, where skia
    // leaves it out; `browser` measures the browser's way.
    const gapAt = async (letterSpacing: number, browser: boolean) => {
      const o: TextOverlay = { id: "t", text: "LINK", start: 0, end: 4, x: 0.5, y: 0.5, size: 80, font: "sf", weight: 700, color: "#ffffff", letterSpacing, plate: false, shadow: false, anim: typed({ blink: true, color: "#ff0000" }) };
      const c = new Canvas(1080, 1080);
      const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
      if (browser) {
        const measure = ctx.measureText.bind(ctx);
        ctx.measureText = (text: string) => {
          const m = measure(text);
          const trail = text ? parseFloat(ctx.letterSpacing) || 0 : 0;
          return Object.create(m, { width: { value: m.width + trail } });
        };
      }
      await paintElement(ctx, o, { width: 1080, height: 1080, scale: 1, phase: { caret: true, typed: 3 } }, env);
      const px = ctx.getImageData(0, 0, 1080, 1080).data;
      let white = 0;
      let red = 1080;
      for (let i = 0; i < px.length; i += 4) {
        const col = (i / 4) % 1080;
        if (px[i] > 200 && px[i + 1] > 200 && px[i + 3] > 200) white = Math.max(white, col);
        if (px[i] > 200 && px[i + 1] < 60 && px[i + 2] < 60 && px[i + 3] > 200) red = Math.min(red, col);
      }
      return red - white;
    };
    for (const browser of [false, true]) {
      expect(Math.abs((await gapAt(0.5, browser)) - (await gapAt(0, browser)))).toBeLessThanOrEqual(2);
    }
  });
});

describe("the press", () => {
  const press = (darken: boolean): OverlayAnim => ({ hit: { style: "press", at: 1, seconds: 0.3, darken } });

  test("is in the catalog every list reads", () => {
    expect(OVERLAY_HIT_STYLE_IDS).toContain("press");
    expect(OVERLAY_HIT_STYLE_IDS.sort()).toEqual(Object.keys(MOTION.hits).sort());
    expect(presetsFor("hit").map((p) => p.id)).toContain("press");
    for (const p of Object.values(MOTION.hits)) expect(p.note?.length ?? 0).toBeGreaterThan(0);
    expect(hasOverlayAnim(press(false))).toBe(true);
  });

  test("dips to about 93% and springs back, inside its own window only", () => {
    const scale = (t: number) => evalOverlayAnim(press(false), t, 4).scale;
    expect(scale(0.99)).toBe(1);
    expect(scale(1.31)).toBe(1);
    const curve = Array.from({ length: 31 }, (_, i) => scale(1 + i * 0.01));
    const low = Math.min(...curve);
    expect(low).toBeGreaterThan(0.92);
    expect(low).toBeLessThan(0.94);
    const bottom = curve.indexOf(low);
    // Down fast, back up slower: monotone on both sides of the bottom.
    for (let i = 1; i <= bottom; i++) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1] + 1e-9);
    for (let i = bottom + 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1] - 1e-9);
    expect(bottom / 30).toBeLessThan(0.5);
  });

  test("darkens only when asked", () => {
    expect(evalOverlayAnim(press(false), 1.1, 4).brightness).toBeUndefined();
    const b = evalOverlayAnim(press(true), 1.1, 4).brightness!;
    expect(b).toBeLessThan(1);
    expect(b).toBeGreaterThan(0.75);
    expect(evalOverlayAnim(press(true), 2, 4).brightness).toBeUndefined();
  });

  test("its window stays inside the element", () => {
    expect(hitWindow(press(true), 4)).toEqual({ start: 1, end: 1.3 });
    expect(hitWindow({ hit: { style: "press", at: 3.9, seconds: 0.3 } }, 4)!.end).toBe(4);
    expect(hitWindow({ hit: { style: "gone", at: 1, seconds: 0.3 } }, 4)).toBeNull();
  });

  test("a stored press without seconds plays for the default length", () => {
    const bare = { hit: { style: "press", at: 1 } } as unknown as OverlayAnim;
    expect(hitWindow(bare, 4)).toEqual({ start: 1, end: 1 + OVERLAY_HIT_DEFAULT_SECONDS });
    expect(evalOverlayAnim(bare, 1.1, 4)).not.toEqual(evalOverlayAnim(bare, 2, 4));
  });

  test("darkenCanvas multiplies color and leaves alpha", () => {
    const c = new Canvas(4, 4);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = "rgba(200, 100, 50, 1)";
    ctx.fillRect(0, 0, 2, 4);
    darkenCanvas(ctx, 4, 4, 0.5);
    const d = ctx.getImageData(0, 0, 4, 4).data;
    expect(d[0]).toBeCloseTo(100, -1);
    expect(d[1]).toBeCloseTo(50, -1);
    expect(d[3]).toBe(255);
    expect(d[2 * 4 + 3]).toBe(0);
  });

  test("a darkening hit dims the element and leaves the frame under it", () => {
    const c = new Canvas(4, 4);
    const ctx = c.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = "rgb(0, 0, 200)";
    ctx.fillRect(0, 0, 4, 4);
    const fx = new ElementFx((w, h) => new Canvas(w, h) as unknown as HTMLCanvasElement);
    const into = fx.begin(ctx, 4, 4, elementLook({ brightness: 0.5 }, 1));
    expect(into).not.toBe(ctx);
    into.fillStyle = "rgb(200, 200, 200)";
    into.fillRect(0, 0, 2, 4);
    fx.end(ctx);
    const d = ctx.getImageData(0, 0, 4, 4).data;
    expect(d[0]).toBeCloseTo(100, -1);
    expect(d[2 * 4 + 2]).toBe(200);
  });

  test("the frame sampler plays the press frame by frame and holds the rest still", async () => {
    const o: ShapeOverlay = { id: "s", kind: "shape", shape: "rect", start: 0, end: 4, x: 0.5, y: 0.5, w: 0.2, h: 0.1, fill: "#ffffff", anim: press(true) };
    const set = await renderOverlayFrames(o, 540, 960, 30, env);
    const total = set.entries.reduce((a, e) => a + e.duration, 0);
    expect(total).toBeCloseTo(4, 6);
    // Two still pieces share one picture; the 0.3s press is nine frames.
    expect(set.images.length).toBe(1 + 9);
    expect(set.entries[0].image).toBe(set.entries[set.entries.length - 1].image);
  });

  test("a press over a loop costs one cycle and the press, however long the element runs", async () => {
    const o: ShapeOverlay = { id: "s", kind: "shape", shape: "rect", start: 0, end: 60, x: 0.5, y: 0.5, w: 0.2, h: 0.1, fill: "#ffffff", anim: { ...press(false), loop: { style: "pulse", speed: 1 } } };
    const set = await renderOverlayFrames(o, 270, 480, 30, env);
    expect(set.entries.reduce((a, e) => a + e.duration, 0)).toBeCloseTo(60, 6);
    expect(set.images.length).toBeLessThan(200);
  });

  test("a press over a word effect costs the word pictures and the press", async () => {
    const o: TextOverlay = { id: "t", text: "one two three four", start: 0, end: 60, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 700, color: "#fff", plate: false, shadow: false, anim: { ...press(false), words: { style: WORD_EFFECT_IDS[0] } } };
    const set = await renderOverlayFrames(o, 270, 480, 30, env);
    expect(set.entries.reduce((a, e) => a + e.duration, 0)).toBeCloseTo(60, 6);
    expect(set.images.length).toBeLessThan(200);
  });

  test("a blink over a loop keeps the bar's turns", async () => {
    const o: TextOverlay = { id: "t", text: "LINK", start: 0, end: 20, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 700, color: "#fff", plate: false, shadow: false, anim: { ...typed({ blink: true }), loop: { style: "pulse", speed: 1 } } };
    const set = await renderOverlayFrames(o, 270, 480, 30, env);
    expect(set.entries.reduce((a, e) => a + e.duration, 0)).toBeCloseTo(20, 6);
    expect(set.images.length).toBeLessThan(200);
  });

  test("the frame sampler draws a blink as two pictures", async () => {
    const o: TextOverlay = { id: "t", text: "LINK", start: 0, end: 4, x: 0.5, y: 0.5, size: 60, font: "sf", weight: 700, color: "#fff", plate: false, shadow: false, anim: typed({ blink: true }) };
    const set = await renderOverlayFrames(o, 540, 960, 30, env);
    expect(set.entries.reduce((a, e) => a + e.duration, 0)).toBeCloseTo(4, 6);
    // The typing ramp frame by frame, then the middle as lit and dark.
    expect(set.images.length).toBe(30 + 2);
  });
});
