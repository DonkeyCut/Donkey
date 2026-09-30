/**
 * Y'CbCr planes through one matrix and out through Rec.709 limited, for the
 * proxy a browser builds in the page (mediaProxy.ts). The WASM ProRes decoder
 * hands out 10- or 12-bit planes carrying the master's own matrix — BT.2020
 * non-constant on an iPhone Apple Log file — and a proxy must carry the same
 * picture as Rec.709 limited code values, so every decoder draws it untouched.
 * A canvas would do the conversion in 8 bits; this does it on the planes and
 * keeps the depth. The output is always 4:2:0 at 10 bits — what the browser's
 * 10-bit encoders take — with chroma averaged over each 2×2 block, and a
 * master taller than the proxy may be is brought down in the same pass with
 * an area filter: every source pixel lands in the output pixels it covers,
 * weighted by how much of it they cover.
 */

import type { CodeFormat } from "@donkeycut/effects-kit";

export type PlanarFormat =
  | "I420P10" | "I420P12" | "I422P10" | "I422P12" | "I444P10" | "I444P12";

/** Chroma subsampling shifts and sample depth of each format. */
const FORMATS: Record<PlanarFormat, { hs: number; vs: number; depth: number }> = {
  I420P10: { hs: 1, vs: 1, depth: 10 },
  I420P12: { hs: 1, vs: 1, depth: 12 },
  I422P10: { hs: 1, vs: 0, depth: 10 },
  I422P12: { hs: 1, vs: 0, depth: 12 },
  I444P10: { hs: 0, vs: 0, depth: 10 },
  I444P12: { hs: 0, vs: 0, depth: 12 },
};

export const isPlanarFormat = (format: string | null | undefined): format is PlanarFormat =>
  !!format && format in FORMATS;

/** Luma coefficients of each matrix. */
const COEFFICIENTS: Record<CodeFormat["matrix"], { kr: number; kb: number }> = {
  bt709: { kr: 0.2126, kb: 0.0722 },
  bt601: { kr: 0.299, kb: 0.114 },
  bt2020nc: { kr: 0.2627, kb: 0.0593 },
};

export interface PlaneLayoutLike {
  offset: number;
  stride: number;
}

export interface PlanarFrame {
  format: PlanarFormat;
  width: number;
  height: number;
  data: ArrayBuffer;
  /** Byte offset and stride of the Y, Cb and Cr planes. */
  layout: PlaneLayoutLike[];
}

export interface ConvertedFrame {
  format: "I420P10";
  width: number;
  height: number;
  data: ArrayBuffer;
  layout: PlaneLayoutLike[];
}

/** The proxy's size for a master of `width`×`height`: no taller than
 * `maxHeight`, the aspect kept, both sides even (4:2:0 has no odd sizes). */
export function proxySize(width: number, height: number, maxHeight: number): { width: number; height: number } {
  const even = (n: number) => Math.max(2, n - (n % 2));
  if (height <= maxHeight) return { width: even(width), height: even(height) };
  const h = even(Math.floor(maxHeight));
  return { width: even(Math.round((width * h) / height)), height: h };
}

/** For each source index along one axis, the output indexes it lands in and
 * the share of it each one takes: an area filter, separable. A source pixel
 * on an output boundary is split between the two. */
function areaMap(srcSize: number, outSize: number): { at: Int32Array; w: Float32Array; n: Uint8Array } {
  const ratio = outSize / srcSize;
  const at = new Int32Array(srcSize * 2);
  const w = new Float32Array(srcSize * 2);
  const n = new Uint8Array(srcSize);
  for (let i = 0; i < srcSize; i++) {
    const a = i * ratio;
    const b = (i + 1) * ratio;
    const first = Math.min(outSize - 1, Math.floor(a));
    const last = Math.min(outSize - 1, Math.ceil(b) - 1);
    if (last <= first) {
      at[i * 2] = first;
      w[i * 2] = 1;
      n[i] = 1;
    } else {
      // Straddles the boundary at `first + 1`: split by the share on each side.
      const cut = (first + 1 - a) / ratio;
      at[i * 2] = first;
      w[i * 2] = cut;
      at[i * 2 + 1] = last;
      w[i * 2 + 1] = 1 - cut;
      n[i] = 2;
    }
  }
  return { at, w, n };
}

/** Whether the frame already is what the conversion would produce, so the
 * planes pass through untouched. */
export const planesPassThrough = (
  format: PlanarFormat,
  from: Pick<CodeFormat, "matrix" | "fullRange">,
  size: { width: number; height: number; maxHeight: number }
): boolean =>
  format === "I420P10" &&
  from.matrix === "bt709" &&
  !from.fullRange &&
  size.height <= size.maxHeight &&
  size.width % 2 === 0 &&
  size.height % 2 === 0;

/**
 * Convert a frame's planes from `from` to Rec.709 limited 4:2:0 10-bit.
 * Chroma is read at the nearest sample and written as the mean over each
 * output block, so a 4:2:2 or 4:4:4 source keeps its luma and averages
 * its chroma down.
 */
export function convertPlanes(
  frame: PlanarFrame,
  from: Pick<CodeFormat, "matrix" | "fullRange">,
  opts: { maxHeight?: number } = {}
): ConvertedFrame {
  const { hs, vs, depth } = FORMATS[frame.format];
  const { kr, kb } = COEFFICIENTS[from.matrix];
  const kg = 1 - kr - kb;
  const { width, height } = frame;
  const src = new Uint16Array(frame.data);
  const [ly, lu, lv] = frame.layout;
  const yOff = ly.offset >> 1, yStride = ly.stride >> 1;
  const uOff = lu.offset >> 1, uStride = lu.stride >> 1;
  const vOff = lv.offset >> 1, vStride = lv.stride >> 1;

  const scale = 1 << (depth - 8);
  const full = from.fullRange;
  const yBias = full ? 0 : 16 * scale;
  const yRange = full ? (1 << depth) - 1 : 219 * scale;
  // Full-range chroma centers on 2^(d-1) and spans 2^d - 1 (BT.2100).
  const cBias = full ? 1 << (depth - 1) : 128 * scale;
  const cRange = full ? (1 << depth) - 1 : 224 * scale;
  const rCr = 2 * (1 - kr);
  const bCb = 2 * (1 - kb);
  // Rec.709 limited, 10-bit out.
  const OKR = 0.2126, OKB = 0.0722, OKG = 1 - OKR - OKB;
  const oCb = 1 / (2 * (1 - OKB));
  const oCr = 1 / (2 * (1 - OKR));

  const size = proxySize(width, height, opts.maxHeight ?? height);
  const outW = size.width;
  const outH = size.height;
  const scaled = outW !== width || outH !== height;
  const cw = outW >> 1;
  const ch = outH >> 1;
  const bytes = (outW * outH + 2 * cw * ch) * 2;
  const data = new ArrayBuffer(bytes);
  const out = new Uint16Array(data);
  const outU = outW * outH;
  const outV = outU + cw * ch;
  const sumCb = new Float32Array(cw * ch);
  const sumCr = new Float32Array(cw * ch);
  const wC = new Float32Array(cw * ch);
  // The scaled path gathers luma too; the unscaled one writes it straight.
  const sumY = scaled ? new Float32Array(outW * outH) : null;
  const wY = scaled ? new Float32Array(outW * outH) : null;
  const xm = scaled ? areaMap(width, outW) : null;
  const ym = scaled ? areaMap(height, outH) : null;

  const clampY = (v: number) => (v < 0 ? 0 : v > 1023 ? 1023 : v);
  for (let y = 0; y < height; y++) {
    const sy = y >> vs;
    const rowY = yOff + y * yStride;
    const rowU = uOff + sy * uStride;
    const rowV = vOff + sy * vStride;
    const oy = Math.min(outH - 1, y);
    for (let x = 0; x < width; x++) {
      const sx = x >> hs;
      const yy = (src[rowY + x] - yBias) / yRange;
      const cb = (src[rowU + sx] - cBias) / cRange;
      const cr = (src[rowV + sx] - cBias) / cRange;
      const r = yy + rCr * cr;
      const b = yy + bCb * cb;
      const g = (yy - kr * r - kb * b) / kg;
      const ny = OKR * r + OKG * g + OKB * b;
      const ncb = (b - ny) * oCb;
      const ncr = (r - ny) * oCr;
      if (!scaled) {
        out[oy * outW + x] = clampY(Math.round(64 + 876 * ny));
        const ci = (oy >> 1) * cw + (x >> 1);
        sumCb[ci] += ncb;
        sumCr[ci] += ncr;
        wC[ci] += 1;
        continue;
      }
      for (let j = 0; j < ym!.n[y]; j++) {
        const ty = ym!.at[y * 2 + j];
        const wy = ym!.w[y * 2 + j];
        for (let i = 0; i < xm!.n[x]; i++) {
          const tx = xm!.at[x * 2 + i];
          const w = wy * xm!.w[x * 2 + i];
          const li = ty * outW + tx;
          sumY![li] += w * ny;
          wY![li] += w;
          const ci = (ty >> 1) * cw + (tx >> 1);
          sumCb[ci] += w * ncb;
          sumCr[ci] += w * ncr;
          wC[ci] += w;
        }
      }
    }
  }
  if (scaled) {
    for (let i = 0; i < outW * outH; i++) {
      out[i] = clampY(Math.round(64 + 876 * (sumY![i] / (wY![i] || 1))));
    }
  }
  for (let i = 0; i < cw * ch; i++) {
    const n = wC[i] || 1;
    const cbv = Math.round(512 + 896 * (sumCb[i] / n));
    const crv = Math.round(512 + 896 * (sumCr[i] / n));
    out[outU + i] = cbv < 0 ? 0 : cbv > 1023 ? 1023 : cbv;
    out[outV + i] = crv < 0 ? 0 : crv > 1023 ? 1023 : crv;
  }
  return {
    format: "I420P10",
    width: outW,
    height: outH,
    data,
    layout: [
      { offset: 0, stride: outW * 2 },
      { offset: outU * 2, stride: cw * 2 },
      { offset: outV * 2, stride: cw * 2 },
    ],
  };
}
