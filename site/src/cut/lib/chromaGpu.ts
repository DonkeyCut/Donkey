/**
 * GPU chroma key for the preview and in-tab export: the clip's frame renders
 * through a WebGL2 pass that repeats the kit's reference math —
 * `chromaAlphaInto` in removal.ts — formula for formula, so the shader and
 * the CPU fallback key a frame to the same alpha. The canvas comes from the
 * raster seam; under a headless factory WebGL2 is absent and callers fall
 * back to the CPU pass.
 */

import { CHROMA_SPILL_REACH, chromaParams, type ChromaKey } from "@donkeycut/effects-kit";
import { gpuPassSingleton, uploadPassSource } from "./gpuPass";
import type { RasterSurface } from "./raster";

// BT.709 luma and the kit's Cb/Cr normalization; smoothstep matches the CPU
// pass's cubic.
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uKey;    // key cb, cr
uniform vec2 uDir;    // unit key chroma direction
uniform vec3 uRange;  // near, far, spillFar
uniform float uSpill;
in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 s = texture(uSrc, vUv);
  float y = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
  float cb = (s.b - y) / 1.8556;
  float cr = (s.r - y) / 1.5748;
  float d = distance(vec2(cb, cr), uKey);
  float a = smoothstep(uRange.x, uRange.y, d);
  vec3 rgb = s.rgb;
  if (uSpill > 0.0 && d < uRange.z) {
    float proj = cb * uDir.x + cr * uDir.y;
    if (proj > 0.0) {
      float reach = 1.0 - clamp((d - uRange.x) / (uRange.z - uRange.x), 0.0, 1.0);
      float cut = proj * uSpill * (reach * reach * (3.0 - 2.0 * reach));
      float ncb = cb - uDir.x * cut;
      float ncr = cr - uDir.y * cut;
      float nr = y + 1.5748 * ncr;
      float nb = y + 1.8556 * ncb;
      float ng = (y - 0.2126 * nr - 0.0722 * nb) / 0.7152;
      rgb = clamp(vec3(nr, ng, nb), 0.0, 1.0);
    }
  }
  outColor = vec4(rgb, s.a * a);
}`;

const acquire = gpuPassSingleton(FRAG, ({ gl, program }) => {
  const keyLoc = gl.getUniformLocation(program, "uKey");
  const dirLoc = gl.getUniformLocation(program, "uDir");
  const rangeLoc = gl.getUniformLocation(program, "uRange");
  const spillLoc = gl.getUniformLocation(program, "uSpill");
  if (!keyLoc || !dirLoc || !rangeLoc || !spillLoc) return null;
  return { keyLoc, dirLoc, rangeLoc, spillLoc };
});

/**
 * Render `source` through the key and return a canvas holding the keyed
 * frame, or null when WebGL2 is unavailable (headless) — callers then use
 * the kit's CPU pass. The returned canvas is shared and valid until the
 * next call.
 */
export function chromaKeyGpu(
  source: CanvasImageSource,
  w: number,
  h: number,
  key: ChromaKey
): RasterSurface | null {
  const held = acquire(w, h);
  if (!held) return null;
  const { pass, ext } = held;
  const { gl } = pass;
  try {
    const p = chromaParams(key);
    uploadPassSource(pass, source);
    gl.uniform2f(ext.keyLoc, p.keyCb, p.keyCr);
    gl.uniform2f(ext.dirLoc, p.dirCb, p.dirCr);
    gl.uniform3f(ext.rangeLoc, p.near, p.far, p.near + (p.far - p.near) * CHROMA_SPILL_REACH);
    gl.uniform1f(ext.spillLoc, p.spill);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return pass.canvas;
  } catch {
    return null;
  }
}
