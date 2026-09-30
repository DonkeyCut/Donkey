import { describe, expect, test } from "bun:test";
import { ACES_OUTPUT_PRESETS, acesOutputTransform, acesOutputTransformFor } from "./acesOutput";
import { P3D65_PRIMARIES, hlgOetfInverse, hlgOotf, pqDecode } from "./colorSpace";

/**
 * The port is held against OpenColorIO's fixed-function test vectors for the
 * ACES 2.0 output transform (P3-D65 limiting, 1000 nits): six extreme
 * primaries, three arbitrary colors, the ColorChecker patches, 18% grey and
 * the tonescale's white. Values are scene-linear AP0 in, display-linear
 * P3-D65 out, before the peak clamp.
 */
const OCIO_IN: [number, number, number][] = [
  [2.781808965, 0.179178253, -0.02210353],
  [3.344523751, 3.617862727, -0.006002689],
  [0.562714786, 3.438684474, 0.016100841],
  [1.218191035, 3.820821747, 4.02210353],
  [0.655476249, 0.382137273, 4.006002689],
  [3.437285214, 0.561315526, 3.983899159],
  [0.11, 0.02, 0.04],
  [0.71, 0.51, 0.81],
  [0.43, 0.82, 0.71],
  [0.11877, 0.08709, 0.05895],
  [0.40002, 0.31916, 0.23736],
  [0.18476, 0.20398, 0.31311],
  [0.10901, 0.13511, 0.06493],
  [0.26684, 0.24604, 0.40932],
  [0.32283, 0.46208, 0.40606],
  [0.38605, 0.22743, 0.05777],
  [0.13822, 0.13037, 0.33703],
  [0.30202, 0.13752, 0.12758],
  [0.0931, 0.06347, 0.13525],
  [0.34876, 0.43654, 0.10613],
  [0.48655, 0.36685, 0.08061],
  [0.08732, 0.07443, 0.27274],
  [0.15366, 0.25692, 0.09071],
  [0.21742, 0.0707, 0.0513],
  [0.58919, 0.53943, 0.09157],
  [0.30904, 0.14818, 0.27426],
  [0.14901, 0.23378, 0.35939],
  [0.86653, 0.86792, 0.85818],
  [0.57356, 0.57256, 0.57169],
  [0.35346, 0.35337, 0.35391],
  [0.20253, 0.20243, 0.20287],
  [0.09467, 0.0952, 0.09637],
  [0.03745, 0.03766, 0.03895],
  [0.18, 0.18, 0.18],
  [0.97784, 0.97784, 0.97784],
];
const OCIO_OUT: [number, number, number][] = [
  [4.966013432, -0.033002287, 0.041583523],
  [3.969460726, 3.825797558, -0.056160748],
  [-0.075460039, 3.689072609, 0.270235062],
  [-0.095436633, 3.650521517, 3.459975719],
  [-0.028881177, 0.19647342, 2.796123743],
  [4.900828362, -0.064385533, 3.838270903],
  [0.096890487, -0.001135427, 0.018971475],
  [0.809613585, 0.479857147, 0.814239979],
  [0.107417941, 0.920530438, 0.726379037],
  [0.115475342, 0.050812997, 0.030212998],
  [0.484880149, 0.301042914, 0.22676903],
  [0.098463453, 0.160814837, 0.277010798],
  [0.071130276, 0.107334509, 0.035097614],
  [0.207111374, 0.198474824, 0.375326097],
  [0.195447117, 0.48111254, 0.393299103],
  [0.571913302, 0.196873263, 0.041634843],
  [0.045791976, 0.069875412, 0.291233569],
  [0.424848884, 0.083199054, 0.102153927],
  [0.059589352, 0.022219239, 0.091246955],
  [0.360364884, 0.478741497, 0.086726815],
  [0.695661962, 0.371994466, 0.068298057],
  [0.01180624, 0.021665439, 0.19959487],
  [0.076526135, 0.256237596, 0.060564563],
  [0.300064713, 0.023416281, 0.030360531],
  [0.805483222, 0.596904039, 0.082996234],
  [0.388385385, 0.079899333, 0.245818958],
  [0.010951802, 0.196106046, 0.307181537],
  [0.921020269, 0.92170763, 0.912857533],
  [0.590191603, 0.588424563, 0.587825298],
  [0.337743223, 0.337686002, 0.33815524],
  [0.169266403, 0.169178575, 0.169557154],
  [0.058346011, 0.059387885, 0.060296256],
  [0.012581199, 0.012947144, 0.013654212],
  [0.145115077, 0.145115703, 0.14511548],
  [1.041565537, 1.04156661, 1.041566253],
];

describe("reference vectors", () => {
  test("P3-D65 1000-nit matches OpenColorIO within 1e-4", () => {
    const ot = acesOutputTransformFor(1000, P3D65_PRIMARIES);
    let maxErr = 0;
    OCIO_IN.forEach((c, i) => {
      const out = ot.forwardLinear(c[0], c[1], c[2]);
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(out[k] - OCIO_OUT[i][k]));
    });
    expect(maxErr).toBeLessThan(1e-4);
  });
});

describe("Rec.709 100-nit", () => {
  const ot = acesOutputTransform("rec709-100");

  test("18% grey renders at 10 nits and black stays black", () => {
    const lin = ot.forwardLinear(0.18, 0.18, 0.18);
    // ACES 2.0 puts 18% grey at 10.013 nits on a 100-nit display.
    expect(Math.abs(lin[0] * 100 - 10.013)).toBeLessThan(0.02);
    expect(ot.forward(0, 0, 0)).toEqual([0, 0, 0]);
  });

  test("the neutral axis is monotone and neutral", () => {
    let prev = -1;
    for (let i = 0; i <= 200; i++) {
      const s = Math.pow(2, (i / 200) * 16 - 10);
      const [r, g, b] = ot.forward(s, s, s);
      expect(Math.abs(r - g)).toBeLessThan(1e-4);
      expect(Math.abs(g - b)).toBeLessThan(1e-4);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(r).toBeLessThanOrEqual(1);
      prev = r;
    }
  });

  test("a saturated primary stays inside the display gamut", () => {
    const out = ot.forward(1, 0.02, 0.02);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(out[0]).toBeGreaterThan(out[1]);
  });
});

describe("HDR presets", () => {
  test("HLG and PQ deliver the same luminance for 18% grey", () => {
    const hlg = acesOutputTransform("rec2100-hlg-1000").forward(0.18, 0.18, 0.18);
    const pq = acesOutputTransform("rec2100-pq-1000").forward(0.18, 0.18, 0.18);
    const pqNits = pqDecode(pq[0]);
    const s = hlgOetfInverse(hlg[0]);
    const hlgNits = hlgOotf(s, s, s, 1000)[0];
    expect(Math.abs(pqNits - hlgNits)).toBeLessThan(0.5);
    // The 1000-nit tonescale places 18% grey near 14.5 nits.
    expect(Math.abs(pqNits - 14.5)).toBeLessThan(0.5);
  });

  test("presets restate the reference transforms", () => {
    expect(ACES_OUTPUT_PRESETS["rec709-100"].peakLuminance).toBe(100);
    expect(ACES_OUTPUT_PRESETS["rec2100-hlg-1000"].eotf).toBe("hlg");
    expect(ACES_OUTPUT_PRESETS["rec2100-pq-1000"].eotf).toBe("pq");
    for (const p of Object.values(ACES_OUTPUT_PRESETS)) expect(p.transformId.startsWith("Output.Academy.")).toBe(true);
  });

  test("transforms are built once per preset", () => {
    expect(acesOutputTransform("rec709-100")).toBe(acesOutputTransform("rec709-100"));
  });
});
