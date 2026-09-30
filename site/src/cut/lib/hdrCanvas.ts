/**
 * Whether this browser can put an extended-range picture on screen.
 *
 * An HDR preview needs a canvas whose values may run past 1.0 and reach the
 * display unclipped. Two routes exist: a WebGPU canvas configured for
 * `rgba16float` with extended tone mapping, and a WebGL drawing buffer
 * re-declared as RGBA16F with a wide color space. Both are feature-detected
 * once per session by configuring a one-pixel canvas; the display's own
 * range is a media query beside them. A headless process has none of this
 * and answers false on every count.
 */

export interface HdrCanvasSupport {
  /** WebGPU: `configure({ format: "rgba16float", toneMapping: { mode: "extended" } })` took. */
  webgpu: boolean;
  /** WebGL 2: `drawingBufferStorage(RGBA16F)` took and `drawingBufferColorSpace` exists. */
  webgl: boolean;
  /** The display the page is on reports a high dynamic range right now. */
  display: boolean;
}

const NONE: HdrCanvasSupport = { webgpu: false, webgl: false, display: false };

let cached: Promise<HdrCanvasSupport> | null = null;

/** Detect once and hold the answer for the session. */
export function hdrCanvasSupport(): Promise<HdrCanvasSupport> {
  return (cached ??= detect().catch(() => NONE));
}

async function detect(): Promise<HdrCanvasSupport> {
  if (typeof OffscreenCanvas === "undefined") return NONE;
  const [webgpu, webgl] = await Promise.all([detectWebGpu(), Promise.resolve(detectWebGl())]);
  const display =
    typeof matchMedia === "function" ? matchMedia("(dynamic-range: high)").matches : false;
  return { webgpu, webgl, display };
}

type GpuCanvasContext = {
  configure(config: Record<string, unknown>): void;
  getConfiguration?(): { toneMapping?: { mode?: string } } | null;
  unconfigure?(): void;
};

async function detectWebGpu(): Promise<boolean> {
  const gpu = (navigator as { gpu?: { requestAdapter(): Promise<{ requestDevice(): Promise<{ destroy(): void }> } | null> } }).gpu;
  if (!gpu) return false;
  const adapter = await gpu.requestAdapter();
  if (!adapter) return false;
  const device = await adapter.requestDevice();
  try {
    const ctx = new OffscreenCanvas(1, 1).getContext("webgpu" as "2d") as unknown as GpuCanvasContext | null;
    if (!ctx) return false;
    ctx.configure({ device, format: "rgba16float", toneMapping: { mode: "extended" } });
    const mode = ctx.getConfiguration?.()?.toneMapping?.mode;
    ctx.unconfigure?.();
    return mode === "extended";
  } finally {
    device.destroy();
  }
}

function detectWebGl(): boolean {
  const gl = new OffscreenCanvas(1, 1).getContext("webgl2") as
    | (WebGL2RenderingContext & { drawingBufferStorage?: (format: number, w: number, h: number) => void })
    | null;
  if (!gl) return false;
  if (typeof gl.drawingBufferStorage !== "function" || !("drawingBufferColorSpace" in gl)) return false;
  // A float drawing buffer is allowed only once a float color buffer extension is on.
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return false;
  gl.drawingBufferStorage(gl.RGBA16F, 1, 1);
  const ok = gl.getError() === gl.NO_ERROR;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return ok;
}
