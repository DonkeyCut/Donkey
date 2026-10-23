import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { Canvas } from "skia-canvas";
import { applyEffectToCanvas, effectFilterLines, effectPreviewState, type FlashPulse } from "./effects";
import { TEST_FFMPEG } from "./testing/ffmpeg";

type Surface = HTMLCanvasElement;
const W = 64;
const H = 16;
const FPS = 30;
const DUR = 1;
const GREY = 120;
const noGrain = () => null;

function grey(): Surface {
  const c = new Canvas(W, H) as unknown as Surface;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = `rgb(${GREY},${GREY},${GREY})`;
  ctx.fillRect(0, 0, W, H);
  return c;
}

/** The middle pixel of a grey frame after the canvas pass at `tLocal`. */
function canvasAt(tLocal: number, pulse: FlashPulse): number[] {
  const c = grey();
  applyEffectToCanvas(c, grey(), "flash", 1, tLocal, noGrain, undefined, undefined, DUR, "opaque", pulse);
  return Array.from(c.getContext("2d")!.getImageData(W / 2, H / 2, 1, 1).data.slice(0, 3));
}

describe("a flash that fades", () => {
  test("fading to its tone ramps from clear to the full tone across the element", () => {
    const at = (t: number) => effectPreviewState("flash", 1, t, undefined, undefined, DUR, { tone: "black", fade: "to" });
    expect(at(0).flash ?? 0).toBeCloseTo(0, 5);
    expect(at(0.5).flash).toBeCloseTo(0.5, 5);
    expect(at(DUR).flash).toBeCloseTo(1, 5);
    expect(at(0.5).flashTone).toBe("black");
  });

  test("fading from its tone starts full and clears by the element's end", () => {
    const at = (t: number) => effectPreviewState("flash", 1, t, undefined, undefined, DUR, { tone: "black", fade: "from" });
    expect(at(0).flash).toBeCloseTo(1, 5);
    expect(at(0.25).flash).toBeCloseTo(0.75, 5);
    expect(at(DUR).flash ?? 0).toBeCloseTo(0, 5);
  });

  test("the amount caps how far it fades", () => {
    expect(effectPreviewState("flash", 0.5, DUR, undefined, undefined, DUR, { fade: "to" }).flash).toBeCloseTo(0.5, 5);
  });

  test("an eased fade runs along its curve and still lands on the full tone", () => {
    const at = (t: number, fade: "to" | "from") =>
      effectPreviewState("flash", 1, t, undefined, undefined, DUR, { tone: "black", fade, fadeEase: "power2.out" }).flash ?? 0;
    // Quick at first: three quarters of the way there by half time.
    expect(at(0.5, "to")).toBeCloseTo(0.75, 5);
    expect(at(DUR, "to")).toBeCloseTo(1, 5);
    // Out of the tone the same way: a quarter left by half time.
    expect(at(0, "from")).toBeCloseTo(1, 5);
    expect(at(0.5, "from")).toBeCloseTo(0.25, 5);
  });

  test("a full fade to black ends on black in the canvas pass", () => {
    expect(Math.max(...canvasAt(DUR - 1e-6, { tone: "black", fade: "to" }))).toBeLessThan(2);
  });

  for (const tone of ["black", "white"] as const) {
    test(`ffmpeg fades to and from ${tone} the way the canvas does`, () => {
      for (const [fade, fadeEase] of [["to", undefined], ["from", undefined], ["to", "sine.out"], ["from", "power3.in"]] as const) {
        const pulse: FlashPulse = { tone: tone === "black" ? "black" : undefined, fade, ...(fadeEase ? { fadeEase } : {}) };
        const chroma = { pixFmt: "yuv444p", overlay: ":format=yuv444" };
        const lines = effectFilterLines("in", "out", "flash", 1, 0, DUR, W, H, "t", undefined, undefined, chroma, pulse)!;
        const graph = `color=c=0x787878:s=${W}x${H}:r=${FPS}:d=${DUR},format=yuv444p[in];${lines.join(";")}`;
        const run = spawnSync(TEST_FFMPEG, ["-v", "error", "-filter_complex", graph, "-map", "[out]", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], {
          maxBuffer: 16 << 20,
        });
        expect(run.status).toBe(0);
        const out = run.stdout as Buffer;
        for (const f of [0, 8, 15, 22, 29]) {
          const base = f * W * H * 3 + ((H / 2) * W + W / 2) * 3;
          const ours = canvasAt(f / FPS, pulse);
          for (let c = 0; c < 3; c++) expect(Math.abs(out[base + c] - ours[c])).toBeLessThan(6);
        }
      }
    });
  }
});
