import { describe, expect, test } from "bun:test";
import {
  APPLE_WIDE_GAMUT_PRIMARIES,
  BRADFORD,
  BT2408_HLG_WHITE,
  BT2408_REFERENCE_WHITE_NITS,
  CAT02,
  D65,
  D65_KELVIN,
  HLG_SCENE_WHITE,
  MAT3_IDENTITY,
  REC2020_PRIMARIES,
  REC709_PRIMARIES,
  appleLogDecode,
  appleLogEncode,
  bt1886Decode,
  bt1886Encode,
  chromaticAdaptation,
  hlgOetf,
  hlgOetfInverse,
  hlgOotf,
  hlgOotfInverse,
  illuminantXy,
  lchToOklab,
  linearToOklab,
  mat3Apply,
  mat3Inv,
  mat3Mul,
  oklabMatrices,
  oklabToLch,
  oklabToLinear,
  planckianXy,
  pqDecode,
  pqEncode,
  rgbToRgbMatrix,
  rgbToXyzMatrix,
  sdrToHlg,
  sdrToPq,
  uvToXy,
  whiteBalanceMatrix,
  xyToUv,
  xyzToRgbMatrix,
} from "./colorSpace";

const near = (a: number[], b: number[], eps: number) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps);
};

describe("matrices", () => {
  test("inverse and product agree with identity", () => {
    const m = rgbToXyzMatrix(REC709_PRIMARIES);
    near(mat3Mul(m, mat3Inv(m)), MAT3_IDENTITY, 1e-12);
    near(mat3Mul(xyzToRgbMatrix(REC709_PRIMARIES), m), MAT3_IDENTITY, 1e-12);
  });

  test("the luminance row of a primaries matrix is its channel weights", () => {
    const m = rgbToXyzMatrix(REC709_PRIMARIES);
    near([m[3], m[4], m[5]], [0.2126, 0.7152, 0.0722], 1e-4);
    const m2020 = rgbToXyzMatrix(REC2020_PRIMARIES);
    near([m2020[3], m2020[4], m2020[5]], [0.2627, 0.678, 0.0593], 1e-4);
  });

  test("white maps to the white point of its primaries", () => {
    for (const p of [REC709_PRIMARIES, REC2020_PRIMARIES, APPLE_WIDE_GAMUT_PRIMARIES]) {
      const [X, Y, Z] = mat3Apply(rgbToXyzMatrix(p), 1, 1, 1);
      const sum = X + Y + Z;
      near([X / sum, Y / sum], D65, 1e-6);
      expect(Math.abs(Y - 1)).toBeLessThan(1e-9);
    }
  });

  test("Rec.709 to Rec.2020 is the BT.2087 matrix", () => {
    const m = rgbToRgbMatrix(REC709_PRIMARIES, REC2020_PRIMARIES);
    near(m, [0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.088, 0.8956], 5e-4);
  });

  test("chromatic adaptation to the same white is identity, and D65 to D50 is the Bradford matrix", () => {
    near(chromaticAdaptation(D65, D65), MAT3_IDENTITY, 1e-12);
    near(chromaticAdaptation(D65, D65, CAT02), MAT3_IDENTITY, 1e-12);
    const m = chromaticAdaptation(D65, [0.3457, 0.3585], BRADFORD);
    // Lindbloom's D65 → D50 Bradford matrix.
    near(m, [1.0478, 0.0229, -0.0501, 0.0295, 0.9905, -0.0171, -0.0092, 0.0151, 0.7517], 2e-3);
  });
});

describe("Apple Log", () => {
  test("18% grey encodes near 48.8% and the curve is continuous at its joins", () => {
    expect(Math.abs(appleLogEncode(0.18) - 0.4883)).toBeLessThan(1e-3);
    const Rt = 0.01;
    const Pt = appleLogEncode(Rt);
    expect(Math.abs(appleLogEncode(Rt - 1e-9) - appleLogEncode(Rt + 1e-9))).toBeLessThan(1e-6);
    expect(Math.abs(appleLogDecode(Pt - 1e-9) - appleLogDecode(Pt + 1e-9))).toBeLessThan(1e-6);
  });

  test("decode inverts encode across the range, including below black", () => {
    for (const r of [-0.05, -0.01, 0, 0.005, 0.01, 0.05, 0.18, 1, 4, 16]) {
      expect(Math.abs(appleLogDecode(appleLogEncode(r)) - r)).toBeLessThan(1e-9 + Math.abs(r) * 1e-9);
    }
    expect(appleLogDecode(0)).toBeLessThan(0);
  });
});

describe("display curves", () => {
  test("BT.1886 round trips and pins its ends", () => {
    expect(bt1886Decode(0)).toBe(0);
    expect(bt1886Decode(1)).toBeCloseTo(1, 12);
    for (const v of [0.05, 0.2, 0.5, 0.9]) expect(Math.abs(bt1886Encode(bt1886Decode(v)) - v)).toBeLessThan(1e-9);
  });

  test("HLG OETF pins 1/12 → 0.5, 1 → 1, and inverts", () => {
    expect(hlgOetf(1 / 12)).toBeCloseTo(0.5, 9);
    expect(hlgOetf(1)).toBeCloseTo(1, 6);
    for (const s of [0.1, 0.5, 0.75, 0.9]) expect(Math.abs(hlgOetf(hlgOetfInverse(s)) - s)).toBeLessThan(1e-9);
  });

  test("HLG OOTF puts scene white at the peak and inverts", () => {
    const [r] = hlgOotf(1, 1, 1, 1000);
    expect(r).toBeCloseTo(1000, 6);
    const back = hlgOotfInverse(...hlgOotf(0.2, 0.4, 0.1, 1000), 1000);
    near(back, [0.2, 0.4, 0.1], 1e-9);
  });

  test("PQ pins 10000 nits at 1.0, 100 nits near 0.508, and inverts", () => {
    expect(pqEncode(10000)).toBeCloseTo(1, 9);
    expect(Math.abs(pqEncode(100) - 0.5081)).toBeLessThan(1e-3);
    for (const n of [0.5, 10, 203, 1000]) expect(Math.abs(pqDecode(pqEncode(n)) - n)).toBeLessThan(1e-6 * n);
  });
});

describe("BT.2408 SDR in HDR", () => {
  test("Rec.709 white lands at 75% HLG and 203 nits PQ", () => {
    expect(BT2408_REFERENCE_WHITE_NITS).toBe(203);
    near(sdrToHlg(1, 1, 1), [BT2408_HLG_WHITE, BT2408_HLG_WHITE, BT2408_HLG_WHITE], 2e-4);
    near(sdrToPq(1, 1, 1), [pqEncode(203), pqEncode(203), pqEncode(203)], 1e-9);
    expect(HLG_SCENE_WHITE).toBeCloseTo(hlgOetfInverse(0.75), 12);
  });

  test("a neutral stays neutral through the container change", () => {
    const [r, g, b] = sdrToHlg(0.18, 0.18, 0.18);
    expect(Math.abs(r - g)).toBeLessThan(1e-6);
    expect(Math.abs(g - b)).toBeLessThan(1e-6);
  });
});

describe("illuminants", () => {
  test("the Planckian locus passes near D65 at 6504 K and warms toward 3200 K", () => {
    near(planckianXy(D65_KELVIN), D65, 6e-3);
    const warm = planckianXy(3200);
    expect(warm[0]).toBeGreaterThan(D65[0]);
    expect(warm[1]).toBeGreaterThan(D65[1]);
  });

  test("uv and xy convert both ways", () => {
    const [u, v] = xyToUv(...D65);
    near(uvToXy(u, v), D65, 1e-12);
  });

  test("a mired shift walks warm, a Δuv walks green", () => {
    const warmer = illuminantXy(50, 0);
    const cooler = illuminantXy(-50, 0);
    expect(warmer[0]).toBeGreaterThan(D65[0]);
    expect(cooler[0]).toBeLessThan(D65[0]);
    near(illuminantXy(0, 0), D65, 1e-9);
    const green = illuminantXy(0, 0.02);
    // Above the locus (positive Δuv) is toward green: higher y for its x.
    expect(green[1]).toBeGreaterThan(D65[1]);
  });

  test("white balance neutralizes the assumed illuminant", () => {
    const assumed = planckianXy(4000);
    const m = whiteBalanceMatrix(REC709_PRIMARIES, assumed);
    // A surface lit by 4000 K reads warm in Rec.709; the matrix returns it to grey.
    const lit = mat3Apply(xyzToRgbMatrix(REC709_PRIMARIES), assumed[0] / assumed[1], 1, (1 - assumed[0] - assumed[1]) / assumed[1]);
    expect(lit[0]).toBeGreaterThan(lit[2]);
    const out = mat3Apply(m, lit[0], lit[1], lit[2]);
    expect(Math.abs(out[0] - out[1])).toBeLessThan(2e-2);
    expect(Math.abs(out[1] - out[2])).toBeLessThan(2e-2);
    near(whiteBalanceMatrix(REC709_PRIMARIES, D65), MAT3_IDENTITY, 1e-9);
  });
});

describe("Oklab", () => {
  test("white is L=1 with no chroma and colors round trip", () => {
    const { toLms, fromLms } = oklabMatrices(REC709_PRIMARIES);
    const white = linearToOklab(toLms, 1, 1, 1);
    expect(Math.abs(white[0] - 1)).toBeLessThan(1e-4);
    expect(Math.abs(white[1])).toBeLessThan(1e-3);
    expect(Math.abs(white[2])).toBeLessThan(1e-3);
    for (const c of [[0.2, 0.5, 0.8], [1, 0, 0], [0.05, 0.05, 0.05]] as const) {
      const lab = linearToOklab(toLms, c[0], c[1], c[2]);
      near(oklabToLinear(fromLms, lab[0], lab[1], lab[2]), [...c], 1e-9);
      const lch = oklabToLch(lab[0], lab[1], lab[2]);
      near(lchToOklab(lch[0], lch[1], lch[2]), lab, 1e-12);
    }
  });

  test("Rec.709 red matches the published Oklab coordinates", () => {
    const { toLms } = oklabMatrices(REC709_PRIMARIES);
    near(linearToOklab(toLms, 1, 0, 0), [0.628, 0.2249, 0.1258], 1e-3);
  });
});
