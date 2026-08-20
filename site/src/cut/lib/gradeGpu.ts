/**
 * GPU application of the grade LUT for the preview and in-tab export: the
 * clip's frame renders through a WebGL2 pass that samples the shared 3D LUT
 * with the same tetrahedral scheme ffmpeg's lut3d and the CPU fallback use.
 * The canvas comes from the raster seam; under a headless factory WebGL2 is
 * absent and callers fall back to applyLutToImageData.
 */

import type { GradeLut } from "@donkeycut/effects-kit";
import { createRasterCanvas, type RasterSurface } from "./raster";

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler2D uSrc;
uniform sampler3D uLut;
uniform float uSize;
in vec2 vUv;
out vec4 outColor;

vec3 lutAt(ivec3 p) { return texelFetch(uLut, p, 0).rgb; }

void main() {
  vec4 s = texture(uSrc, vUv);
  float n = uSize - 1.0;
  vec3 p = clamp(s.rgb, 0.0, 1.0) * n;
  ivec3 i0 = ivec3(min(floor(p), vec3(uSize - 2.0)));
  vec3 d = p - vec3(i0);
  // Tetrahedral interpolation, matching the CPU pass and ffmpeg's default.
  ivec3 o1; ivec3 o2; float w1; float w2; float w3;
  if (d.r >= d.g) {
    if (d.g >= d.b)      { o1 = ivec3(1,0,0); o2 = ivec3(1,1,0); w1 = d.r-d.g; w2 = d.g-d.b; w3 = d.b; }
    else if (d.r >= d.b) { o1 = ivec3(1,0,0); o2 = ivec3(1,0,1); w1 = d.r-d.b; w2 = d.b-d.g; w3 = d.g; }
    else                 { o1 = ivec3(0,0,1); o2 = ivec3(1,0,1); w1 = d.b-d.r; w2 = d.r-d.g; w3 = d.g; }
  } else {
    if (d.b >= d.g)      { o1 = ivec3(0,0,1); o2 = ivec3(0,1,1); w1 = d.b-d.g; w2 = d.g-d.r; w3 = d.r; }
    else if (d.b >= d.r) { o1 = ivec3(0,1,0); o2 = ivec3(0,1,1); w1 = d.g-d.b; w2 = d.b-d.r; w3 = d.r; }
    else                 { o1 = ivec3(0,1,0); o2 = ivec3(1,1,0); w1 = d.g-d.r; w2 = d.r-d.b; w3 = d.b; }
  }
  float w0 = 1.0 - w1 - w2 - w3;
  vec3 rgb = w0 * lutAt(i0)
           + w1 * lutAt(i0 + o1)
           + w2 * lutAt(i0 + o2)
           + w3 * lutAt(i0 + ivec3(1,1,1));
  outColor = vec4(rgb, s.a);
}`;

interface GpuState {
  canvas: RasterSurface;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  srcTex: WebGLTexture;
  sizeLoc: WebGLUniformLocation;
  /** One uploaded texture per grade, so two graded clips in the same frame
   * take turns binding instead of re-uploading 33³ floats twice a frame. */
  luts: Map<string, WebGLTexture>;
}

/** Uploaded LUT textures kept at once; a 33³ RGBA32F texture is ~0.6MB. */
const LUT_TEXTURE_MAX = 6;

let state: GpuState | null | false = null;

function init(): GpuState | false {
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
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
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
  gl.uniform1i(gl.getUniformLocation(program, "uLut"), 1);
  const sizeLoc = gl.getUniformLocation(program, "uSize");
  if (!sizeLoc) return false;
  return { canvas, gl, program, srcTex, sizeLoc, luts: new Map() };
}

/** Bind the LUT's texture, uploading it the first time this grade is seen. */
function bindLut(s: GpuState, lut: GradeLut, key: string): void {
  const { gl } = s;
  gl.activeTexture(gl.TEXTURE1);
  const held = s.luts.get(key);
  if (held) {
    gl.bindTexture(gl.TEXTURE_3D, held);
    // Re-insert so the cap drops the grade least recently drawn.
    s.luts.delete(key);
    s.luts.set(key, held);
    return;
  }
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  const n = lut.size * lut.size * lut.size;
  const rgba = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = lut.data[i * 3];
    rgba[i * 4 + 1] = lut.data[i * 3 + 1];
    rgba[i * 4 + 2] = lut.data[i * 3 + 2];
    rgba[i * 4 + 3] = 1;
  }
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA32F, lut.size, lut.size, lut.size, 0, gl.RGBA, gl.FLOAT, rgba);
  s.luts.set(key, tex);
  if (s.luts.size > LUT_TEXTURE_MAX) {
    const oldest = s.luts.keys().next().value;
    if (oldest !== undefined && oldest !== key) {
      const stale = s.luts.get(oldest);
      if (stale) gl.deleteTexture(stale);
      s.luts.delete(oldest);
    }
  }
}

/**
 * Render `source` through the LUT and return a canvas holding the result, or
 * null when WebGL2 is unavailable (headless) — callers then use the CPU pass.
 * The returned canvas is shared and valid until the next call.
 */
export function applyLutGpu(
  source: CanvasImageSource,
  w: number,
  h: number,
  lut: GradeLut,
  key: string
): RasterSurface | null {
  if (state === false) return null;
  if (!state) {
    try {
      state = init();
    } catch {
      state = false;
    }
    if (!state) return null;
  }
  const s = state;
  const { gl } = s;
  try {
    if (s.canvas.width !== w || s.canvas.height !== h) {
      s.canvas.width = w;
      s.canvas.height = h;
    }
    bindLut(s, lut, key);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, s.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.uniform1f(s.sizeLoc, lut.size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return s.canvas;
  } catch {
    return null;
  }
}
