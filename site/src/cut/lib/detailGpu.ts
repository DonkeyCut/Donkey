/**
 * GPU sharpen and clarity for the preview and the in-tab export: the two
 * spatial controls of a grade, run after the clip LUT and before the look,
 * with the math of effects-kit detail.ts — detail is luma minus a smoothed
 * base, added back with a gain on every channel. Sharpen's base is a small
 * Gaussian blur at full resolution; clarity's base is the self-guided
 * filter over a wide window, computed at half resolution (its means vary
 * slowly, so the half-size pass reads the same and costs a quarter).
 *
 * One WebGL2 context, its canvas from the raster seam, a handful of small
 * programs and float framebuffers ping-ponged between them: one channel for
 * a luma and its blurs, two for a mean beside its square. The framebuffers
 * are the size of the picture, so they are let go once detail has been idle
 * for a while and when the preview goes away, and what they hold is reported
 * to the memory budget. Under a headless factory there is no WebGL2 and the
 * caller runs the CPU pass instead; the same happens when float render
 * targets are missing.
 */

import { CLARITY_EPS, detailGain, detailRadius, type DetailSettings } from "@donkeycut/effects-kit";
import { holdMemory } from "./memoryBudget";
import { createRasterCanvas, type RasterSurface } from "./raster";

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

/** Luma of the uploaded source (rows top-down, so sampled flipped), with its
 * square beside it for the guided filter's variance. */
const LUMA_FRAG = `${HEAD}
uniform sampler2D uSrc;
void main() {
  vec4 s = texture(uSrc, vec2(vUv.x, 1.0 - vUv.y));
  float l = dot(s.rgb, LUMA);
  outColor = vec4(l, l * l, 0.0, 1.0);
}`;

/** The largest half-kernel a blur pass takes; sigma 3·radius covers 8K. */
const MAX_RADIUS = 48;

/** One direction of a separable Gaussian over the red channel. */
const GAUSS_FRAG = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uStep;
uniform int uRadius;
uniform float uWeights[${MAX_RADIUS + 1}];
void main() {
  float acc = texture(uTex, vUv).r * uWeights[0];
  for (int i = 1; i <= ${MAX_RADIUS}; i++) {
    if (i > uRadius) break;
    vec2 d = uStep * float(i);
    acc += (texture(uTex, vUv + d).r + texture(uTex, vUv - d).r) * uWeights[i];
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

/** One direction of a box mean over the red and green channels. */
const BOX_FRAG = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uStep;
uniform int uRadius;
void main() {
  vec2 acc = texture(uTex, vUv).rg;
  for (int i = 1; i <= ${MAX_RADIUS}; i++) {
    if (i > uRadius) break;
    vec2 d = uStep * float(i);
    acc += texture(uTex, vUv + d).rg + texture(uTex, vUv - d).rg;
  }
  outColor = vec4(acc / float(2 * uRadius + 1), 0.0, 1.0);
}`;

/** The guided filter's local linear coefficients from the window means of
 * the luma and its square: a = var / (var + eps), b = mean − a·mean. */
const AB_FRAG = `${HEAD}
uniform sampler2D uTex;
uniform float uEps;
void main() {
  vec2 m = texture(uTex, vUv).rg;
  float v = max(0.0, m.g - m.r * m.r);
  float a = v / (v + uEps);
  outColor = vec4(a, m.r - a * m.r, 0.0, 1.0);
}`;

/** Detail back onto the picture: the source luma against each base, gained,
 * added to every channel; alpha passes through. */
const FINAL_FRAG = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uSharp;
uniform sampler2D uAB;
uniform float uKs;
uniform float uKc;
void main() {
  vec4 s = texture(uSrc, vec2(vUv.x, 1.0 - vUv.y));
  float l = dot(s.rgb, LUMA);
  float delta = 0.0;
  if (uKs > 0.0) delta += uKs * (l - texture(uSharp, vUv).r);
  if (uKc > 0.0) {
    vec2 ab = texture(uAB, vUv).rg;
    delta += uKc * (l - (ab.r * l + ab.g));
  }
  outColor = vec4(clamp(s.rgb + delta, 0.0, 1.0), s.a);
}`;

interface Program {
  program: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

/** A render target's storage: one float channel (a luma, a blur of it), two
 * (a mean beside the mean of its square, or the guided filter's a and b), or
 * two half floats where the target is sampled with linear filtering, which
 * 32-bit floats need an extension for. */
type TargetKind = "r32f" | "rg32f" | "rg16f";
const TARGET_BYTES: Record<TargetKind, number> = { r32f: 4, rg32f: 8, rg16f: 4 };

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  kind: TargetKind;
}

interface DetailPass {
  canvas: RasterSurface;
  gl: WebGL2RenderingContext;
  srcTex: WebGLTexture;
  luma: Program;
  gauss: Program;
  box: Program;
  ab: Program;
  final: Program;
  targets: Map<string, Target>;
  /** The source texture's size, for the report. */
  srcW: number;
  srcH: number;
}

let pass: DetailPass | null | false = null;

/** Bytes the pass stands on: its float targets, the uploaded source, and the
 * canvas the result is drawn into. */
export function detailGpuBytes(): number {
  if (!pass) return 0;
  let n = (pass.srcW * pass.srcH + pass.canvas.width * pass.canvas.height) * 4;
  for (const t of pass.targets.values()) n += t.w * t.h * TARGET_BYTES[t.kind];
  return n;
}
holdMemory("detailTargets", detailGpuBytes);

/** How long detail may sit unused before its picture-sized buffers go. */
export const DETAIL_IDLE_MS = 4000;
let lastUsed = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Let go of every picture-sized buffer; the programs stay, so the next
 * frame with detail only reallocates what it draws into. */
export function releaseDetailGpu(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!pass) return;
  const { gl } = pass;
  if (!gl.isContextLost()) {
    for (const t of pass.targets.values()) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    gl.bindTexture(gl.TEXTURE_2D, pass.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  pass.targets.clear();
  pass.srcW = 0;
  pass.srcH = 0;
  pass.canvas.width = 1;
  pass.canvas.height = 1;
}

/** Let go of the pass itself with its buffers: the preview is going away,
 * and a page holds only so many WebGL contexts. The next use builds anew. */
export function disposeDetailGpu(): void {
  releaseDetailGpu();
  if (pass) pass.gl.getExtension("WEBGL_lose_context")?.loseContext();
  pass = null;
}

/** Book the idle check: one timer, re-armed only when it fires early. */
function noteUse(): void {
  lastUsed = performance.now();
  if (idleTimer || typeof setTimeout === "undefined") return;
  const check = () => {
    idleTimer = null;
    const idle = performance.now() - lastUsed;
    if (idle >= DETAIL_IDLE_MS) releaseDetailGpu();
    else idleTimer = setTimeout(check, DETAIL_IDLE_MS - idle);
  };
  idleTimer = setTimeout(check, DETAIL_IDLE_MS);
}

function compile(gl: WebGL2RenderingContext, frag: string, uniforms: string[]): Program | null {
  const make = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : null;
  };
  const vs = make(gl.VERTEX_SHADER, VERT);
  const fs = make(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return null;
  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  const loc: Program["loc"] = {};
  for (const u of uniforms) loc[u] = gl.getUniformLocation(program, u);
  return { program, loc };
}

function init(): DetailPass | false {
  const canvas = createRasterCanvas(2, 2);
  const gl = (canvas.getContext as (id: string, opts?: unknown) => unknown)("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  }) as WebGL2RenderingContext | null;
  if (!gl) return false;
  // Float render targets: the means and the linear coefficients need more
  // than eight bits, or flat regions come back noisy.
  if (!gl.getExtension("EXT_color_buffer_float")) return false;
  const luma = compile(gl, LUMA_FRAG, ["uSrc"]);
  const gauss = compile(gl, GAUSS_FRAG, ["uTex", "uStep", "uRadius", "uWeights"]);
  const box = compile(gl, BOX_FRAG, ["uTex", "uStep", "uRadius"]);
  const ab = compile(gl, AB_FRAG, ["uTex", "uEps"]);
  const final = compile(gl, FINAL_FRAG, ["uSrc", "uSharp", "uAB", "uKs", "uKc"]);
  if (!luma || !gauss || !box || !ab || !final) return false;
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  // Every program binds aPos at the same location, so one attribute setup
  // serves them all.
  for (const p of [luma, gauss, box, ab, final]) {
    const posLoc = gl.getAttribLocation(p.program, "aPos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  }
  const srcTex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { canvas, gl, srcTex, luma, gauss, box, ab, final, targets: new Map(), srcW: 0, srcH: 0 };
}

/** A float render target of the given size, made once and resized in place. */
function target(p: DetailPass, name: string, w: number, h: number, kind: TargetKind): Target {
  const { gl } = p;
  let t = p.targets.get(name);
  const linear = kind === "rg16f";
  if (!t) {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    t = { tex, fbo, w: 0, h: 0, kind };
    p.targets.set(name, t);
  }
  if (t.w !== w || t.h !== h) {
    const [internal, format] =
      kind === "r32f" ? [gl.R32F, gl.RED] : kind === "rg32f" ? [gl.RG32F, gl.RG] : [gl.RG16F, gl.RG];
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.FLOAT, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    t.w = w;
    t.h = h;
  }
  return t;
}

function draw(p: DetailPass, prog: Program, into: Target | null, w: number, h: number): void {
  const { gl } = p;
  gl.useProgram(prog.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, into ? into.fbo : null);
  gl.viewport(0, 0, w, h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function bind(p: DetailPass, unit: number, tex: WebGLTexture): void {
  p.gl.activeTexture(p.gl.TEXTURE0 + unit);
  p.gl.bindTexture(p.gl.TEXTURE_2D, tex);
}

const weightCache = new Map<number, Float32Array>();

/** Half of a normalized Gaussian kernel (center first), the same kernel
 * detail.ts builds, kept per sigma. */
function gaussWeights(sigma: number): { weights: Float32Array; radius: number } {
  const radius = Math.min(MAX_RADIUS, Math.max(1, Math.ceil(sigma * 3)));
  let w = weightCache.get(sigma);
  if (!w) {
    w = new Float32Array(MAX_RADIUS + 1);
    let sum = 0;
    for (let i = 0; i <= radius; i++) {
      w[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
      sum += i === 0 ? w[i] : 2 * w[i];
    }
    for (let i = 0; i <= radius; i++) w[i] /= sum;
    weightCache.set(sigma, w);
  }
  return { weights: w, radius };
}

/**
 * Render `source` with sharpen and clarity applied and return the canvas
 * holding the result, or null when the GPU pass is unavailable — callers
 * then run applyDetail on the pixels. The returned canvas is shared and
 * valid until the next call.
 */
export function applyDetailGpu(
  source: CanvasImageSource,
  w: number,
  h: number,
  d: DetailSettings
): RasterSurface | null {
  if (pass && pass.gl.isContextLost()) pass = null;
  if (pass === false) return null;
  if (!pass) {
    try {
      pass = init();
    } catch {
      pass = false;
    }
    if (!pass) return null;
  }
  const p = pass;
  const { gl } = p;
  noteUse();
  const ks = detailGain("sharpen", d.sharpen || 0);
  const kc = detailGain("clarity", d.clarity || 0);
  try {
    if (p.canvas.width !== w || p.canvas.height !== h) {
      p.canvas.width = w;
      p.canvas.height = h;
    }
    bind(p, 0, p.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    p.srcW = w;
    p.srcH = h;

    let sharpTex: WebGLTexture | null = null;
    if (ks > 0) {
      const lum = target(p, "lumaFull", w, h, "r32f");
      const tmp = target(p, "gaussTmp", w, h, "r32f");
      const base = target(p, "gaussBase", w, h, "r32f");
      gl.useProgram(p.luma.program);
      gl.uniform1i(p.luma.loc.uSrc, 0);
      draw(p, p.luma, lum, w, h);
      const { weights, radius } = gaussWeights(detailRadius("sharpen", h));
      gl.useProgram(p.gauss.program);
      gl.uniform1i(p.gauss.loc.uTex, 1);
      gl.uniform1i(p.gauss.loc.uRadius, radius);
      gl.uniform1fv(p.gauss.loc.uWeights, weights);
      bind(p, 1, lum.tex);
      gl.uniform2f(p.gauss.loc.uStep, 1 / w, 0);
      draw(p, p.gauss, tmp, w, h);
      bind(p, 1, tmp.tex);
      gl.uniform2f(p.gauss.loc.uStep, 0, 1 / h);
      draw(p, p.gauss, base, w, h);
      sharpTex = base.tex;
    }

    let abTex: WebGLTexture | null = null;
    if (kc > 0) {
      const hw = Math.max(1, Math.round(w / 2));
      const hh = Math.max(1, Math.round(h / 2));
      const lum = target(p, "lumaHalf", hw, hh, "rg32f");
      const tmp = target(p, "boxTmp", hw, hh, "rg32f");
      const mean = target(p, "boxMean", hw, hh, "rg32f");
      const ab = target(p, "ab", hw, hh, "rg32f");
      const abTmp = target(p, "abTmp", hw, hh, "rg32f");
      const abMean = target(p, "abMean", hw, hh, "rg16f");
      gl.useProgram(p.luma.program);
      gl.uniform1i(p.luma.loc.uSrc, 0);
      draw(p, p.luma, lum, hw, hh);
      // The window at half size: half the radius the CPU pass takes at full.
      const radius = Math.min(MAX_RADIUS, Math.max(1, Math.round(detailRadius("clarity", h) / 2)));
      gl.useProgram(p.box.program);
      gl.uniform1i(p.box.loc.uTex, 1);
      gl.uniform1i(p.box.loc.uRadius, radius);
      bind(p, 1, lum.tex);
      gl.uniform2f(p.box.loc.uStep, 1 / hw, 0);
      draw(p, p.box, tmp, hw, hh);
      bind(p, 1, tmp.tex);
      gl.uniform2f(p.box.loc.uStep, 0, 1 / hh);
      draw(p, p.box, mean, hw, hh);
      gl.useProgram(p.ab.program);
      gl.uniform1i(p.ab.loc.uTex, 1);
      gl.uniform1f(p.ab.loc.uEps, CLARITY_EPS);
      bind(p, 1, mean.tex);
      draw(p, p.ab, ab, hw, hh);
      gl.useProgram(p.box.program);
      bind(p, 1, ab.tex);
      gl.uniform2f(p.box.loc.uStep, 1 / hw, 0);
      draw(p, p.box, abTmp, hw, hh);
      bind(p, 1, abTmp.tex);
      gl.uniform2f(p.box.loc.uStep, 0, 1 / hh);
      draw(p, p.box, abMean, hw, hh);
      abTex = abMean.tex;
    }

    gl.useProgram(p.final.program);
    gl.uniform1i(p.final.loc.uSrc, 0);
    gl.uniform1i(p.final.loc.uSharp, 1);
    gl.uniform1i(p.final.loc.uAB, 2);
    gl.uniform1f(p.final.loc.uKs, ks);
    gl.uniform1f(p.final.loc.uKc, kc);
    bind(p, 1, sharpTex ?? p.srcTex);
    bind(p, 2, abTex ?? p.srcTex);
    draw(p, p.final, null, w, h);
    return p.canvas;
  } catch {
    return null;
  }
}
