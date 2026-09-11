/**
 * Smooth slow motion: the picture between two source frames.
 *
 * A clip slowed below 1× has fewer source frames than output frames, so the
 * plain render shows each source frame several times and the motion steps.
 * With smoothing on, the frames in between are made from the two source
 * frames around them.
 *
 * Two makers. The preview blends the pair — a crossfade weighted by where
 * the output frame falls between them — because it costs two draws and runs
 * inside the frame budget. The export estimates the motion: RIFE, a frame
 * interpolation network, run in the tab on WebGPU through ONNX Runtime, so
 * a subject moves to where it would have been. A browser without WebGPU
 * exports the blend, the one place the estimate cannot run; the ffmpeg
 * exports (ProRes, headless, the engine's fallback) estimate motion with
 * ffmpeg's own interpolation filter instead.
 *
 * The model and the runtime are staged under public/ at install
 * (scripts/stage-frame-synth.mjs) and fetched on first use.
 */

import { createRasterCanvas, type RasterSurface } from "@/cut/lib/raster";

/** Below this share of the way to the next frame the first frame shows as
 * is, and above its mirror the next one does: a synthesized frame this close
 * to a real one is the real one with noise. */
export const SYNTH_EDGE = 0.02;

/** Where an output frame at source second `t` falls between the source
 * frames at `a` and `b`: 0 at `a`, 1 at `b`. */
export function synthWeight(t: number, a: number, b: number): number {
  const span = b - a;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (t - a) / span));
}

/** Draw `a` crossfaded toward `b` by `w` onto a canvas of `w × h` pixels. */
export function blendInto(
  canvas: RasterSurface,
  a: CanvasImageSource,
  b: CanvasImageSource,
  w: number
): void {
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) return;
  ctx.globalAlpha = 1;
  ctx.drawImage(a, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = w;
  ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
}

/** Canvases a maker hands out in turn before reusing one. A frame draws
 * from up to two synthesized pictures at once — the two sides of a cross
 * dissolve — so each has to survive the call after it. */
export const SYNTH_OUTS = 3;

/** A frame maker: the picture `w` of the way from `a` to `b`, drawn at
 * `width × height`. The canvas returned is the maker's own; it stays as
 * drawn through the next `SYNTH_OUTS − 1` calls and is redrawn after. `key`
 * names the pair, so a maker that does heavy work per pair can keep it
 * across the output frames between the same two sources. */
export interface FrameSynth {
  mid(
    key: string,
    a: CanvasImageSource,
    b: CanvasImageSource,
    width: number,
    height: number,
    w: number
  ): Promise<RasterSurface>;
  dispose(): void;
}

/** The blend as a maker, for the export on a machine without WebGPU. */
export function blendSynth(): FrameSynth {
  const outs = new OutRing();
  return {
    async mid(_key, a, b, width, height, w) {
      const out = outs.next(width, height);
      blendInto(out, a, b, w);
      return out;
    },
    dispose() {
      outs.clear();
    },
  };
}

/** The canvases a maker returns, handed out round-robin. */
class OutRing {
  private outs: RasterSurface[] = [];
  private at = 0;
  next(width: number, height: number): RasterSurface {
    const i = this.at;
    this.at = (i + 1) % SYNTH_OUTS;
    let c = this.outs[i];
    if (!c) c = this.outs[i] = createRasterCanvas(width, height);
    if (c.width !== width) c.width = width;
    if (c.height !== height) c.height = height;
    return c;
  }
  clear(): void {
    this.outs = [];
  }
}

/** Keep in step with scripts/stage-frame-synth.mjs, which stages both. */
const MODEL_URL = "/models/rife_v4.25.onnx";
const RUNTIME_DIR = "/ort/";
/** The model's convolutions stride the picture down five times. */
const MULTIPLE = 32;
/** Pixels the network runs over at most. A bigger frame is estimated at this
 * size and the result drawn up to the frame's own: the slow stretch of a 4K
 * clip is a touch softer, and the estimate stays a fraction of a second. */
const AREA_CAP = 1920 * 1088;
/** Planes of the model's one input: the two pictures, the timestep, and
 * the sampling grid it warps with. */
const PLANES = 11;

type Ort = typeof import("onnxruntime-web/webgpu");

/** Whether this browser can run the estimate. */
export async function hasFrameSynthGpu(): Promise<boolean> {
  const gpu = (
    globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown | null> } }
  )?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/**
 * The motion-estimating maker. `create` loads the runtime and the model,
 * and rejects when either cannot be had — that is the caller's error to
 * surface, since a machine with WebGPU has no better maker to fall back on.
 */
export class RifeSynth implements FrameSynth {
  private constructor(
    private readonly ort: Ort,
    private readonly session: import("onnxruntime-web/webgpu").InferenceSession
  ) {}

  static async create(): Promise<RifeSynth> {
    const ort = await import("onnxruntime-web/webgpu");
    ort.env.wasm.wasmPaths = RUNTIME_DIR;
    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    });
    return new RifeSynth(ort, session);
  }

  /** The network's picture size for the last pair, and the padded size it ran at. */
  private inner = { w: 0, h: 0, W: 0, H: 0 };
  /** The staged input: both pictures packed, grid planes filled, timestep
   * rewritten per call. */
  private input: Float32Array | null = null;
  private pairKey = "";
  /** Canvas the pictures are read through, at the padded size. */
  private stage: RasterSurface | null = null;
  /** The estimate at the padded size, and the frames handed back. */
  private mid_: RasterSurface | null = null;
  private pixels: ImageData | null = null;
  private outs = new OutRing();

  async mid(
    key: string,
    a: CanvasImageSource,
    b: CanvasImageSource,
    width: number,
    height: number,
    w: number
  ): Promise<RasterSurface> {
    const { w: iw, h: ih, W, H } = this.sizeFor(width, height);
    if (this.pairKey !== key || !this.input) {
      this.pack(a, b, iw, ih, W, H);
      this.pairKey = key;
    }
    const input = this.input!;
    input.fill(w, 6 * W * H, 7 * W * H);
    const { ort, session } = this;
    const tensor = new ort.Tensor("float32", input, [1, PLANES, H, W]);
    const result = await session.run({ input: tensor });
    const outT = result.output;
    const data = outT.data as Float32Array;
    if (!this.pixels || this.pixels.width !== W || this.pixels.height !== H)
      this.pixels = new ImageData(W, H);
    const rgba = this.pixels.data;
    const plane = W * H;
    for (let i = 0; i < plane; i++) {
      const o = i * 4;
      rgba[o] = data[i] * 255;
      rgba[o + 1] = data[i + plane] * 255;
      rgba[o + 2] = data[i + 2 * plane] * 255;
      rgba[o + 3] = 255;
    }
    outT.dispose?.();
    const mid = this.canvas("mid_", W, H);
    (mid.getContext("2d") as CanvasRenderingContext2D).putImageData(this.pixels, 0, 0);
    const out = this.outs.next(width, height);
    const octx = out.getContext("2d") as CanvasRenderingContext2D;
    octx.drawImage(mid, 0, 0, iw, ih, 0, 0, width, height);
    return out;
  }

  /** The size the network sees a `width × height` frame at: scaled under the
   * area cap, then padded up to the stride multiple. */
  private sizeFor(width: number, height: number) {
    const s = Math.min(1, Math.sqrt(AREA_CAP / Math.max(1, width * height)));
    const iw = Math.max(1, Math.round(width * s));
    const ih = Math.max(1, Math.round(height * s));
    const W = Math.ceil(iw / MULTIPLE) * MULTIPLE;
    const H = Math.ceil(ih / MULTIPLE) * MULTIPLE;
    const same = this.inner.w === iw && this.inner.h === ih;
    if (!same) {
      this.inner = { w: iw, h: ih, W, H };
      this.input = null;
      this.pairKey = "";
      this.pixels = null;
    }
    return this.inner;
  }

  private canvas(slot: "stage" | "mid_", w: number, h: number): RasterSurface {
    let c = this[slot];
    if (!c) c = this[slot] = createRasterCanvas(w, h);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  }

  /** Pack both pictures and the grid planes into the input. */
  private pack(a: CanvasImageSource, b: CanvasImageSource, iw: number, ih: number, W: number, H: number) {
    const plane = W * H;
    const input = (this.input ??= new Float32Array(PLANES * plane));
    const stage = this.canvas("stage", W, H);
    const ctx = stage.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    const read = (img: CanvasImageSource, at: number) => {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, iw, ih);
      const d = ctx.getImageData(0, 0, W, H).data;
      for (let i = 0; i < plane; i++) {
        const o = i * 4;
        input[at + i] = d[o] / 255;
        input[at + plane + i] = d[o + 1] / 255;
        input[at + 2 * plane + i] = d[o + 2] / 255;
      }
    };
    read(a, 0);
    read(b, 3 * plane);
    // The sampling grid: normalized x and y of every pixel, and the size of
    // one pixel in that space, which the flow scales by.
    for (let y = 0; y < H; y++) {
      const vy = (2 * y) / (H - 1) - 1;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        input[7 * plane + i] = (2 * x) / (W - 1) - 1;
        input[8 * plane + i] = vy;
      }
    }
    input.fill(2 / (W - 1), 9 * plane, 10 * plane);
    input.fill(2 / (H - 1), 10 * plane, 11 * plane);
  }

  dispose(): void {
    void this.session.release();
    this.input = null;
    this.stage = this.mid_ = null;
    this.outs.clear();
    this.pixels = null;
  }
}

/** The maker an export uses: the estimate where the machine can run it,
 * the blend where it cannot. */
export async function exportFrameSynth(): Promise<FrameSynth> {
  return (await hasFrameSynthGpu()) ? RifeSynth.create() : blendSynth();
}
