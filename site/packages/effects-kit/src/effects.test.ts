import { describe, expect, test } from "bun:test";
import { EFFECT_IDS, effectFilterLines, effectPreviewState } from "./effects";

// The bundled engine ffmpeg is LGPL: a recipe reaching for a GPL-only filter
// renders on a dev machine (Homebrew ffmpeg) and fails in the shipped app.
// `eq` is NOT here: it is GPL-licensed and absent from the shipped binary,
// which a dev machine's Homebrew ffmpeg (a GPL build) hides.
const LGPL_FILTERS = new Set([
  "noise",
  "rgbashift",
  "gblur",
  "vignette",
  "scale",
  "crop",
  "split",
  "overlay",
  // The graded looks are effects too, and their chains reach further.
  "format",
  "blend",
  "lutyuv",
  "colorchannelmixer",
  "colorbalance",
  "curves",
  "hue",
  "huesaturation",
  "vibrance",
  "unsharp",
  "colortemperature",
  "geq",
]);

const filterNamesOf = (lines: string[]): string[] => {
  const names: string[] = [];
  for (const line of lines) {
    // Strip labels and quoted expressions, then read each chain step's name.
    const bare = line.replace(/\[[^\]]*\]/g, "").replace(/'[^']*'/g, "''");
    for (const step of bare.split(",")) {
      const name = step.split("=")[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
};

describe("effect recipes", () => {
  test("every effect exports through the LGPL-safe filter set", () => {
    for (const id of EFFECT_IDS) {
      const lines = effectFilterLines("in", "out", id, 0.7, 1, 4, 1080, 1920, "t");
      expect(lines).not.toBe(null);
      for (const name of filterNamesOf(lines!)) {
        expect(LGPL_FILTERS.has(name)).toBe(true);
      }
    }
  });

  test("fragments are time-gated to their window", () => {
    for (const id of EFFECT_IDS) {
      const lines = effectFilterLines("in", "out", id, 0.5, 2.5, 6, 1080, 1920, "t")!;
      const joined = lines.join("\n");
      expect(joined.includes("gte(t,2.5)") || joined.includes("sin(t*")).toBe(true);
    }
  });

  test("unknown ids return null instead of breaking the graph", () => {
    expect(effectFilterLines("in", "out", "nope", 1, 0, 1, 1080, 1920, "t")).toBe(null);
  });

  test("flash decays on the element clock, per frame", () => {
    // geq's `T` is the frame's own time, so the decay renders fresh each
    // frame; the element-local offset keeps the peak at the element start.
    const flash = effectFilterLines("in", "out", "flash", 1, 2.5, 6, 1920, 1080, "t")![0];
    expect(flash.includes("exp(")).toBe(true);
    expect(flash.includes("(T-2.5)")).toBe(true);
  });

  test("shake reads the same clock and travel as its canvas twin", () => {
    const start = 2.5;
    const lines = effectFilterLines("in", "out", "shake", 1, start, 6, 1920, 1080, "t")!;
    const crop = lines.find((l) => l.includes("crop="))!;
    // Element-local time, so the jitter lands on the frames the preview showed.
    expect(crop.includes(`sin((t-${start})*33)`)).toBe(true);
    expect(crop.includes("sin(t*33)")).toBe(false);
    // …and the same travel: 22 design px at a 1080 short side.
    const amp = Number(/\+([\d.]+)\*sin/.exec(crop)![1]);
    const peak = Math.max(
      ...Array.from({ length: 400 }, (_, i) => effectPreviewState("shake", 1, i / 400).dx ?? 0)
    );
    expect(Math.abs(amp - peak)).toBeLessThan(0.5);
  });

  test("a zoom lands the export on the point the preview holds", () => {
    const focus = { x: 0.25, y: 0.8 };
    const st = effectPreviewState("zoom", 1, 9, focus, 0);
    expect(st.origin).toEqual(focus);
    // Cut straight in: the copy is scaled once and cropped back to frame size.
    const lines = effectFilterLines("in", "out", "zoom", 1, 0, 4, 1920, 1080, "t", focus, 0)!;
    const line = lines.find((l) => l.includes("crop="))!;
    const [zw, zh] = /scale=(\d+):(\d+)/.exec(line)!.slice(1).map(Number);
    const [cx, cy] = /crop=1920:1080:(\d+):(\d+)/.exec(line)!.slice(1).map(Number);
    expect(zw / 1920).toBeCloseTo(st.zoom!, 2);
    // The crop sits the same fraction into the overscaled picture as the point
    // sits into the frame, which is what holds it still.
    expect(cx / (zw - 1920)).toBeCloseTo(focus.x, 2);
    expect(cy / (zh - 1080)).toBeCloseTo(focus.y, 2);
  });

  test("a ramped zoom holds its focus while the picture grows into it", () => {
    const focus = { x: 0.25, y: 0.8 };
    const lines = effectFilterLines("in", "out", "zoom", 1, 2.5, 6, 1920, 1080, "t", focus, 0.8)!;
    const over = lines.find((l) => l.includes("overlay="))!;
    // The copy is placed by its live size, offset by the focus fractions, so
    // the point stays put through the whole ramp.
    expect(over.includes("x='-(w-W)*0.25'")).toBe(true);
    expect(over.includes("y='-(h-H)*0.8'")).toBe(true);
    // Element-local clock, so the ramp starts where the element does.
    expect(lines.join("\n").includes("(t-2.5)/0.8")).toBe(true);
  });

  test("design px scale with the short side, so a vertical frame matches", () => {
    const wide = effectFilterLines("in", "out", "blur", 1, 0, 4, 1920, 1080, "t")![0];
    const tall = effectFilterLines("in", "out", "blur", 1, 0, 4, 1080, 1920, "t")![0];
    expect(/sigma=([\d.]+)/.exec(wide)![1]).toBe(/sigma=([\d.]+)/.exec(tall)![1]);
  });

  test("preview state is deterministic in local time", () => {
    for (const id of EFFECT_IDS) {
      const a = effectPreviewState(id, 0.6, 1.234);
      const b = effectPreviewState(id, 0.6, 1.234);
      expect(a).toEqual(b);
    }
  });

  test("flash decays from its start and shake stays bounded", () => {
    const early = effectPreviewState("flash", 1, 0.05).flash!;
    const late = effectPreviewState("flash", 1, 0.5).flash!;
    expect(early).toBeGreaterThan(late);
    const s = effectPreviewState("shake", 1, 0.37);
    expect(Math.abs(s.dx ?? 0)).toBeLessThanOrEqual(22);
    expect(Math.abs(s.dy ?? 0)).toBeLessThanOrEqual(22);
  });
});
