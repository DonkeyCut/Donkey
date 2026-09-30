/**
 * ACES 2.0 Output Transform, ported from the Academy's reference CTL
 * (github.com/aces-aswf/aces-core, lib/Lib.Academy.OutputTransform.ctl,
 * Lib.Academy.Tonescale.ctl, Lib.Academy.DisplayEncoding.ctl, and the preset
 * files under github.com/aces-aswf/aces-output).
 *
 * SPDX-License-Identifier: Apache-2.0
 * Copyright Contributors to the ACES Project. Licensed under the Apache
 * License, Version 2.0; a copy is at http://www.apache.org/licenses/LICENSE-2.0.
 * This file is a derivative work of that reference, restated in TypeScript.
 *
 * The transform takes scene-linear ACES2065-1 (AP0) and produces display
 * code values: a Hellwig 2022 / CAM16 appearance model, the tonescale, chroma
 * compression, hue-dependent gamut compression, then the display's EOTF
 * inverse. The heavy work is in the tables built once per preset; the per-
 * pixel path is `forward`.
 *
 * The reference's matrix convention is row-vector (v · M); this port keeps
 * it for every matrix built here, so the two can be read side by side.
 */

import type { Primaries } from "./colorSpace";
import { AP0_PRIMARIES, AP1_PRIMARIES, P3D65_PRIMARIES, REC2020_PRIMARIES, REC709_PRIMARIES } from "./colorSpace";

type M33 = number[][];
type V3 = [number, number, number];

/* ------------------------------------------------------------------ */
/* Row-vector matrix helpers (as the CTL library)                      */
/* ------------------------------------------------------------------ */

function multF3F33(v: V3, m: M33): V3 {
  return [
    v[0] * m[0][0] + v[1] * m[1][0] + v[2] * m[2][0],
    v[0] * m[0][1] + v[1] * m[1][1] + v[2] * m[2][1],
    v[0] * m[0][2] + v[1] * m[1][2] + v[2] * m[2][2],
  ];
}

function multF33F33(a: M33, b: M33): M33 {
  const out: M33 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return out;
}

function multFF33(s: number, m: M33): M33 {
  return m.map((row) => row.map((v) => v * s));
}

function invertF33(m: M33): M33 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = 1 / det;
  return [
    [A * s, -(b * i - c * h) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, -(a * f - c * d) * s],
    [C * s, -(a * h - b * g) * s, (a * e - b * d) * s],
  ];
}

/** RGBtoXYZ_f33 from the reference: rows are the primaries' XYZ, scaled so
 * white lands on Y. */
function rgbToXyzF33(c: Primaries, Y: number): M33 {
  const X = (c.w[0] * Y) / c.w[1];
  const Z = ((1 - c.w[0] - c.w[1]) * Y) / c.w[1];
  const d =
    c.r[0] * (c.b[1] - c.g[1]) + c.b[0] * (c.g[1] - c.r[1]) + c.g[0] * (c.r[1] - c.b[1]);
  const Sr =
    (X * (c.b[1] - c.g[1]) -
      c.g[0] * (Y * (c.b[1] - 1) + c.b[1] * (X + Z)) +
      c.b[0] * (Y * (c.g[1] - 1) + c.g[1] * (X + Z))) /
    d;
  const Sg =
    (X * (c.r[1] - c.b[1]) +
      c.r[0] * (Y * (c.b[1] - 1) + c.b[1] * (X + Z)) -
      c.b[0] * (Y * (c.r[1] - 1) + c.r[1] * (X + Z))) /
    d;
  const Sb =
    (X * (c.g[1] - c.r[1]) -
      c.r[0] * (Y * (c.g[1] - 1) + c.g[1] * (X + Z)) +
      c.g[0] * (Y * (c.r[1] - 1) + c.r[1] * (X + Z))) /
    d;
  return [
    [Sr * c.r[0], Sr * c.r[1], Sr * (1 - c.r[0] - c.r[1])],
    [Sg * c.g[0], Sg * c.g[1], Sg * (1 - c.g[0] - c.g[1])],
    [Sb * c.b[0], Sb * c.b[1], Sb * (1 - c.b[0] - c.b[1])],
  ];
}

function xyzToRgbF33(c: Primaries, Y: number): M33 {
  return invertF33(rgbToXyzF33(c, Y));
}

const AP0_XYZ_TO_RGB = xyzToRgbF33(AP0_PRIMARIES, 1);
const AP0_RGB_TO_XYZ = rgbToXyzF33(AP0_PRIMARIES, 1);
const AP1_XYZ_TO_RGB = xyzToRgbF33(AP1_PRIMARIES, 1);
const AP1_RGB_TO_XYZ = rgbToXyzF33(AP1_PRIMARIES, 1);
const AP0_TO_AP1 = multF33F33(AP0_RGB_TO_XYZ, AP1_XYZ_TO_RGB);
const AP1_TO_AP0 = multF33F33(AP1_RGB_TO_XYZ, AP0_XYZ_TO_RGB);

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const REACH_PRI = AP1_PRIMARIES;

const tableSize = 360;
const additionalTableEntries = 2;
const totalTableSize = tableSize + additionalTableEntries;
const baseIndex = 1;
const hue_limit = 360;

const cuspCornerCount = 6;
const totalCornerCount = cuspCornerCount + 2;
const max_sorted_corners = 2 * cuspCornerCount;
const reach_cusp_tolerance = 1e-3;
const display_cusp_tolerance = 1e-7;

const gamma_minimum = 0;
const gamma_maximum = 5;
const gamma_search_step = 0.4;
const gamma_accuracy = 1e-5;

const ref_luminance = 100;
const L_A = 100;
const Y_b = 20;
const surround = [0.9, 0.59, 0.9];

const J_scale = 100;
const cam_nl_Y_reference = 100;
const cam_nl_offset = 0.2713 * cam_nl_Y_reference;
const cam_nl_scale = 4 * cam_nl_Y_reference;

const model_gamma = surround[1] * (1.48 + Math.sqrt(Y_b / ref_luminance));

const chroma_compress = 2.4;
const chroma_compress_fact = 3.3;
const chroma_expand = 1.3;
const chroma_expand_fact = 0.69;
const chroma_expand_thr = 0.5;

const smooth_cusps = 0.12;
const smooth_m = 0.27;
const cusp_mid_blend = 1.3;

const focus_gain_blend = 0.3;
const focus_adjust_gain = 0.55;
const focus_distance = 1.35;
const focus_distance_scaling = 1.75;

const compression_threshold = 0.75;

const MATRIX_IDENTITY: M33 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

void focus_adjust_gain;

/* ------------------------------------------------------------------ */
/* Tonescale (Lib.Academy.Tonescale)                                   */
/* ------------------------------------------------------------------ */

interface TSParams {
  n: number;
  n_r: number;
  g: number;
  t_1: number;
  c_t: number;
  s_2: number;
  u_2: number;
  m_2: number;
  forward_limit: number;
  inverse_limit: number;
  log_peak: number;
}

function initTSParams(peakLuminance: number): TSParams {
  const n = peakLuminance;
  const n_r = 100;
  const g = 1.15;
  const c = 0.18;
  const c_d = 10.013;
  const w_g = 0.14;
  const t_1 = 0.04;
  const r_hit_min = 128;
  const r_hit_max = 896;

  const r_hit = r_hit_min + ((r_hit_max - r_hit_min) * Math.log(n / n_r)) / Math.log(10000 / 100);
  const m_0 = n / n_r;
  const m_1 = 0.5 * (m_0 + Math.sqrt(m_0 * (m_0 + 4 * t_1)));
  const u = Math.pow(r_hit / m_1 / (r_hit / m_1 + 1), g);
  const m = m_1 / u;
  const w_i = Math.log(n / 100) / Math.log(2);
  const c_t = (c_d / n_r) * (1 + w_i * w_g);
  const g_ip = 0.5 * (c_t + Math.sqrt(c_t * (c_t + 4 * t_1)));
  const g_ipp2 = -(m_1 * Math.pow(g_ip / m, 1 / g)) / (Math.pow(g_ip / m, 1 / g) - 1);
  const w_2 = c / g_ipp2;
  const s_2 = w_2 * m_1;
  const u_2 = Math.pow(r_hit / m_1 / (r_hit / m_1 + w_2), g);
  const m_2 = m_1 / u_2;

  return {
    n,
    n_r,
    g,
    t_1,
    c_t,
    s_2,
    u_2,
    m_2,
    forward_limit: 8 * r_hit,
    inverse_limit: n / (u_2 * n_r),
    log_peak: Math.log10(n / n_r),
  };
}

function tonescaleFwd(x: number, p: TSParams): number {
  const f = p.m_2 * Math.pow(Math.max(0, x) / (x + p.s_2), p.g);
  const h = Math.max(0, (f * f) / (f + p.t_1));
  return h * p.n_r;
}

/* ------------------------------------------------------------------ */
/* CAM                                                                 */
/* ------------------------------------------------------------------ */

interface JMhParams {
  MATRIX_RGB_to_CAM16_c: M33;
  MATRIX_CAM16_c_to_RGB: M33;
  MATRIX_cone_response_to_Aab: M33;
  MATRIX_Aab_to_cone_response: M33;
  F_L_n: number;
  cz: number;
  inv_cz: number;
  A_w_J: number;
  inv_A_w_J: number;
}

function compressionFwdAbs(Rc: number): number {
  const F_L_Y = Math.pow(Rc, 0.42);
  return F_L_Y / (cam_nl_offset + F_L_Y);
}

function compressionInvAbs(Ra: number): number {
  const Ra_lim = Math.min(Ra, 0.99);
  const F_L_Y = (cam_nl_offset * Ra_lim) / (1 - Ra_lim);
  return Math.pow(F_L_Y, 1 / 0.42);
}

function compressionFwd(v: number): number {
  const r = compressionFwdAbs(Math.abs(v));
  return v < 0 ? -r : r;
}

function compressionInv(v: number): number {
  const r = compressionInvAbs(Math.abs(v));
  return v < 0 ? -r : r;
}

function achromaticToJ(A: number, cz: number): number {
  return J_scale * Math.pow(A, cz);
}

function jToAchromatic(J: number, inv_cz: number): number {
  return Math.pow(J * (1 / J_scale), inv_cz);
}

function aToY(A: number, p: JMhParams): number {
  const Ra = p.A_w_J * A;
  return compressionInvAbs(Ra) / p.F_L_n;
}

function jToY(J: number, p: JMhParams): number {
  return aToY(jToAchromatic(Math.abs(J), p.inv_cz), p);
}

function yToJ(Y: number, p: JMhParams): number {
  const Ra = compressionFwdAbs(Math.abs(Y) * p.F_L_n);
  const J = achromaticToJ(Ra * p.inv_A_w_J, p.cz);
  return Y < 0 ? -J : J;
}

function wrapTo360(hue: number): number {
  let y = hue % 360;
  if (y < 0) y += 360;
  return y;
}

function rgbToAab(RGB: V3, p: JMhParams): V3 {
  const rgb_m = multF3F33(RGB, p.MATRIX_RGB_to_CAM16_c);
  const rgb_a: V3 = [compressionFwd(rgb_m[0]), compressionFwd(rgb_m[1]), compressionFwd(rgb_m[2])];
  return multF3F33(rgb_a, p.MATRIX_cone_response_to_Aab);
}

function aabToJMh(Aab: V3, p: JMhParams): V3 {
  if (Aab[0] <= 0) return [0, 0, 0];
  const J = achromaticToJ(Aab[0], p.cz);
  const M = Math.sqrt(Aab[1] * Aab[1] + Aab[2] * Aab[2]);
  const h = wrapTo360((Math.atan2(Aab[2], Aab[1]) * 180) / Math.PI);
  return [J, M, h];
}

function rgbToJMh(RGB: V3, p: JMhParams): V3 {
  return aabToJMh(rgbToAab(RGB, p), p);
}

function jmhToRgb(JMh: V3, p: JMhParams): V3 {
  const h_rad = (JMh[2] * Math.PI) / 180;
  const A = jToAchromatic(JMh[0], p.inv_cz);
  const Aab: V3 = [A, JMh[1] * Math.cos(h_rad), JMh[1] * Math.sin(h_rad)];
  const rgb_a = multF3F33(Aab, p.MATRIX_Aab_to_cone_response);
  const rgb_m: V3 = [compressionInv(rgb_a[0]), compressionInv(rgb_a[1]), compressionInv(rgb_a[2])];
  return multF3F33(rgb_m, p.MATRIX_CAM16_c_to_RGB);
}

function initJMhParams(prims: Primaries): JMhParams {
  const CAM16_PRI: Primaries = { r: [0.8336, 0.1735], g: [2.3854, -1.4659], b: [0.087, -0.125], w: [0.333, 0.333] };
  const MATRIX_16 = xyzToRgbF33(CAM16_PRI, 1);
  const base_cone_response_to_Aab: M33 = [
    [2, 1, 1 / 9],
    [1, -12 / 11, 1 / 9],
    [1 / 20, 1 / 11, -2 / 9],
  ];
  const RGB_TO_XYZ = rgbToXyzF33(prims, 1);
  const XYZ_w = multF3F33([ref_luminance, ref_luminance, ref_luminance], RGB_TO_XYZ);
  const Y_w = XYZ_w[1];
  const RGB_w = multF3F33(XYZ_w, MATRIX_16);

  const k = 1 / (5 * L_A + 1);
  const k4 = k * k * k * k;
  const F_L = 0.2 * k4 * (5 * L_A) + 0.1 * Math.pow(1 - k4, 2) * Math.pow(5 * L_A, 1 / 3);
  const F_L_n = F_L / ref_luminance;
  const cz = model_gamma;

  const D_RGB: V3 = [(F_L_n * Y_w) / RGB_w[0], (F_L_n * Y_w) / RGB_w[1], (F_L_n * Y_w) / RGB_w[2]];
  const RGB_wc: V3 = [D_RGB[0] * RGB_w[0], D_RGB[1] * RGB_w[1], D_RGB[2] * RGB_w[2]];
  const RGB_Aw: V3 = [compressionFwd(RGB_wc[0]), compressionFwd(RGB_wc[1]), compressionFwd(RGB_wc[2])];

  const cone_response_to_Aab = multF33F33(multFF33(cam_nl_scale, MATRIX_IDENTITY), base_cone_response_to_Aab);
  const A_w =
    cone_response_to_Aab[0][0] * RGB_Aw[0] + cone_response_to_Aab[1][0] * RGB_Aw[1] + cone_response_to_Aab[2][0] * RGB_Aw[2];
  const A_w_J = compressionFwdAbs(F_L);

  const M1 = multF33F33(RGB_TO_XYZ, MATRIX_16);
  const M2 = multFF33(ref_luminance, MATRIX_IDENTITY);
  const MATRIX_RGB_to_CAM16 = multF33F33(M1, M2);
  const diagD: M33 = [[D_RGB[0], 0, 0], [0, D_RGB[1], 0], [0, 0, D_RGB[2]]];
  const MATRIX_RGB_to_CAM16_c = multF33F33(MATRIX_RGB_to_CAM16, diagD);

  const s = 43 * surround[2];
  const MATRIX_cone_response_to_Aab: M33 = [
    [cone_response_to_Aab[0][0] / A_w, cone_response_to_Aab[0][1] * s, cone_response_to_Aab[0][2] * s],
    [cone_response_to_Aab[1][0] / A_w, cone_response_to_Aab[1][1] * s, cone_response_to_Aab[1][2] * s],
    [cone_response_to_Aab[2][0] / A_w, cone_response_to_Aab[2][1] * s, cone_response_to_Aab[2][2] * s],
  ];

  return {
    MATRIX_RGB_to_CAM16_c,
    MATRIX_CAM16_c_to_RGB: invertF33(MATRIX_RGB_to_CAM16_c),
    MATRIX_cone_response_to_Aab,
    MATRIX_Aab_to_cone_response: invertF33(MATRIX_cone_response_to_Aab),
    F_L_n,
    cz,
    inv_cz: 1 / cz,
    A_w_J,
    inv_A_w_J: 1 / A_w_J,
  };
}

/* ------------------------------------------------------------------ */
/* ODT parameters and tables                                           */
/* ------------------------------------------------------------------ */

interface ODTParams {
  peakLuminance: number;
  input_params: JMhParams;
  reach_params: JMhParams;
  limit_params: JMhParams;
  ts: TSParams;
  limit_J_max: number;
  model_gamma_inv: number;
  TABLE_reach_M: Float64Array;
  sat: number;
  sat_thr: number;
  compr: number;
  chroma_compress_scale: number;
  mid_J: number;
  focus_dist: number;
  lower_hull_gamma_inv: number;
  TABLE_hues: Float64Array;
  TABLE_gamut_cusps: number[][];
  TABLE_upper_hull_gamma: Float64Array;
  hue_linearity_search_range: [number, number];
}

function huePositionInUniformTable(hue: number, table_size: number): number {
  return Math.floor((wrapTo360(hue) / hue_limit) * table_size);
}

function nextPositionInTable(entry: number, table_size: number): number {
  return (entry + 1) % table_size;
}

function baseHueForPosition(i_lo: number, table_size: number): number {
  return (i_lo * hue_limit) / table_size;
}

const lerp = (a: number, b: number, t: number) => a + t * (b - a);

/** The reference's round(): halves away from zero, then truncate. */
function ctlRound(x: number): number {
  return x < 0 ? Math.trunc(x - 0.5) : Math.trunc(x + 0.5);
}

function reachMFromTable(h: number, table: Float64Array): number {
  const base = huePositionInUniformTable(h, tableSize);
  const t = h - base;
  const i_lo = base + baseIndex;
  return lerp(table[i_lo], table[i_lo + 1], t);
}

function reinhardRemap(scale: number, nd: number): number {
  return (scale * nd) / (1 + nd);
}

function toe(x: number, limit: number, k1_in: number, k2_in: number): number {
  if (x > limit) return x;
  const k2 = Math.max(k2_in, 0.001);
  const k1 = Math.sqrt(k1_in * k1_in + k2 * k2);
  const k3 = (limit + k1) / (limit + k2);
  const minus_b = k3 * x - k1;
  const minus_c = k2 * k3 * x;
  return 0.5 * (minus_b + Math.sqrt(minus_b * minus_b + 4 * minus_c));
}

function chromaCompressNorm(h: number, chroma_compress_scale: number): number {
  const hr = (h * Math.PI) / 180;
  const a = Math.cos(hr);
  const b = Math.sin(hr);
  const cos_hr2 = a * a - b * b;
  const sin_hr2 = 2 * a * b;
  const cos_hr3 = 4 * a * a * a - 3 * a;
  const sin_hr3 = 3 * b - 4 * b * b * b;
  const M =
    11.34072 * a +
    16.46899 * cos_hr2 +
    7.8838 * cos_hr3 +
    14.66441 * b +
    -6.37224 * sin_hr2 +
    9.19364 * sin_hr3 +
    77.12896;
  return M * chroma_compress_scale;
}

function chromaCompressFwd(JMh: V3, tonemapped_J: number, p: ODTParams): V3 {
  const J = JMh[0];
  const M = JMh[1];
  const h = JMh[2];
  let M_compr = M;
  if (M !== 0) {
    const nJ = tonemapped_J / p.limit_J_max;
    const snJ = Math.max(0, 1 - nJ);
    const Mnorm = chromaCompressNorm(h, p.chroma_compress_scale);
    const limit = (Math.pow(nJ, p.model_gamma_inv) * reachMFromTable(h, p.TABLE_reach_M)) / Mnorm;
    const toe_limit = limit - 0.001;
    const toe_snJ_sat = snJ * p.sat;
    const toe_sqrt_nJ_sat_thr = Math.sqrt(nJ * nJ + p.sat_thr);
    const toe_nJ_compr = nJ * p.compr;
    M_compr = M * Math.pow(tonemapped_J / J, p.model_gamma_inv);
    M_compr = M_compr / Mnorm;
    M_compr = limit - toe(limit - M_compr, toe_limit, toe_snJ_sat, toe_sqrt_nJ_sat_thr);
    M_compr = toe(M_compr, limit, toe_nJ_compr, snJ);
    M_compr = M_compr * Mnorm;
  }
  return [tonemapped_J, M_compr, h];
}

function tonemapAndCompressFwd(JMh: V3, p: ODTParams): V3 {
  const linear = jToY(JMh[0], p.input_params) / ref_luminance;
  const tonemapped_Y = tonescaleFwd(linear, p.ts);
  const J_ts = yToJ(tonemapped_Y, p.input_params);
  return chromaCompressFwd(JMh, J_ts, p);
}

function computeCompressionVectorSlope(intersect_J: number, focus_J: number, limit_J_max: number, slope_gain: number): number {
  const direction_scalar = intersect_J < focus_J ? intersect_J : limit_J_max - intersect_J;
  return (direction_scalar * (intersect_J - focus_J)) / (focus_J * slope_gain);
}

function solveJIntersect(J: number, M: number, focusJ: number, maxJ: number, slope_gain: number): number {
  const M_scaled = M / slope_gain;
  const a = M_scaled / focusJ;
  if (J < focusJ) {
    const b = 1 - M_scaled;
    const c = -J;
    const det = b * b - 4 * a * c;
    const root = Math.sqrt(det);
    return (-2 * c) / (b + root);
  }
  const b = -(1 + M_scaled + maxJ * a);
  const c = maxJ * M_scaled + J;
  const det = b * b - 4 * a * c;
  const root = Math.sqrt(det);
  return (-2 * c) / (b - root);
}

function sminScaled(a: number, b: number, scale_reference: number): number {
  const s_scaled = smooth_cusps * scale_reference;
  const h = Math.max(s_scaled - Math.abs(a - b), 0) / s_scaled;
  return Math.min(a, b) - h * h * h * s_scaled * (1 / 6);
}

function estimateLineAndBoundaryIntersectionM(
  J_axis_intersect: number,
  slope: number,
  inv_gamma: number,
  J_max: number,
  M_max: number,
  J_intersection_reference: number
): number {
  const normalised_J = J_axis_intersect / J_intersection_reference;
  const shifted_intersection = J_intersection_reference * Math.pow(normalised_J, inv_gamma);
  return (shifted_intersection * M_max) / (J_max - slope * M_max);
}

function findGamutBoundaryIntersection(
  JM_cusp: [number, number],
  J_max: number,
  gamma_top_inv: number,
  gamma_bottom_inv: number,
  J_intersect_source: number,
  slope: number,
  J_intersect_cusp: number
): number {
  const M_boundary_lower = estimateLineAndBoundaryIntersectionM(
    J_intersect_source,
    slope,
    gamma_bottom_inv,
    JM_cusp[0],
    JM_cusp[1],
    J_intersect_cusp
  );
  const f_J_intersect_cusp = J_max - J_intersect_cusp;
  const f_J_intersect_source = J_max - J_intersect_source;
  const f_JM_cusp_J = J_max - JM_cusp[0];
  const M_boundary_upper = estimateLineAndBoundaryIntersectionM(
    f_J_intersect_source,
    -slope,
    gamma_top_inv,
    f_JM_cusp_J,
    JM_cusp[1],
    f_J_intersect_cusp
  );
  return sminScaled(M_boundary_lower, M_boundary_upper, JM_cusp[1]);
}

function getFocusGain(J: number, analytical_threshold: number, limit_J_max: number, focus_dist: number): number {
  let gain = limit_J_max * focus_dist;
  if (J > analytical_threshold) {
    let gain_adjustment = Math.log10((limit_J_max - analytical_threshold) / Math.max(0.0001, limit_J_max - J));
    gain_adjustment = gain_adjustment * gain_adjustment + 1;
    gain = gain * gain_adjustment;
  }
  return gain;
}

function remapM(M: number, gamut_boundary_M: number, reach_boundary_M: number): number {
  const boundary_ratio = gamut_boundary_M / reach_boundary_M;
  const proportion = Math.max(boundary_ratio, compression_threshold);
  const threshold = proportion * gamut_boundary_M;
  if (M <= threshold || proportion >= 1) return M;
  const m_offset = M - threshold;
  const gamut_offset = gamut_boundary_M - threshold;
  const reach_offset = reach_boundary_M - threshold;
  const scale = reach_offset / (reach_offset / gamut_offset - 1);
  const nd = m_offset / scale;
  return threshold + reinhardRemap(scale, nd);
}

interface HueDependentGamutParams {
  JMcusp: [number, number];
  gamma_bottom_inv: number;
  gamma_top_inv: number;
  focus_J: number;
  analytical_threshold: number;
}

function compressGamut(JMh: V3, Jx: number, p: ODTParams, hdp: HueDependentGamutParams): V3 {
  const J = JMh[0];
  const M = JMh[1];
  const h = JMh[2];
  const slope_gain = getFocusGain(Jx, hdp.analytical_threshold, p.limit_J_max, p.focus_dist);
  const J_intersect_source = solveJIntersect(J, M, hdp.focus_J, p.limit_J_max, slope_gain);
  const gamut_slope = computeCompressionVectorSlope(J_intersect_source, hdp.focus_J, p.limit_J_max, slope_gain);
  const J_intersect_cusp = solveJIntersect(hdp.JMcusp[0], hdp.JMcusp[1], hdp.focus_J, p.limit_J_max, slope_gain);
  const gamut_boundary_M = findGamutBoundaryIntersection(
    hdp.JMcusp,
    p.limit_J_max,
    hdp.gamma_top_inv,
    hdp.gamma_bottom_inv,
    J_intersect_source,
    gamut_slope,
    J_intersect_cusp
  );
  if (gamut_boundary_M <= 0) return [J, 0, h];
  const reach_max_M = reachMFromTable(h, p.TABLE_reach_M);
  const reach_boundary_M = estimateLineAndBoundaryIntersectionM(
    J_intersect_source,
    gamut_slope,
    p.model_gamma_inv,
    p.limit_J_max,
    reach_max_M,
    p.limit_J_max
  );
  const remapped_M = remapM(M, gamut_boundary_M, reach_boundary_M);
  return [J_intersect_source + remapped_M * gamut_slope, remapped_M, h];
}

function cuspFromTable(h: number, table: number[][]): [number, number] {
  let low_i = 0;
  let high_i = baseIndex + tableSize;
  let i = huePositionInUniformTable(h, tableSize) + baseIndex;
  while (low_i + 1 < high_i) {
    if (h > table[i][2]) low_i = i;
    else high_i = i;
    i = Math.trunc((low_i + high_i) / 2);
  }
  const lo = table[high_i - 1];
  const hi = table[high_i];
  const t = (h - lo[2]) / (hi[2] - lo[2]);
  return [lerp(lo[0], hi[0], t), lerp(lo[1], hi[1], t)];
}

function lookupHueInterval(h: number, hue_table: Float64Array, range: [number, number]): number {
  let i = baseIndex + huePositionInUniformTable(h, totalTableSize);
  let i_lo = Math.max(baseIndex, i + range[0]);
  let i_hi = Math.min(baseIndex + tableSize, i + range[1]);
  while (i_lo + 1 < i_hi) {
    if (h > hue_table[i]) i_lo = i;
    else i_hi = i;
    i = Math.trunc((i_lo + i_hi) / 2);
  }
  return Math.max(1, i_hi);
}

function computeFocusJ(cusp_J: number, mid_J: number, limit_J_max: number): number {
  return lerp(cusp_J, mid_J, Math.min(1, cusp_mid_blend - cusp_J / limit_J_max));
}

function initHueDependentGamutParams(hue: number, p: ODTParams): HueDependentGamutParams {
  const i_hi = lookupHueInterval(hue, p.TABLE_hues, p.hue_linearity_search_range);
  const t = hue - p.TABLE_hues[i_hi - 1];
  const JMcusp = cuspFromTable(hue, p.TABLE_gamut_cusps);
  return {
    JMcusp,
    gamma_bottom_inv: p.lower_hull_gamma_inv,
    gamma_top_inv: lerp(p.TABLE_upper_hull_gamma[i_hi - 1], p.TABLE_upper_hull_gamma[i_hi], t),
    focus_J: computeFocusJ(JMcusp[0], p.mid_J, p.limit_J_max),
    analytical_threshold: lerp(JMcusp[0], p.limit_J_max, focus_gain_blend),
  };
}

function gamutCompressFwd(JMh: V3, p: ODTParams): V3 {
  const J = JMh[0];
  const M = JMh[1];
  const h = JMh[2];
  if (J <= 0) return [0, 0, h];
  if (M < 0 || J > p.limit_J_max) return [J, 0, h];
  const hdp = initHueDependentGamutParams(h, p);
  return compressGamut(JMh, J, p, hdp);
}

/* — table building — */

function anyBelowZero(rgb: V3): boolean {
  return rgb[0] < 0 || rgb[1] < 0 || rgb[2] < 0;
}

function generateUnitCubeCuspCorners(corner: number): V3 {
  return [
    (corner + 1) % cuspCornerCount < 3 ? 1 : 0,
    (corner + 5) % cuspCornerCount < 3 ? 1 : 0,
    (corner + 3) % cuspCornerCount < 3 ? 1 : 0,
  ];
}

function buildLimitingCuspCornersTables(
  params: JMhParams,
  peakLuminance: number
): { RGB_corners: V3[]; JMh_corners: V3[] } {
  const temp_RGB: V3[] = [];
  const temp_JMh: V3[] = [];
  let min_index = 0;
  for (let i = 0; i < cuspCornerCount; i++) {
    const c = generateUnitCubeCuspCorners(i);
    const k = peakLuminance / ref_luminance;
    temp_RGB[i] = [c[0] * k, c[1] * k, c[2] * k];
    temp_JMh[i] = rgbToJMh(temp_RGB[i], params);
    if (temp_JMh[i][2] < temp_JMh[min_index][2]) min_index = i;
  }
  const RGB_corners: V3[] = new Array(totalCornerCount);
  const JMh_corners: V3[] = new Array(totalCornerCount);
  for (let i = 0; i < cuspCornerCount; i++) {
    RGB_corners[i + 1] = temp_RGB[(i + min_index) % cuspCornerCount];
    JMh_corners[i + 1] = [...temp_JMh[(i + min_index) % cuspCornerCount]] as V3;
  }
  RGB_corners[0] = RGB_corners[cuspCornerCount];
  RGB_corners[cuspCornerCount + 1] = RGB_corners[1];
  JMh_corners[0] = [...JMh_corners[cuspCornerCount]] as V3;
  JMh_corners[cuspCornerCount + 1] = [...JMh_corners[1]] as V3;
  JMh_corners[0][2] -= hue_limit;
  JMh_corners[cuspCornerCount + 1][2] += hue_limit;
  return { RGB_corners, JMh_corners };
}

function findReachCornersTable(params_reach: JMhParams, limit_J_max: number, forward_limit: number): V3[] {
  const temp_JMh: V3[] = [];
  const limitA = jToAchromatic(limit_J_max, params_reach.inv_cz);
  let min_index = 0;
  for (let i = 0; i < cuspCornerCount; i++) {
    const rgb_vector = generateUnitCubeCuspCorners(i);
    let lower = 0;
    let upper = forward_limit;
    while (upper - lower > reach_cusp_tolerance) {
      const test = (lower + upper) / 2;
      const A = rgbToAab([test * rgb_vector[0], test * rgb_vector[1], test * rgb_vector[2]], params_reach)[0];
      if (A < limitA) lower = test;
      else upper = test;
    }
    temp_JMh[i] = rgbToJMh([upper * rgb_vector[0], upper * rgb_vector[1], upper * rgb_vector[2]], params_reach);
    if (temp_JMh[i][2] < temp_JMh[min_index][2]) min_index = i;
  }
  const JMh_corners: V3[] = new Array(totalCornerCount);
  for (let i = 0; i < cuspCornerCount; i++) {
    JMh_corners[i + 1] = [...temp_JMh[(i + min_index) % cuspCornerCount]] as V3;
  }
  JMh_corners[0] = [...JMh_corners[cuspCornerCount]] as V3;
  JMh_corners[cuspCornerCount + 1] = [...JMh_corners[1]] as V3;
  JMh_corners[0][2] -= hue_limit;
  JMh_corners[cuspCornerCount + 1][2] += hue_limit;
  return JMh_corners;
}

function extractSortedCubeHues(reach_JMh: V3[], limit_JMh: V3[]): number[] {
  const sorted_hues = new Array<number>(max_sorted_corners).fill(0);
  let idx = 0;
  let reach_idx = 1;
  let limit_idx = 1;
  while (reach_idx < cuspCornerCount + 1 || limit_idx < cuspCornerCount + 1) {
    const reach_hue = reach_JMh[reach_idx][2];
    const limit_hue = limit_JMh[limit_idx][2];
    if (reach_hue === limit_hue) {
      sorted_hues[idx] = reach_hue;
      reach_idx++;
      limit_idx++;
    } else if (reach_hue < limit_hue) {
      sorted_hues[idx] = reach_hue;
      reach_idx++;
    } else {
      sorted_hues[idx] = limit_hue;
      limit_idx++;
    }
    idx++;
  }
  return sorted_hues;
}

function buildHueSampleInterval(samples: number, lower: number, upper: number, hue_table: Float64Array, base: number): void {
  const delta = (upper - lower) / samples;
  for (let i = 0; i < samples; i++) hue_table[base + i] = lower + i * delta;
}

function buildHueTable(sorted_hues: number[]): Float64Array {
  const hue_table = new Float64Array(totalTableSize);
  const ideal_spacing = tableSize / hue_limit;
  const samples_count = new Array<number>(2 * cuspCornerCount + 2).fill(0);
  let last_idx = 0;
  let min_index = sorted_hues[0] === 0 ? 0 : 1;
  for (let hue_idx = 0; hue_idx < max_sorted_corners; hue_idx++) {
    let nominal_idx = Math.min(Math.max(ctlRound(sorted_hues[hue_idx] * ideal_spacing), min_index), tableSize - 1);
    if (last_idx === nominal_idx) {
      if (hue_idx > 1 && samples_count[hue_idx - 2] !== samples_count[hue_idx - 1] - 1) {
        samples_count[hue_idx - 1] = samples_count[hue_idx - 1] - 1;
      } else {
        nominal_idx = nominal_idx + 1;
      }
    }
    samples_count[hue_idx] = Math.min(nominal_idx, tableSize - 1);
    min_index = nominal_idx;
    last_idx = min_index;
  }
  let total_samples = 0;
  let i = 0;
  buildHueSampleInterval(samples_count[i], 0, sorted_hues[i], hue_table, total_samples + 1);
  total_samples += samples_count[i];
  for (i = i + 1; i < max_sorted_corners; i++) {
    const samples = samples_count[i] - samples_count[i - 1];
    buildHueSampleInterval(samples, sorted_hues[i - 1], sorted_hues[i], hue_table, total_samples + 1);
    total_samples += samples;
  }
  buildHueSampleInterval(tableSize - total_samples, sorted_hues[i - 1], hue_limit, hue_table, total_samples + 1);
  hue_table[0] = hue_table[baseIndex + tableSize - 1] - hue_limit;
  hue_table[baseIndex + tableSize] = hue_table[baseIndex] + hue_limit;
  return hue_table;
}

function findDisplayCuspForHue(hue: number, RGB_corners: V3[], JMh_corners: V3[], params: JMhParams): [number, number] {
  let upper_corner = 1;
  let found = false;
  for (let i = upper_corner; i !== totalCornerCount && !found; i++) {
    if (JMh_corners[i][2] > hue) {
      upper_corner = i;
      found = true;
    }
  }
  const lower_corner = upper_corner - 1;
  if (JMh_corners[lower_corner][2] === hue) {
    return [JMh_corners[lower_corner][0], JMh_corners[lower_corner][1]];
  }
  const cusp_lower = RGB_corners[lower_corner];
  const cusp_upper = RGB_corners[upper_corner];
  let lower_t = 0;
  let upper_t = 1;
  let sample_t: number;
  let JMh: V3;
  const lerp3 = (t: number): V3 => [
    lerp(cusp_lower[0], cusp_upper[0], t),
    lerp(cusp_lower[1], cusp_upper[1], t),
    lerp(cusp_lower[2], cusp_upper[2], t),
  ];
  while (upper_t - lower_t > display_cusp_tolerance) {
    sample_t = (lower_t + upper_t) / 2;
    JMh = rgbToJMh(lerp3(sample_t), params);
    if (JMh[2] < JMh_corners[lower_corner][2]) upper_t = sample_t;
    else if (JMh[2] >= JMh_corners[upper_corner][2]) lower_t = sample_t;
    else if (JMh[2] > hue) upper_t = sample_t;
    else lower_t = sample_t;
  }
  sample_t = (lower_t + upper_t) / 2;
  JMh = rgbToJMh(lerp3(sample_t), params);
  return [JMh[0], JMh[1]];
}

function buildCuspTable(hue_table: Float64Array, RGB_corners: V3[], JMh_corners: V3[], params: JMhParams): number[][] {
  const output_table: number[][] = new Array(totalTableSize);
  for (let i = baseIndex; i !== totalTableSize; i++) {
    const hue = hue_table[i];
    const JM = findDisplayCuspForHue(hue, RGB_corners, JMh_corners, params);
    output_table[i] = [JM[0], JM[1] * (1 + smooth_m * smooth_cusps), hue];
  }
  output_table[0] = [output_table[tableSize][0], output_table[tableSize][1], hue_table[0]];
  output_table[baseIndex + tableSize] = [
    output_table[baseIndex][0],
    output_table[baseIndex][1],
    hue_table[baseIndex + tableSize],
  ];
  return output_table;
}

function makeUniformHueGamutTable(
  reach_params: JMhParams,
  limit_params: JMhParams,
  peakLuminance: number,
  limit_J_max: number,
  forward_limit: number
): number[][] {
  const reach_JMh_corners = findReachCornersTable(reach_params, limit_J_max, forward_limit);
  const { RGB_corners, JMh_corners } = buildLimitingCuspCornersTables(limit_params, peakLuminance);
  const sorted_hues = extractSortedCubeHues(reach_JMh_corners, JMh_corners);
  const hue_table = buildHueTable(sorted_hues);
  return buildCuspTable(hue_table, RGB_corners, JMh_corners, limit_params);
}

function makeReachMTable(params: JMhParams, limitJmax: number): Float64Array {
  const reachTable = new Float64Array(totalTableSize);
  for (let i = 0; i < tableSize; i++) {
    const hue = baseHueForPosition(i, tableSize);
    const search_range = 50;
    const search_maximum = 1300;
    let low = 0;
    let high = low + search_range;
    let outside = false;
    while (!outside && high < search_maximum) {
      const newLimitRGB = jmhToRgb([limitJmax, high, hue], params);
      outside = anyBelowZero(newLimitRGB);
      if (!outside) {
        low = high;
        high = high + search_range;
      }
    }
    while (high - low > 1e-2) {
      const sampleM = (high + low) / 2;
      const newLimitRGB = jmhToRgb([limitJmax, sampleM, hue], params);
      outside = anyBelowZero(newLimitRGB);
      if (outside) high = sampleM;
      else low = sampleM;
    }
    reachTable[i + baseIndex] = high;
  }
  reachTable[0] = reachTable[tableSize];
  reachTable[baseIndex + tableSize] = reachTable[baseIndex];
  return reachTable;
}

function outsideHull(rgb: V3, maxRGBtestVal: number): boolean {
  return rgb[0] > maxRGBtestVal || rgb[1] > maxRGBtestVal || rgb[2] > maxRGBtestVal;
}

const test_count = 5;
const testPositions = [0.01, 0.1, 0.5, 0.8, 0.99];

interface GammaTestData {
  test_JMh: V3[];
  J_intersect_source: number[];
  slopes: number[];
  J_intersect_cusp: number[];
}

function generateGammaTestData(
  JMcusp: [number, number],
  hue: number,
  limit_J_max: number,
  mid_J: number,
  focus_dist: number
): GammaTestData {
  const analytical_threshold = lerp(JMcusp[0], limit_J_max, focus_gain_blend);
  const focus_J = computeFocusJ(JMcusp[0], mid_J, limit_J_max);
  const out: GammaTestData = { test_JMh: [], J_intersect_source: [], slopes: [], J_intersect_cusp: [] };
  for (let testIndex = 0; testIndex < test_count; testIndex++) {
    const test_J = lerp(JMcusp[0], limit_J_max, testPositions[testIndex]);
    const slope_gain = getFocusGain(test_J, analytical_threshold, limit_J_max, focus_dist);
    const J_intersect = solveJIntersect(test_J, JMcusp[1], focus_J, limit_J_max, slope_gain);
    const slope = computeCompressionVectorSlope(J_intersect, focus_J, limit_J_max, slope_gain);
    const J_cusp = solveJIntersect(JMcusp[0], JMcusp[1], focus_J, limit_J_max, slope_gain);
    out.test_JMh[testIndex] = [test_J, JMcusp[1], hue];
    out.J_intersect_source[testIndex] = J_intersect;
    out.slopes[testIndex] = slope;
    out.J_intersect_cusp[testIndex] = J_cusp;
  }
  return out;
}

function evaluateGammaFit(
  JMcusp: [number, number],
  d: GammaTestData,
  top_gamma_inv: number,
  peakLuminance: number,
  limit_J_max: number,
  lower_hull_gamma_inv: number,
  limit_params: JMhParams
): boolean {
  const luminance_limit = peakLuminance / ref_luminance;
  for (let testIndex = 0; testIndex < test_count; testIndex++) {
    const approxLimit_M = findGamutBoundaryIntersection(
      JMcusp,
      limit_J_max,
      top_gamma_inv,
      lower_hull_gamma_inv,
      d.J_intersect_source[testIndex],
      d.slopes[testIndex],
      d.J_intersect_cusp[testIndex]
    );
    const approxLimit_J = d.J_intersect_source[testIndex] + d.slopes[testIndex] * approxLimit_M;
    const newLimitRGB = jmhToRgb([approxLimit_J, approxLimit_M, d.test_JMh[testIndex][2]], limit_params);
    if (!outsideHull(newLimitRGB, luminance_limit)) return false;
  }
  return true;
}

function makeUpperHullGammaTable(gamutCuspTable: number[][], p: ODTParams): Float64Array {
  const upper_hull_gamma = new Float64Array(totalTableSize);
  for (let i = baseIndex; i !== baseIndex + tableSize; i++) {
    const hue = gamutCuspTable[i][2];
    const JMcusp: [number, number] = [gamutCuspTable[i][0], gamutCuspTable[i][1]];
    const d = generateGammaTestData(JMcusp, hue, p.limit_J_max, p.mid_J, p.focus_dist);
    const search_range = gamma_search_step;
    let low = gamma_minimum;
    let high = low + search_range;
    let outside = false;
    while (!outside && high < gamma_maximum) {
      const gammaFound = evaluateGammaFit(
        JMcusp,
        d,
        1 / high,
        p.peakLuminance,
        p.limit_J_max,
        p.lower_hull_gamma_inv,
        p.limit_params
      );
      if (!gammaFound) {
        low = high;
        high = high + search_range;
      } else {
        outside = true;
      }
    }
    while (high - low > gamma_accuracy) {
      const testGamma = (high + low) / 2;
      const gammaFound = evaluateGammaFit(
        JMcusp,
        d,
        1 / testGamma,
        p.peakLuminance,
        p.limit_J_max,
        p.lower_hull_gamma_inv,
        p.limit_params
      );
      if (gammaFound) high = testGamma;
      else low = testGamma;
    }
    upper_hull_gamma[i] = 1 / high;
  }
  upper_hull_gamma[0] = upper_hull_gamma[tableSize];
  upper_hull_gamma[tableSize + baseIndex] = upper_hull_gamma[baseIndex];
  return upper_hull_gamma;
}

function determineHueLinearitySearchRange(hue_table: Float64Array): [number, number] {
  const lower_padding = 0;
  const upper_padding = 1;
  const range: [number, number] = [lower_padding, upper_padding];
  for (let i = baseIndex; i !== baseIndex + tableSize; i++) {
    const pos = huePositionInUniformTable(hue_table[i], totalTableSize);
    const delta = i - pos;
    range[0] = Math.min(range[0], delta + lower_padding);
    range[1] = Math.max(range[1], delta + upper_padding);
  }
  return range;
}

function initODTParams(peakLuminance: number, limitingPrimaries: Primaries): ODTParams {
  const input_params = initJMhParams(AP0_PRIMARIES);
  const reach_params = initJMhParams(REACH_PRI);
  const limit_params = initJMhParams(limitingPrimaries);
  const ts = initTSParams(peakLuminance);
  const limit_J_max = yToJ(peakLuminance, input_params);
  const model_gamma_inv = 1 / model_gamma;
  const TABLE_reach_M = makeReachMTable(reach_params, limit_J_max);
  const sat = Math.max(0.2, chroma_expand - chroma_expand * chroma_expand_fact * ts.log_peak);
  const sat_thr = chroma_expand_thr / peakLuminance;
  const compr = chroma_compress + chroma_compress * chroma_compress_fact * ts.log_peak;
  const chroma_compress_scale = Math.pow(0.03379 * peakLuminance, 0.30596) - 0.45135;
  const mid_J = yToJ(ts.c_t * ref_luminance, input_params);
  const focus_dist = focus_distance + focus_distance * focus_distance_scaling * ts.log_peak;
  const lower_hull_gamma = 1.14 + 0.07 * ts.log_peak;
  const lower_hull_gamma_inv = 1 / lower_hull_gamma;
  const TABLE_gamut_cusps = makeUniformHueGamutTable(reach_params, limit_params, peakLuminance, limit_J_max, ts.forward_limit);
  const TABLE_hues = new Float64Array(totalTableSize);
  for (let i = 0; i < totalTableSize; i++) TABLE_hues[i] = TABLE_gamut_cusps[i][2];
  const p: ODTParams = {
    peakLuminance,
    input_params,
    reach_params,
    limit_params,
    ts,
    limit_J_max,
    model_gamma_inv,
    TABLE_reach_M,
    sat,
    sat_thr,
    compr,
    chroma_compress_scale,
    mid_J,
    focus_dist,
    lower_hull_gamma_inv,
    TABLE_hues,
    TABLE_gamut_cusps,
    TABLE_upper_hull_gamma: new Float64Array(0),
    hue_linearity_search_range: [0, 1],
  };
  p.TABLE_upper_hull_gamma = makeUpperHullGammaTable(TABLE_gamut_cusps, p);
  p.hue_linearity_search_range = determineHueLinearitySearchRange(TABLE_hues);
  return p;
}

/* ------------------------------------------------------------------ */
/* Display encoding (Lib.Academy.DisplayEncoding)                      */
/* ------------------------------------------------------------------ */

export type AcesEotf = "bt1886" | "pq" | "hlg";

const pq_m1 = 0.1593017578125;
const pq_m2 = 78.84375;
const pq_c1 = 0.8359375;
const pq_c2 = 18.8515625;
const pq_c3 = 18.6875;
const pq_C = 10000;

function yToST2084(C: number): number {
  const L = C / pq_C;
  const Lm = Math.pow(L, pq_m1);
  const N = (pq_c1 + pq_c2 * Lm) / (1 + pq_c3 * Lm);
  return Math.pow(N, pq_m2);
}

function st2084ToY(N: number): number {
  const Np = Math.pow(N, 1 / pq_m2);
  let L = Np - pq_c1;
  if (L < 0) L = 0;
  L = L / (pq_c2 - pq_c3 * Np);
  L = Math.pow(L, 1 / pq_m1);
  return L * pq_C;
}

/** PQ signal → HLG signal for a 1000-nit display (BT.2390 section 7). */
function st2084ToHlg1000(PQ: V3): V3 {
  const displayLinear: V3 = [st2084ToY(PQ[0]), st2084ToY(PQ[1]), st2084ToY(PQ[2])];
  const Y_d = 0.2627 * displayLinear[0] + 0.678 * displayLinear[1] + 0.0593 * displayLinear[2];
  const L_w = 1000;
  const L_b = 0;
  const alpha = L_w - L_b;
  const beta = L_b;
  const gamma = 1.2;
  const sceneLinear: V3 = [0, 0, 0];
  if (Y_d !== 0) {
    const k = Math.pow((Y_d - beta) / alpha, (1 - gamma) / gamma);
    for (let i = 0; i < 3; i++) sceneLinear[i] = k * ((displayLinear[i] - beta) / alpha);
  }
  const a = 0.17883277;
  const b = 0.28466892;
  const c = 0.55991073;
  const out: V3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const e = sceneLinear[i];
    out[i] = e <= 1 / 12 ? Math.sqrt(3 * e) : a * Math.log(12 * e - b) + c;
  }
  return out;
}

function bt1886Inv(L: number, gamma: number, Lw = 1, Lb = 0): number {
  const a = Math.pow(Math.pow(Lw, 1 / gamma) - Math.pow(Lb, 1 / gamma), gamma);
  const b = Math.pow(Lb, 1 / gamma) / (Math.pow(Lw, 1 / gamma) - Math.pow(Lb, 1 / gamma));
  return Math.pow(Math.max(L / a, 0), 1 / gamma) - b;
}

function eotfInv(rgb_linear_in: V3, eotf: AcesEotf): V3 {
  const rgb: V3 = [Math.max(0, rgb_linear_in[0]), Math.max(0, rgb_linear_in[1]), Math.max(0, rgb_linear_in[2])];
  if (eotf === "pq") {
    return [yToST2084(ref_luminance * rgb[0]), yToST2084(ref_luminance * rgb[1]), yToST2084(ref_luminance * rgb[2])];
  }
  if (eotf === "hlg") {
    const PQ: V3 = [yToST2084(ref_luminance * rgb[0]), yToST2084(ref_luminance * rgb[1]), yToST2084(ref_luminance * rgb[2])];
    return st2084ToHlg1000(PQ);
  }
  return [bt1886Inv(rgb[0], 2.4), bt1886Inv(rgb[1], 2.4), bt1886Inv(rgb[2], 2.4)];
}

/* ------------------------------------------------------------------ */
/* Presets and the public transform                                    */
/* ------------------------------------------------------------------ */

export type AcesOutputPresetId = "rec709-100" | "rec2100-hlg-1000" | "rec2100-pq-1000";

export interface AcesOutputPreset {
  id: AcesOutputPresetId;
  /** The reference file this preset restates. */
  transformId: string;
  limiting: Primaries;
  encoding: Primaries;
  peakLuminance: number;
  eotf: AcesEotf;
}

export const ACES_OUTPUT_PRESETS: Record<AcesOutputPresetId, AcesOutputPreset> = {
  "rec709-100": {
    id: "rec709-100",
    transformId: "Output.Academy.Rec709-D65_100nit_in_Rec709-D65_BT1886",
    limiting: REC709_PRIMARIES,
    encoding: REC709_PRIMARIES,
    peakLuminance: 100,
    eotf: "bt1886",
  },
  "rec2100-hlg-1000": {
    id: "rec2100-hlg-1000",
    transformId: "Output.Academy.P3-D65_1000nit_in_Rec2100-D65_HLG",
    limiting: P3D65_PRIMARIES,
    encoding: REC2020_PRIMARIES,
    peakLuminance: 1000,
    eotf: "hlg",
  },
  "rec2100-pq-1000": {
    id: "rec2100-pq-1000",
    transformId: "Output.Academy.Rec2100-D65_1000nit_in_Rec2100-D65_ST2084",
    limiting: REC2020_PRIMARIES,
    encoding: REC2020_PRIMARIES,
    peakLuminance: 1000,
    eotf: "pq",
  },
};

export interface AcesOutputTransform {
  preset: AcesOutputPreset;
  /** Scene-linear AP0 → display-linear RGB in the limiting primaries, before
   * the peak clamp and display encoding (the value OpenColorIO's fixed
   * function reports). */
  forwardLinear(r: number, g: number, b: number): V3;
  /** Scene-linear AP0 → display code values in the encoding primaries. */
  forward(r: number, g: number, b: number): V3;
}

function buildTransform(preset: AcesOutputPreset): AcesOutputTransform {
  const p = initODTParams(preset.peakLuminance, preset.limiting);
  const limitToDisplay = multF33F33(rgbToXyzF33(preset.limiting, 1), xyzToRgbF33(preset.encoding, 1));
  const peak = preset.peakLuminance / ref_luminance;
  const forwardLinear = (r: number, g: number, b: number): V3 => {
    const ap1 = multF3F33([r, g, b], AP0_TO_AP1);
    const lim = p.ts.forward_limit;
    for (let i = 0; i < 3; i++) ap1[i] = ap1[i] < 0 ? 0 : ap1[i] > lim ? lim : ap1[i];
    const aces = multF3F33(ap1, AP1_TO_AP0);
    const JMh = rgbToJMh(aces, p.input_params);
    const tonemapped = tonemapAndCompressFwd(JMh, p);
    const compressed = gamutCompressFwd(tonemapped, p);
    return jmhToRgb(compressed, p.limit_params);
  };
  const forward = (r: number, g: number, b: number): V3 => {
    const rgb = forwardLinear(r, g, b);
    for (let i = 0; i < 3; i++) rgb[i] = rgb[i] < 0 ? 0 : rgb[i] > peak ? peak : rgb[i];
    const display = multF3F33(rgb, limitToDisplay);
    return eotfInv(display, preset.eotf);
  };
  return { preset, forwardLinear, forward };
}

const transforms = new Map<AcesOutputPresetId, AcesOutputTransform>();

/** The transform for a preset, built on first use (the tables take a few
 * dozen milliseconds) and kept for the life of the module. */
export function acesOutputTransform(id: AcesOutputPresetId): AcesOutputTransform {
  let t = transforms.get(id);
  if (!t) {
    t = buildTransform(ACES_OUTPUT_PRESETS[id]);
    transforms.set(id, t);
  }
  return t;
}

/** An ad-hoc transform for the given limiting primaries and peak, exposed for
 * verification against published vectors. Display encoding is skipped. */
export function acesOutputTransformFor(peakLuminance: number, limiting: Primaries): AcesOutputTransform {
  return buildTransform({
    id: "rec709-100",
    transformId: "custom",
    limiting,
    encoding: limiting,
    peakLuminance,
    eotf: "bt1886",
  });
}
