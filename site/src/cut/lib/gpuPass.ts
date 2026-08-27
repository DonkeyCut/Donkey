/**
 * The lazy WebGL2 pass the GPU pixel effects share: one raster canvas, a
 * fullscreen triangle, a source texture on unit 0, and the lifecycle around
 * them. A pass supplies its fragment shader and one-time uniform setup; the
 * helper owns creation, the resize of the shared canvas, and context loss —
 * a lost context turns every GL call into a silent no-op and the shared
 * canvas would hand back stale pixels forever, so the pass drops itself and
 * the next call rebuilds it, or settles on null when WebGL2 stays gone
 * (headless) and callers keep their CPU fallback.
 */

import { createRasterCanvas, type RasterSurface } from "./raster";

// The V axis is inverted here rather than at upload: `UNPACK_FLIP_Y_WEBGL` is
// ignored for an ImageBitmap source (a still's frame), so a pass that leaned on
// it processed stills upside down while video frames came out upright. Sampling
// the texture top-down puts every source kind — bitmap, canvas, video frame —
// the same way up.
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

export interface GpuPass {
  canvas: RasterSurface;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  srcTex: WebGLTexture;
}

function initPass(frag: string): GpuPass | false {
  const canvas = createRasterCanvas(2, 2);
  const gl = (canvas.getContext as (id: string, opts?: unknown) => unknown)("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;
  if (!gl) return false;
  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) return null;
    return sh;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return false;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
  gl.useProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  const srcTex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, "uSrc"), 0);
  return { canvas, gl, program, srcTex };
}

/**
 * A singleton pass over `frag`. `setup` runs once per (re)build — uniform
 * lookups, extra texture units — and its null means the shader is missing
 * something, which settles the pass off for good. The returned acquire
 * function sizes the canvas and viewport and hands the pass back, or null
 * while WebGL2 is out; each call re-checks context loss.
 */
export function gpuPassSingleton<T>(
  frag: string,
  setup: (pass: GpuPass) => T | null
): (w: number, h: number) => { pass: GpuPass; ext: T } | null {
  let state: { pass: GpuPass; ext: T } | null | false = null;
  return (w, h) => {
    if (state && state.pass.gl.isContextLost()) state = null;
    if (state === false) return null;
    if (!state) {
      try {
        const pass = initPass(frag);
        const ext = pass ? setup(pass) : null;
        state = pass && ext !== null ? { pass, ext } : false;
      } catch {
        state = false;
      }
      if (!state) return null;
    }
    const { pass } = state;
    if (pass.canvas.width !== w || pass.canvas.height !== h) {
      pass.canvas.width = w;
      pass.canvas.height = h;
    }
    pass.gl.viewport(0, 0, w, h);
    return state;
  };
}

/** Upload `source` as the pass's source texture on unit 0. */
export function uploadPassSource(pass: GpuPass, source: CanvasImageSource): void {
  const { gl } = pass;
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pass.srcTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
}
