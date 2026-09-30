/**
 * The HDR present pass: the last step of an HDR preview.
 *
 * When a project delivers HLG or PQ, the compositor draws the frame in the
 * same HLG signal space the export composites in, onto its ordinary 8-bit
 * canvas. That picture is not what a display should show — an HLG signal on
 * an sRGB canvas reads flat and dim — so a second canvas, configured through
 * WebGPU as `rgba16float` with extended tone mapping, decodes it to display
 * light every frame: the BT.2100 inverse OETF and the OOTF for a 1000-nit
 * display, scaled so the 203-nit reference white of BT.2408 lands on 1.0 —
 * SDR white on the display, where the titles the DOM draws over the stage
 * already sit — then encoded with the sRGB transfer extended past 1.0, which
 * is what the extended-range canvas takes.
 *
 * One pass per frame, only in HDR mode: the source texture and the bind
 * group live as long as the size does, so a frame allocates nothing. The
 * pure decode is exported on its own so the math is testable and the shader
 * can be read against it.
 */

import { BT2408_REFERENCE_WHITE_NITS, hlgOetfInverse, hlgOotf, REC2020_PRIMARIES, REC709_PRIMARIES, rgbToRgbMatrix } from "@donkeycut/effects-kit";
import type { RasterSurface } from "./raster";

/** The display the present pass decodes for; HLG's nominal 1000-nit peak. */
export const HDR_PRESENT_PEAK_NITS = 1000;

const REC2020_TO_REC709 = rgbToRgbMatrix(REC2020_PRIMARIES, REC709_PRIMARIES);

/** HLG signal (Rec.2020) → Rec.709 display-linear light with reference white
 * (203 nits) at 1.0. Past 1.0 is HDR headroom; below 0 is color outside
 * Rec.709, which the extended-range canvas carries. */
export function hlgSignalToDisplayLinear(r: number, g: number, b: number): [number, number, number] {
  const [rd, gd, bd] = hlgOotf(hlgOetfInverse(r), hlgOetfInverse(g), hlgOetfInverse(b), HDR_PRESENT_PEAK_NITS);
  const k = 1 / BT2408_REFERENCE_WHITE_NITS;
  const m = REC2020_TO_REC709;
  const x = rd * k;
  const y = gd * k;
  const z = bd * k;
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

/** The sRGB transfer function extended past 1.0 and mirrored below 0 — the
 * encoding an extended-range sRGB canvas holds. */
export function extendedSrgbEncode(v: number): number {
  const a = Math.abs(v);
  const e = a <= 0.0031308 ? 12.92 * a : 1.055 * Math.pow(a, 1 / 2.4) - 0.055;
  return v < 0 ? -e : e;
}

/* ------------------------------------------------------------------ */
/* What the stage is showing                                           */
/* ------------------------------------------------------------------ */

/** `off`: the project is SDR. `hdr`: the HDR picture is on screen. `sdr`:
 * the project is HDR and the stage shows the grade rendered as SDR, because
 * the display, the browser or the GPU cannot carry the HDR picture. */
export type HdrPreviewState = "off" | "hdr" | "sdr";

let state: HdrPreviewState = "off";
const listeners = new Set<() => void>();

export function hdrPreviewState(): HdrPreviewState {
  return state;
}

export function setHdrPreviewState(next: HdrPreviewState): void {
  if (state === next) return;
  state = next;
  for (const fn of listeners) fn();
}

export function subscribeHdrPreviewState(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Whether the display the page is on reports a high dynamic range now — a
 * window dragged to another monitor changes the answer, so `onChange` fires
 * when it does. */
let displayQuery: MediaQueryList | null | undefined;

function displayRange(): MediaQueryList | null {
  if (displayQuery !== undefined) return displayQuery;
  displayQuery = typeof matchMedia === "function" ? matchMedia("(dynamic-range: high)") : null;
  return displayQuery;
}

export function displayIsHdr(): boolean {
  return displayRange()?.matches ?? false;
}

export function onDisplayRangeChange(fn: () => void): () => void {
  const q = displayRange();
  if (!q) return () => {};
  q.addEventListener("change", fn);
  return () => q.removeEventListener("change", fn);
}

/* ------------------------------------------------------------------ */
/* The WebGPU presenter                                                */
/* ------------------------------------------------------------------ */

// The page ships no WebGPU type package; the slice of the API the pass uses
// is spelled here, the way hdrCanvas.ts spells its own.
interface GpuTextureLike {
  createView(): unknown;
  destroy(): void;
}
interface GpuCanvasContextLike {
  configure(config: Record<string, unknown>): void;
  unconfigure(): void;
  getCurrentTexture(): GpuTextureLike;
}
interface GpuQueueLike {
  copyExternalImageToTexture(source: { source: RasterSurface; flipY?: boolean }, dest: { texture: GpuTextureLike }, size: [number, number]): void;
  writeBuffer(buffer: unknown, offset: number, data: BufferSource): void;
  submit(buffers: unknown[]): void;
}
interface GpuRenderPassLike {
  setPipeline(p: unknown): void;
  setBindGroup(i: number, g: unknown): void;
  draw(n: number): void;
  end(): void;
}
interface GpuEncoderLike {
  beginRenderPass(desc: Record<string, unknown>): GpuRenderPassLike;
  finish(): unknown;
}
interface GpuDeviceLike {
  queue: GpuQueueLike;
  lost: Promise<unknown>;
  createShaderModule(desc: { code: string }): unknown;
  createRenderPipeline(desc: Record<string, unknown>): { getBindGroupLayout(i: number): unknown };
  createSampler(desc: Record<string, unknown>): unknown;
  createBuffer(desc: Record<string, unknown>): unknown;
  createTexture(desc: Record<string, unknown>): GpuTextureLike;
  createBindGroup(desc: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuEncoderLike;
  destroy(): void;
}
interface GpuLike {
  requestAdapter(): Promise<{ requestDevice(): Promise<GpuDeviceLike> } | null>;
}

// GPUTextureUsage bits, spelled out for the same reason.
const TEXTURE_BINDING = 0x04;
const COPY_DST = 0x02;
const RENDER_ATTACHMENT = 0x10;
// GPUBufferUsage bits.
const UNIFORM = 0x40;
const BUFFER_COPY_DST = 0x08;

const SHADER = /* wgsl */ `
struct Params { m: mat3x3<f32>, peak: f32, white: f32 };
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  // One triangle over the whole target; uv runs top-down like the canvas.
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: VsOut;
  o.pos = vec4(p[i], 0.0, 1.0);
  o.uv = vec2(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}

// BT.2100 HLG inverse OETF: signal → scene-linear.
fn hlgInv(s: f32) -> f32 {
  let a = 0.17883277;
  let b = 0.28466892;
  let c = 0.55991073;
  if (s <= 0.0) { return 0.0; }
  if (s <= 0.5) { return s * s / 3.0; }
  return (exp((s - c) / a) + b) / 12.0;
}

// The sRGB transfer, extended past 1.0 and mirrored below 0.
fn srgbx(v: f32) -> f32 {
  let a = abs(v);
  let e = select(1.055 * pow(a, 1.0 / 2.4) - 0.055, 12.92 * a, a <= 0.0031308);
  return select(e, -e, v < 0.0);
}

@fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
  let s = textureSample(src, samp, in.uv).rgb;
  let scene = vec3(hlgInv(s.r), hlgInv(s.g), hlgInv(s.b));
  // The OOTF for the display's peak: system gamma 1.2 at 1000 nits.
  let gamma = 1.2 + 0.42 * log(params.peak / 1000.0) / log(10.0);
  let ys = dot(scene, vec3(0.2627, 0.6780, 0.0593));
  let k = select(0.0, params.peak * pow(ys, gamma - 1.0), ys > 0.0);
  let lin709 = params.m * (scene * (k / params.white));
  return vec4(srgbx(lin709.r), srgbx(lin709.g), srgbx(lin709.b), 1.0);
}
`;

/**
 * Presents a canvas holding an HLG-signal picture on an extended-range
 * canvas. `create` resolves null where the browser has no WebGPU device or
 * refuses the extended configuration — the caller then previews SDR.
 */
export class HdrPresenter {
  private texture: GpuTextureLike | null = null;
  private bindGroup: unknown = null;
  private w = 0;
  private h = 0;
  private lost = false;

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GpuDeviceLike,
    private readonly ctx: GpuCanvasContextLike,
    private readonly pipeline: { getBindGroupLayout(i: number): unknown },
    private readonly sampler: unknown,
    private readonly params: unknown
  ) {
    void device.lost.then(() => {
      this.lost = true;
    });
  }

  static async create(canvas: HTMLCanvasElement): Promise<HdrPresenter | null> {
    const gpu = (navigator as { gpu?: GpuLike }).gpu;
    if (!gpu) return null;
    let device: GpuDeviceLike;
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return null;
      device = await adapter.requestDevice();
    } catch {
      return null;
    }
    const ctx = canvas.getContext("webgpu" as "2d") as unknown as GpuCanvasContextLike | null;
    if (!ctx) {
      device.destroy();
      return null;
    }
    try {
      ctx.configure({
        device,
        format: "rgba16float",
        colorSpace: "srgb",
        toneMapping: { mode: "extended" },
        alphaMode: "opaque",
      });
      const shader = device.createShaderModule({ code: SHADER });
      const pipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: shader, entryPoint: "vs" },
        fragment: { module: shader, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
        primitive: { topology: "triangle-list" },
      });
      const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
      // mat3x3<f32> is three vec4-aligned columns (48 bytes), then two floats.
      const params = device.createBuffer({ size: 64, usage: UNIFORM | BUFFER_COPY_DST });
      const m = REC2020_TO_REC709;
      const data = new Float32Array(16);
      // Column-major: column j holds row entries m[j], m[3+j], m[6+j].
      for (let j = 0; j < 3; j++) {
        data[j * 4] = m[j];
        data[j * 4 + 1] = m[3 + j];
        data[j * 4 + 2] = m[6 + j];
      }
      data[12] = HDR_PRESENT_PEAK_NITS;
      data[13] = BT2408_REFERENCE_WHITE_NITS;
      device.queue.writeBuffer(params, 0, data);
      return new HdrPresenter(canvas, device, ctx, pipeline, sampler, params);
    } catch {
      device.destroy();
      return null;
    }
  }

  /** The device went away; the caller makes a new presenter or falls back. */
  get gone(): boolean {
    return this.lost;
  }

  /** Decode `source` (an HLG-signal picture) onto the extended-range canvas,
   * sized to match it. */
  present(source: RasterSurface): void {
    if (this.lost) return;
    const w = source.width;
    const h = source.height;
    if (w < 1 || h < 1) return;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    if (!this.texture || this.w !== w || this.h !== h) {
      this.texture?.destroy();
      this.texture = this.device.createTexture({
        size: [w, h],
        format: "rgba8unorm",
        usage: TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT,
      });
      this.bindGroup = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: this.texture.createView() },
          { binding: 2, resource: { buffer: this.params } },
        ],
      });
      this.w = w;
      this.h = h;
    }
    try {
      this.device.queue.copyExternalImageToTexture({ source }, { texture: this.texture }, [w, h]);
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3);
      pass.end();
      this.device.queue.submit([encoder.finish()]);
    } catch {
      this.lost = true;
    }
  }

  dispose(): void {
    this.lost = true;
    this.texture?.destroy();
    this.texture = null;
    try {
      this.ctx.unconfigure();
    } catch {
      // A context already torn down with its canvas.
    }
    this.device.destroy();
  }
}
