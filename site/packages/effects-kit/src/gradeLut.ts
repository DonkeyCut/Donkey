/**
 * The 3D LUT every renderer shares. buildGradeLut samples gradeMath's
 * transform onto a cubic lattice; ffmpeg consumes it as a .cube file
 * (lut3d, tetrahedral), the preview's WebGL pass uploads it as a 3D
 * texture, and headless export applies it on the CPU. All three
 * interpolate tetrahedrally so they agree to within 8-bit quantization.
 */

import type { ColorGrade } from "./colorGrade";
import { normalizeGrade } from "./colorGrade";
import { createGradeTransform } from "./gradeMath";

export interface GradeLut {
  /** Lattice nodes per axis. */
  size: number;
  /** RGB triples, red axis fastest: index = ((b*size + g)*size + r) * 3. */
  data: Float32Array;
}

export const GRADE_LUT_SIZE = 33;

/** A stable identity for a grade's rendered result: normalized, key-sorted
 * JSON. Two grades with the same key produce the same LUT. */
export function gradeKey(g: ColorGrade | undefined | null): string {
  const n = normalizeGrade(g);
  if (!n) return "";
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(n));
}

/** Sample the grade's transform onto the lattice. Returns null for a grade
 * that resolves to neutral. */
export function buildGradeLut(
  g: ColorGrade | undefined | null,
  size = GRADE_LUT_SIZE
): GradeLut | null {
  const transform = createGradeTransform(g);
  if (!transform) return null;
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let gg = 0; gg < size; gg++) {
      for (let r = 0; r < size; r++) {
        const out = transform(r * step, gg * step, b * step);
        data[i++] = out[0];
        data[i++] = out[1];
        data[i++] = out[2];
      }
    }
  }
  return { size, data };
}

/** Serialize to the .cube text ffmpeg's lut3d reads. */
export function lutToCube(lut: GradeLut, title = "Donkey Cut grade"): string {
  const lines: string[] = [`TITLE "${title}"`, `LUT_3D_SIZE ${lut.size}`, ""];
  const n = lut.size * lut.size * lut.size;
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    lines.push(
      `${lut.data[o].toFixed(6)} ${lut.data[o + 1].toFixed(6)} ${lut.data[o + 2].toFixed(6)}`
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Apply the LUT to RGBA pixels in place with tetrahedral interpolation —
 * the same scheme ffmpeg's lut3d defaults to. Alpha passes through.
 */
export function applyLutToImageData(px: Uint8ClampedArray, lut: GradeLut): void {
  const { size, data } = lut;
  const scale = (size - 1) / 255;
  const s2 = size * size;
  for (let i = 0; i < px.length; i += 4) {
    const rf = px[i] * scale;
    const gf = px[i + 1] * scale;
    const bf = px[i + 2] * scale;
    let r0 = Math.floor(rf);
    let g0 = Math.floor(gf);
    let b0 = Math.floor(bf);
    if (r0 >= size - 1) r0 = size - 2;
    if (g0 >= size - 1) g0 = size - 2;
    if (b0 >= size - 1) b0 = size - 2;
    const dr = rf - r0;
    const dg = gf - g0;
    const db = bf - b0;
    const base = (b0 * s2 + g0 * size + r0) * 3;
    const R = 3;
    const G = size * 3;
    const B = s2 * 3;
    // Tetrahedral: pick the tetrahedron of the unit cube containing (dr,dg,db)
    // and blend its four lattice corners.
    const c0 = base;
    let w1: number;
    let w2: number;
    let w3: number;
    let o1: number;
    let o2: number;
    let o3: number;
    if (dr >= dg) {
      if (dg >= db) {
        w1 = dr - dg; w2 = dg - db; w3 = db;
        o1 = R; o2 = R + G; o3 = R + G + B;
      } else if (dr >= db) {
        w1 = dr - db; w2 = db - dg; w3 = dg;
        o1 = R; o2 = R + B; o3 = R + G + B;
      } else {
        w1 = db - dr; w2 = dr - dg; w3 = dg;
        o1 = B; o2 = R + B; o3 = R + G + B;
      }
    } else {
      if (db >= dg) {
        w1 = db - dg; w2 = dg - dr; w3 = dr;
        o1 = B; o2 = G + B; o3 = R + G + B;
      } else if (db >= dr) {
        w1 = dg - db; w2 = db - dr; w3 = dr;
        o1 = G; o2 = G + B; o3 = R + G + B;
      } else {
        w1 = dg - dr; w2 = dr - db; w3 = db;
        o1 = G; o2 = R + G; o3 = R + G + B;
      }
    }
    const w0 = 1 - w1 - w2 - w3;
    for (let c = 0; c < 3; c++) {
      const v =
        w0 * data[c0 + c] +
        w1 * data[c0 + o1 + c] +
        w2 * data[c0 + o2 + c] +
        w3 * data[c0 + o3 + c];
      px[i + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
}
