/**
 * Color science primitives, each one a published standard: Apple Log, the
 * Rec.709 / Rec.2020 / P3 / Apple Wide Gamut / ACES primaries and their XYZ
 * matrices, BT.1886, BT.2100 HLG and PQ, the BT.2408 SDR-in-HDR mapping,
 * CAT02 and Bradford chromatic adaptation, the Planckian locus for white
 * balance, and Oklab. Every transform in the grade pipeline is built from
 * these; nothing here is tuned by eye.
 *
 * Matrices are 9 numbers, row-major, applied to column vectors: out_i =
 * Σ_j M[i*3+j] · v_j.
 */

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

/** What a clip's code values mean. The first two need no conversion; the
 * log profiles go through the ACES 2.0 output transform, HLG and PQ through
 * the BT.2100 OOTF. */
export type SourceProfile = "rec709" | "srgb" | "apple-log" | "apple-log-2" | "hlg" | "pq";

export const SOURCE_PROFILES: { id: SourceProfile; label: string; detail: string }[] = [
  { id: "rec709", label: "Rec.709", detail: "Display-referred video; no conversion." },
  { id: "srgb", label: "sRGB", detail: "Screen recordings and images; no conversion." },
  { id: "apple-log", label: "Apple Log", detail: "iPhone ProRes Log in the Rec.2020 gamut." },
  { id: "apple-log-2", label: "Apple Log 2", detail: "iPhone Log in the Apple Wide Gamut." },
  { id: "hlg", label: "HLG", detail: "Rec.2100 hybrid log-gamma HDR video." },
  { id: "pq", label: "PQ", detail: "Rec.2100 PQ (HDR10) video." },
];

/** The project's delivery space. */
export type OutputSpace = "sdr" | "hlg" | "pq";

export const OUTPUT_SPACES: { id: OutputSpace; label: string; detail: string }[] = [
  { id: "sdr", label: "SDR", detail: "Rec.709, BT.1886, 100 nits." },
  { id: "hlg", label: "HDR (HLG)", detail: "Rec.2100 HLG, 1000-nit reference display." },
  { id: "pq", label: "HDR (PQ)", detail: "Rec.2100 PQ, 1000-nit reference display." },
];

/** How a file's Y'CbCr code values decode to R'G'B'. */
export interface CodeFormat {
  matrix: "bt709" | "bt601" | "bt2020nc";
  fullRange: boolean;
  bitDepth: number;
}

/* ------------------------------------------------------------------ */
/* Matrices                                                            */
/* ------------------------------------------------------------------ */

export type Mat3 = number[];

export const MAT3_IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return out;
}

export function mat3Inv(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) throw new Error("singular matrix");
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}

export function mat3Apply(m: Mat3, r: number, g: number, b: number): [number, number, number] {
  return [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
}

export function mat3Diag(x: number, y: number, z: number): Mat3 {
  return [x, 0, 0, 0, y, 0, 0, 0, z];
}

/* ------------------------------------------------------------------ */
/* Primaries                                                           */
/* ------------------------------------------------------------------ */

export interface Primaries {
  r: [number, number];
  g: [number, number];
  b: [number, number];
  w: [number, number];
}

export const D65: [number, number] = [0.3127, 0.329];
/** The ACES white point (~D60). */
export const ACES_WHITE: [number, number] = [0.32168, 0.33767];

export const REC709_PRIMARIES: Primaries = { r: [0.64, 0.33], g: [0.3, 0.6], b: [0.15, 0.06], w: D65 };
export const REC2020_PRIMARIES: Primaries = { r: [0.708, 0.292], g: [0.17, 0.797], b: [0.131, 0.046], w: D65 };
export const P3D65_PRIMARIES: Primaries = { r: [0.68, 0.32], g: [0.265, 0.69], b: [0.15, 0.06], w: D65 };
/** Apple Wide Gamut, the container of Apple Log 2 (Apple Log 2 white paper). */
export const APPLE_WIDE_GAMUT_PRIMARIES: Primaries = {
  r: [0.725, 0.301],
  g: [0.221, 0.814],
  b: [0.068, -0.076],
  w: D65,
};
export const AP0_PRIMARIES: Primaries = { r: [0.7347, 0.2653], g: [0, 1], b: [0.0001, -0.077], w: ACES_WHITE };
export const AP1_PRIMARIES: Primaries = { r: [0.713, 0.293], g: [0.165, 0.83], b: [0.128, 0.044], w: ACES_WHITE };

export function xyToXYZ(x: number, y: number, Y = 1): [number, number, number] {
  return [(x * Y) / y, Y, ((1 - x - y) * Y) / y];
}

/** RGB → XYZ for a set of primaries, derived from their chromaticities so
 * the white maps to XYZ with Y = 1. */
export function rgbToXyzMatrix(p: Primaries): Mat3 {
  const P: Mat3 = [
    p.r[0], p.g[0], p.b[0],
    p.r[1], p.g[1], p.b[1],
    1 - p.r[0] - p.r[1], 1 - p.g[0] - p.g[1], 1 - p.b[0] - p.b[1],
  ];
  const W = xyToXYZ(p.w[0], p.w[1]);
  const S = mat3Apply(mat3Inv(P), W[0], W[1], W[2]);
  return mat3Mul(P, mat3Diag(S[0], S[1], S[2]));
}

export function xyzToRgbMatrix(p: Primaries): Mat3 {
  return mat3Inv(rgbToXyzMatrix(p));
}

/* ------------------------------------------------------------------ */
/* Chromatic adaptation                                                */
/* ------------------------------------------------------------------ */

/** CAT02 cone response matrix (CIECAM02). */
export const CAT02: Mat3 = [0.7328, 0.4296, -0.1624, -0.7036, 1.6975, 0.0061, 0.003, 0.0136, 0.9834];
/** Bradford cone response matrix, the ACES convention for gamut matrices. */
export const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296];

/** A von Kries adaptation in XYZ from one white to another through the given
 * cone response matrix. */
export function chromaticAdaptation(from: [number, number], to: [number, number], cone: Mat3 = CAT02): Mat3 {
  const src = xyToXYZ(from[0], from[1]);
  const dst = xyToXYZ(to[0], to[1]);
  const s = mat3Apply(cone, src[0], src[1], src[2]);
  const d = mat3Apply(cone, dst[0], dst[1], dst[2]);
  return mat3Mul(mat3Inv(cone), mat3Mul(mat3Diag(d[0] / s[0], d[1] / s[1], d[2] / s[2]), cone));
}

/** RGB → RGB between two sets of primaries, adapting the white with the
 * given cone matrix when the whites differ. */
export function rgbToRgbMatrix(from: Primaries, to: Primaries, cone: Mat3 = BRADFORD): Mat3 {
  const sameWhite = from.w[0] === to.w[0] && from.w[1] === to.w[1];
  const cat = sameWhite ? MAT3_IDENTITY : chromaticAdaptation(from.w, to.w, cone);
  return mat3Mul(xyzToRgbMatrix(to), mat3Mul(cat, rgbToXyzMatrix(from)));
}

/* ------------------------------------------------------------------ */
/* Apple Log                                                           */
/* ------------------------------------------------------------------ */

const AL_R0 = -0.05641088;
const AL_RT = 0.01;
const AL_C = 47.28711236;
const AL_BETA = 0.00964052;
const AL_GAMMA = 0.08550479;
const AL_DELTA = 0.69336945;
const AL_PT = AL_C * (AL_RT - AL_R0) * (AL_RT - AL_R0);

/** Apple Log code value → scene-linear (18% grey at 0.18). Constants from the
 * Apple Log white paper, as carried in OCIO and ACES. */
export function appleLogDecode(p: number): number {
  if (p >= AL_PT) return Math.pow(2, (p - AL_DELTA) / AL_GAMMA) - AL_BETA;
  if (p >= 0) return Math.sqrt(p / AL_C) + AL_R0;
  return AL_R0;
}

/** Scene-linear → Apple Log code value. */
export function appleLogEncode(r: number): number {
  if (r >= AL_RT) return AL_GAMMA * Math.log2(r + AL_BETA) + AL_DELTA;
  if (r >= AL_R0) return AL_C * (r - AL_R0) * (r - AL_R0);
  return 0;
}

/* ------------------------------------------------------------------ */
/* Transfer functions                                                  */
/* ------------------------------------------------------------------ */

/** Signed power: negative inputs mirror, so an out-of-range intermediate
 * value stays continuous through an encode and the final clamp decides. */
export function spow(x: number, e: number): number {
  return x < 0 ? -Math.pow(-x, e) : Math.pow(x, e);
}

/** BT.1886 EOTF, L = a·(V + b)^2.4 with Lw = 1, Lb = 0. */
export function bt1886Decode(v: number): number {
  return spow(v, 2.4);
}

export function bt1886Encode(l: number): number {
  return spow(l, 1 / 2.4);
}

const HLG_A = 0.17883277;
const HLG_B = 0.28466892;
const HLG_C = 0.55991073;

/** BT.2100 HLG OETF: scene-linear (0..1) → signal. */
export function hlgOetf(e: number): number {
  if (e <= 0) return 0;
  return e <= 1 / 12 ? Math.sqrt(3 * e) : HLG_A * Math.log(12 * e - HLG_B) + HLG_C;
}

/** BT.2100 HLG inverse OETF: signal → scene-linear. */
export function hlgOetfInverse(s: number): number {
  if (s <= 0) return 0;
  return s <= 0.5 ? (s * s) / 3 : (Math.exp((s - HLG_C) / HLG_A) + HLG_B) / 12;
}

/** HLG system gamma for a display of the given peak (1.2 at 1000 nits):
 * BT.2100's formula across its 400–2000 nit range, BT.2390's extended one
 * outside it (0.846 on a 100-nit SDR display). */
export function hlgGamma(peakNits = 1000): number {
  if (peakNits >= 400 && peakNits <= 2000) return 1.2 + 0.42 * Math.log10(peakNits / 1000);
  return 1.2 * Math.pow(1.111, Math.log2(peakNits / 1000));
}

/** sRGB transfer: display-linear → signal. */
export function srgbEncode(l: number): number {
  return l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
}

const REC2020_LUMA = [0.2627, 0.678, 0.0593];

/** BT.2100 HLG OOTF: scene-linear RGB → display light in nits. */
export function hlgOotf(r: number, g: number, b: number, peakNits = 1000): [number, number, number] {
  const ys = REC2020_LUMA[0] * r + REC2020_LUMA[1] * g + REC2020_LUMA[2] * b;
  const k = ys > 0 ? peakNits * Math.pow(ys, hlgGamma(peakNits) - 1) : 0;
  return [k * r, k * g, k * b];
}

/** BT.2100 HLG inverse OOTF: display light in nits → scene-linear RGB. */
export function hlgOotfInverse(r: number, g: number, b: number, peakNits = 1000): [number, number, number] {
  const yd = REC2020_LUMA[0] * r + REC2020_LUMA[1] * g + REC2020_LUMA[2] * b;
  if (yd <= 0) return [0, 0, 0];
  const gamma = hlgGamma(peakNits);
  const k = Math.pow(yd / peakNits, (1 - gamma) / gamma) / peakNits;
  return [k * r, k * g, k * b];
}

const PQ_M1 = 0.1593017578125;
const PQ_M2 = 78.84375;
const PQ_C1 = 0.8359375;
const PQ_C2 = 18.8515625;
const PQ_C3 = 18.6875;

/** SMPTE ST 2084 EOTF: signal → nits. */
export function pqDecode(n: number): number {
  if (n <= 0) return 0;
  const np = Math.pow(n, 1 / PQ_M2);
  const l = Math.max(0, np - PQ_C1) / (PQ_C2 - PQ_C3 * np);
  return Math.pow(l, 1 / PQ_M1) * 10000;
}

/** SMPTE ST 2084 inverse EOTF: nits → signal. */
export function pqEncode(nits: number): number {
  if (nits <= 0) return 0;
  const lm = Math.pow(nits / 10000, PQ_M1);
  return Math.pow((PQ_C1 + PQ_C2 * lm) / (1 + PQ_C3 * lm), PQ_M2);
}

/* ------------------------------------------------------------------ */
/* BT.2408: SDR inside an HDR container                                */
/* ------------------------------------------------------------------ */

/** Reference white for SDR graphics and video placed in HDR (BT.2408). */
export const BT2408_REFERENCE_WHITE_NITS = 203;
/** HLG signal at reference white: 75%. */
export const BT2408_HLG_WHITE = 0.75;
/** HLG scene-linear value at reference white; the scale between the HLG
 * scene and a scene where diffuse white is 1.0. */
export const HLG_SCENE_WHITE = hlgOetfInverse(BT2408_HLG_WHITE);

const REC709_TO_REC2020 = rgbToRgbMatrix(REC709_PRIMARIES, REC2020_PRIMARIES);

/** Rec.709 display-linear (1.0 = 100 nits) → Rec.2020 display light in nits
 * with SDR white at 203 nits. */
export function sdrToHdrNits(r: number, g: number, b: number): [number, number, number] {
  const k = BT2408_REFERENCE_WHITE_NITS;
  return mat3Apply(REC709_TO_REC2020, r * k, g * k, b * k);
}

/** Rec.709 display-linear → Rec.2100 HLG signal (BT.2408: white at 75%). */
export function sdrToHlg(r: number, g: number, b: number): [number, number, number] {
  const [rd, gd, bd] = sdrToHdrNits(r, g, b);
  const [rs, gs, bs] = hlgOotfInverse(rd, gd, bd, 1000);
  return [hlgOetf(rs), hlgOetf(gs), hlgOetf(bs)];
}

/** Rec.709 display-linear → Rec.2100 PQ signal (BT.2408: white at 203 nits). */
export function sdrToPq(r: number, g: number, b: number): [number, number, number] {
  const [rd, gd, bd] = sdrToHdrNits(r, g, b);
  return [pqEncode(rd), pqEncode(gd), pqEncode(bd)];
}

/* ------------------------------------------------------------------ */
/* White balance: the Planckian locus and its isotherms                */
/* ------------------------------------------------------------------ */

/** CIE 1931 chromaticity of a Planckian radiator (Kim et al. 2002; valid
 * 1667–25000 K). */
export function planckianXy(kelvin: number): [number, number] {
  const T = Math.max(1667, Math.min(25000, kelvin));
  const t2 = T * T;
  const t3 = t2 * T;
  const x =
    T <= 4000
      ? -0.2661239e9 / t3 - 0.234358e6 / t2 + 0.8776956e3 / T + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / T + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    T <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  return [x, y];
}

export function xyToUv(x: number, y: number): [number, number] {
  const d = -2 * x + 12 * y + 3;
  return [(4 * x) / d, (6 * y) / d];
}

export function uvToXy(u: number, v: number): [number, number] {
  const d = 2 * u - 8 * v + 4;
  return [(3 * u) / d, (2 * v) / d];
}

export const D65_KELVIN = 6504;

/**
 * The chromaticity of an illuminant described by a mired shift from D65 and a
 * distance along the isotherm, in CIE 1960 uv: the locus point moves with the
 * mired shift, and Δuv (positive toward green) walks the isotherm, the normal
 * to the locus at that temperature. D65 itself sits a little off the
 * Planckian locus, so the walk is relative to its own position.
 */
export function illuminantXy(miredShift: number, duv: number): [number, number] {
  const mired = 1e6 / D65_KELVIN + miredShift;
  const kelvin = 1e6 / Math.max(40, mired);
  const [xd, yd] = D65;
  const [ud, vd] = xyToUv(xd, yd);
  const at = (k: number) => {
    const [x, y] = planckianXy(k);
    return xyToUv(x, y);
  };
  const [u0, v0] = at(D65_KELVIN);
  const [u1, v1] = at(kelvin);
  // Tangent along increasing mired (toward warm); the normal points to the
  // green side, above the locus in uv.
  const [ua, va] = at(1e6 / (1e6 / kelvin - 1));
  const [ub, vb] = at(1e6 / (1e6 / kelvin + 1));
  let nu = -(vb - va);
  let nv = ub - ua;
  const len = Math.hypot(nu, nv) || 1;
  nu /= len;
  nv /= len;
  if (nv < 0) {
    nu = -nu;
    nv = -nv;
  }
  const u = ud + (u1 - u0) + duv * nu;
  const v = vd + (v1 - v0) + duv * nv;
  return uvToXy(u, v);
}

/**
 * The RGB matrix that neutralizes an illuminant: a CAT02 adaptation from the
 * assumed scene white to D65, wrapped in the container primaries. A warm
 * result comes from assuming a cool light, so a positive mired shift on the
 * slider means the assumed illuminant sits that many mireds *below* D65.
 */
export function whiteBalanceMatrix(primaries: Primaries, assumed: [number, number]): Mat3 {
  const cat = chromaticAdaptation(assumed, D65, CAT02);
  return mat3Mul(xyzToRgbMatrix(primaries), mat3Mul(cat, rgbToXyzMatrix(primaries)));
}

/* ------------------------------------------------------------------ */
/* Oklab (Björn Ottosson, CSS Color 4)                                 */
/* ------------------------------------------------------------------ */

const OK_M1_XYZ: Mat3 = [
  0.8189330101, 0.3618667424, -0.1288597137,
  0.0329845436, 0.9293118715, 0.0361456387,
  0.0482003018, 0.2643662691, 0.633851707,
];
const OK_M2: Mat3 = [
  0.2104542553, 0.793617785, -0.0040720468,
  1.9779984951, -2.428592205, 0.4505937099,
  0.0259040371, 0.7827717662, -0.808675766,
];
const OK_M2_INV = mat3Inv(OK_M2);
const OK_M1_XYZ_INV = mat3Inv(OK_M1_XYZ);

/** LMS' → Lab and back, for callers that inline the conversion. */
export { OK_M2 as OKLAB_M2, OK_M2_INV as OKLAB_M2_INV };

/** Linear RGB in the given primaries → Oklab, through XYZ (D65). */
export function oklabMatrices(p: Primaries): { toLms: Mat3; fromLms: Mat3 } {
  const toLms = mat3Mul(OK_M1_XYZ, rgbToXyzMatrix(p));
  return { toLms, fromLms: mat3Inv(toLms) };
}

export function linearToOklab(toLms: Mat3, r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(toLms[0] * r + toLms[1] * g + toLms[2] * b);
  const m = Math.cbrt(toLms[3] * r + toLms[4] * g + toLms[5] * b);
  const s = Math.cbrt(toLms[6] * r + toLms[7] * g + toLms[8] * b);
  return mat3Apply(OK_M2, l, m, s);
}

export function oklabToLinear(fromLms: Mat3, L: number, a: number, b: number): [number, number, number] {
  const [l, m, s] = mat3Apply(OK_M2_INV, L, a, b);
  return mat3Apply(fromLms, l * l * l, m * m * m, s * s * s);
}

export { OK_M1_XYZ_INV as OKLAB_LMS_TO_XYZ };

/** Oklab → OkLCh: hue in degrees [0, 360). */
export function oklabToLch(L: number, a: number, b: number): [number, number, number] {
  const c = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return [L, c, h];
}

export function lchToOklab(L: number, c: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  return [L, c * Math.cos(rad), c * Math.sin(rad)];
}
