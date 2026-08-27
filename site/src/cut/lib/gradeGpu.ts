/**
 * GPU application of the grade LUT for the preview and in-tab export: the
 * clip's frame renders through a WebGL2 pass that samples the shared 3D LUT
 * with the same tetrahedral scheme ffmpeg's lut3d and the CPU fallback use.
 * The canvas comes from the raster seam; under a headless factory WebGL2 is
 * absent and callers fall back to applyLutToImageData.
 */

import type { GradeLut } from "@donkeycut/effects-kit";
import { gpuPassSingleton, uploadPassSource, type GpuPass } from "./gpuPass";
import type { RasterSurface } from "./raster";

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

interface GradeExt {
  sizeLoc: WebGLUniformLocation;
  /** One uploaded texture per grade, so two graded clips in the same frame
   * take turns binding instead of re-uploading 33³ floats twice a frame. */
  luts: Map<string, WebGLTexture>;
}

/** Uploaded LUT textures kept at once; a 33³ RGBA32F texture is ~0.6MB. */
const LUT_TEXTURE_MAX = 6;

const acquire = gpuPassSingleton(FRAG, ({ gl, program }): GradeExt | null => {
  gl.uniform1i(gl.getUniformLocation(program, "uLut"), 1);
  const sizeLoc = gl.getUniformLocation(program, "uSize");
  if (!sizeLoc) return null;
  return { sizeLoc, luts: new Map() };
});

/** Bind the LUT's texture, uploading it the first time this grade is seen. */
function bindLut(s: { pass: GpuPass; ext: GradeExt }, lut: GradeLut, key: string): void {
  const { gl } = s.pass;
  gl.activeTexture(gl.TEXTURE1);
  const held = s.ext.luts.get(key);
  if (held) {
    gl.bindTexture(gl.TEXTURE_3D, held);
    // Re-insert so the cap drops the grade least recently drawn.
    s.ext.luts.delete(key);
    s.ext.luts.set(key, held);
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
  s.ext.luts.set(key, tex);
  if (s.ext.luts.size > LUT_TEXTURE_MAX) {
    const oldest = s.ext.luts.keys().next().value;
    if (oldest !== undefined && oldest !== key) {
      const stale = s.ext.luts.get(oldest);
      if (stale) gl.deleteTexture(stale);
      s.ext.luts.delete(oldest);
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
  const held = acquire(w, h);
  if (!held) return null;
  const { pass, ext } = held;
  const { gl } = pass;
  try {
    bindLut(held, lut, key);
    uploadPassSource(pass, source);
    gl.uniform1f(ext.sizeLoc, lut.size);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return pass.canvas;
  } catch {
    return null;
  }
}
