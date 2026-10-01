import { describe, expect, test } from "bun:test";
import {
  buildClipLut,
  buildGradeLut,
  buildSourceLattice,
  buildTransferLut,
  clearSourceLatticeCache,
  compositeSpaceFor,
  createClipTransform,
  graphicsToHlg,
  hexToHlgHex,
  hlgToPq,
  pqToHlg,
  recipeIsIdentity,
  recipeKey,
  sourceTransform,
} from "./colorPipeline";
import { BT2408_HLG_WHITE, appleLogEncode, bt1886Encode, pqEncode, sdrToHlg } from "./colorSpace";
import { applyLutToImageData } from "./gradeLut";
import type { ParsedLut } from "./lutFile";

/** A two-node cube that inverts every channel. */
function invertLut(): ParsedLut {
  const data = new Float32Array(8 * 3);
  let i = 0;
  for (let b = 0; b < 2; b++)
    for (let g = 0; g < 2; g++)
      for (let r = 0; r < 2; r++) {
        data[i++] = 1 - r;
        data[i++] = 1 - g;
        data[i++] = 1 - b;
      }
  return { cube: { size: 2, data, min: [0, 0, 0], max: [1, 1, 1] } };
}

const near = (a: number[], b: number[], eps: number) => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps);
};
const neutral = (v: number[], eps = 1e-6) => {
  expect(Math.abs(v[0] - v[1])).toBeLessThan(eps);
  expect(Math.abs(v[1] - v[2])).toBeLessThan(eps);
};

describe("identity and keys", () => {
  test("Rec.709 and sRGB delivered as SDR need no mapping", () => {
    expect(recipeIsIdentity("rec709", "sdr")).toBe(true);
    expect(recipeIsIdentity("srgb", "sdr")).toBe(true);
    expect(recipeIsIdentity("rec709", "hlg")).toBe(false);
    expect(recipeIsIdentity("apple-log", "sdr")).toBe(false);
    expect(createClipTransform({ profile: "rec709", output: "sdr", size: 33 })).toBe(null);
    expect(buildClipLut({ profile: "srgb", output: "sdr", size: 33 })).toBe(null);
  });

  test("the key is empty for identity, blind to spatial controls, and stable", () => {
    expect(recipeKey({ profile: "srgb", output: "sdr", size: 33 })).toBe("");
    expect(recipeKey({ profile: "srgb", output: "sdr", size: 33, grade: { sharpen: 20, clarity: 5 } })).toBe("");
    const a = recipeKey({ profile: "rec709", output: "sdr", size: 33, grade: { contrast: 10, exposure: 5 } });
    const b = recipeKey({ profile: "srgb", output: "sdr", size: 33, grade: { exposure: 5, contrast: 10, sharpen: 30 } });
    expect(a).toBe(b);
    expect(a).not.toBe(recipeKey({ profile: "rec709", output: "sdr", size: 33, grade: { contrast: 11 } }));
    expect(a).not.toBe(recipeKey({ profile: "rec709", output: "sdr", size: 65, grade: { contrast: 10, exposure: 5 } }));
    expect(recipeKey({ profile: "apple-log", output: "sdr", size: 33 })).not.toBe("");
    expect(recipeKey({ profile: "rec709", output: "hlg", size: 33 })).not.toBe("");
    expect(recipeKey({ profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:a" } } })).not.toBe(
      recipeKey({ profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:b" } } })
    );
  });
});

describe("library LUT", () => {
  test("mixes by amount and sits before the grade", () => {
    const lut = invertLut();
    const full = createClipTransform({ profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:x" } } }, lut)!;
    near(full(0.2, 0.5, 0.9), [0.8, 0.5, 0.1], 1e-6);
    const half = createClipTransform(
      { profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:x", amount: 0.5 } } },
      lut
    )!;
    near(half(0.2, 0.5, 0.9), [0.5, 0.5, 0.5], 1e-6);
    // Without the parsed file the reference renders as neutral.
    expect(createClipTransform({ profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:x" } } })).toBe(null);
    // Fade lifts black after the LUT: inverted white is black, then lifted.
    const faded = createClipTransform(
      { profile: "rec709", output: "sdr", size: 33, grade: { lut: { id: "lut:x" }, fade: 50 } },
      lut
    )!;
    expect(faded(1, 1, 1)[0]).toBeGreaterThan(0.15);
  });
});

describe("source conversion", () => {
  test("Apple Log 18% grey renders as ACES middle grey", () => {
    const v = appleLogEncode(0.18);
    const out = createClipTransform({ profile: "apple-log", output: "sdr", size: 33 })!(v, v, v);
    neutral(out);
    expect(Math.abs(out[0] - 0.3831)).toBeLessThan(2e-3);
    const out2 = createClipTransform({ profile: "apple-log-2", output: "sdr", size: 33 })!(v, v, v);
    neutral(out2);
    expect(Math.abs(out2[0] - out[0])).toBeLessThan(1e-3);
  });

  test("HLG and PQ sources agree on reference white in SDR", () => {
    const hlg = sourceTransform("hlg", "sdr")!(BT2408_HLG_WHITE, BT2408_HLG_WHITE, BT2408_HLG_WHITE);
    const p = pqEncode(203);
    const pq = sourceTransform("pq", "sdr")!(p, p, p);
    neutral(hlg);
    neutral(pq);
    expect(Math.abs(hlg[0] - pq[0])).toBeLessThan(2e-3);
    // The BT.2408 reference white lands near 0.6, leaving the top of the
    // range to the highlights.
    expect(Math.abs(hlg[0] - 0.6056)).toBeLessThan(2e-3);
  });

  test("an HLG source keeps its hues in SDR", () => {
    // Pure Rec.709 red, as an iPhone records a red screen: the red channel
    // carries it alone after the conversion, with no drift toward orange.
    const red = sdrToHlg(0.6, 0, 0);
    const out = sourceTransform("hlg", "sdr")!(...red);
    expect(out[0]).toBeGreaterThan(0.5);
    expect(out[1]).toBeLessThan(0.01);
    expect(out[2]).toBeLessThan(0.01);
  });

  test("an HDR source delivered in its own encoding is left alone, graded in place", () => {
    expect(recipeIsIdentity("hlg", "hlg")).toBe(true);
    expect(recipeIsIdentity("pq", "pq")).toBe(true);
    expect(recipeIsIdentity("hlg", "pq")).toBe(false);
    expect(recipeIsIdentity("apple-log", "hlg")).toBe(false);
    expect(createClipTransform({ profile: "hlg", output: "hlg", size: 33 })).toBeNull();
    expect(recipeKey({ profile: "hlg", output: "hlg", size: 33 })).toBe("");
    // A grade on it works in the HLG container: neutral stays neutral, the
    // order holds, and an exposure lift lands above the untouched signal.
    const t = createClipTransform({ profile: "hlg", output: "hlg", size: 33, grade: { exposure: 20 } })!;
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const out = t(s, s, s);
      neutral(out, 1e-4);
      expect(out[0]).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = out[0];
    }
    expect(t(0.5, 0.5, 0.5)[0]).toBeGreaterThan(0.5);
  });

  test("HLG and PQ cross into each other through the transfer at 1000 nits, and back", () => {
    const w = BT2408_HLG_WHITE;
    near(hlgToPq(w, w, w), [pqEncode(203), pqEncode(203), pqEncode(203)], 1e-3);
    near(hlgToPq(1, 1, 1), [pqEncode(1000), pqEncode(1000), pqEncode(1000)], 1e-6);
    for (const s of [0.1, 0.4, 0.75, 0.95]) {
      near(pqToHlg(...hlgToPq(s, s * 0.8, s * 0.5)), [s, s * 0.8, s * 0.5], 1e-5);
    }
    const hlgToPqRecipe = createClipTransform({ profile: "hlg", output: "pq", size: 33 })!;
    near(hlgToPqRecipe(w, w, w), hlgToPq(w, w, w), 1e-3);
    const pqToHlgRecipe = createClipTransform({ profile: "pq", output: "hlg", size: 33 })!;
    const p = pqEncode(203);
    near(pqToHlgRecipe(p, p, p), [w, w, w], 1e-3);
  });

  test("a log source delivered as HDR renders through the ACES HLG transform", () => {
    const t = createClipTransform({ profile: "apple-log", output: "hlg", size: 33 })!;
    const grey = appleLogEncode(0.18);
    const out = t(grey, grey, grey);
    neutral(out, 2e-3);
    // Middle grey lands below reference white and above black.
    expect(out[0]).toBeGreaterThan(0.2);
    expect(out[0]).toBeLessThan(BT2408_HLG_WHITE);
  });

  test("graphics map into HLG at reference white, the frame color with them", () => {
    near(graphicsToHlg(1, 1, 1), [BT2408_HLG_WHITE, BT2408_HLG_WHITE, BT2408_HLG_WHITE], 2e-4);
    near(graphicsToHlg(0, 0, 0), [0, 0, 0], 1e-9);
    expect(hexToHlgHex("#ffffff")).toBe("#bfbfbf");
    expect(hexToHlgHex("#000000")).toBe("#000000");
    expect(hexToHlgHex("nope")).toBe("nope");
    const lut = buildTransferLut(9, graphicsToHlg);
    expect(lut.size).toBe(9);
    // The last node is white in, reference white out.
    const last = lut.data.length - 3;
    near([lut.data[last], lut.data[last + 1], lut.data[last + 2]], [BT2408_HLG_WHITE, BT2408_HLG_WHITE, BT2408_HLG_WHITE], 2e-4);
    expect(compositeSpaceFor("sdr")).toBe("sdr");
    expect(compositeSpaceFor("hlg")).toBe("hlg");
    expect(compositeSpaceFor("pq")).toBe("hlg");
  });

  test("an SDR source delivered as HDR takes the BT.2408 mapping", () => {
    const hlg = createClipTransform({ profile: "rec709", output: "hlg", size: 33 })!;
    near(hlg(1, 1, 1), [BT2408_HLG_WHITE, BT2408_HLG_WHITE, BT2408_HLG_WHITE], 2e-4);
    const pq = createClipTransform({ profile: "srgb", output: "pq", size: 33 })!;
    near(pq(1, 1, 1), [pqEncode(203), pqEncode(203), pqEncode(203)], 1e-6);
    // The grade works on SDR values first: a stop of exposure doubles linear
    // light before the container change.
    const graded = createClipTransform({ profile: "rec709", output: "pq", size: 33, grade: { exposure: 25 } })!;
    const grey = bt1886Encode(0.18);
    expect(graded(grey, grey, grey)[0]).toBeGreaterThan(pq(grey, grey, grey)[0]);
  });
});

describe("lattices", () => {
  test("composing over a source lattice equals the direct build", () => {
    clearSourceLatticeCache();
    const recipe = { profile: "apple-log" as const, output: "sdr" as const, size: 17, grade: { contrast: 20, temperature: -10 } };
    const direct = buildClipLut(recipe)!;
    const lattice = buildSourceLattice("apple-log", "sdr", 17)!;
    const composed = buildClipLut(recipe, undefined, lattice)!;
    expect(composed.size).toBe(17);
    for (let i = 0; i < direct.data.length; i++) expect(Math.abs(direct.data[i] - composed.data[i])).toBeLessThan(1e-6);
    // A lattice of another size or profile is ignored, and the cached one used.
    const other = buildSourceLattice("hlg", "sdr", 17)!;
    const viaOther = buildClipLut(recipe, undefined, other)!;
    for (let i = 0; i < direct.data.length; i++) expect(Math.abs(direct.data[i] - viaOther.data[i])).toBeLessThan(1e-6);
    expect(buildSourceLattice("rec709", "sdr", 17)).toBe(null);
  });

  test("the LUT agrees with the transform through the tetrahedral pass", () => {
    const recipe = { profile: "apple-log" as const, output: "sdr" as const, size: 33, grade: { contrast: 15, saturation: 10 } };
    const lut = buildClipLut(recipe)!;
    const t = createClipTransform(recipe)!;
    const samples: [number, number, number][] = [
      [0.3, 0.4, 0.5],
      [0.48, 0.48, 0.48],
      [0.6, 0.45, 0.35],
      [0.2, 0.55, 0.5],
    ];
    const px = new Uint8ClampedArray(samples.length * 4);
    samples.forEach((c, i) => {
      px[i * 4] = Math.round(c[0] * 255);
      px[i * 4 + 1] = Math.round(c[1] * 255);
      px[i * 4 + 2] = Math.round(c[2] * 255);
      px[i * 4 + 3] = 255;
    });
    applyLutToImageData(px, lut);
    samples.forEach((c, i) => {
      const d = t(Math.round(c[0] * 255) / 255, Math.round(c[1] * 255) / 255, Math.round(c[2] * 255) / 255);
      for (let k = 0; k < 3; k++) expect(Math.abs(px[i * 4 + k] - d[k] * 255)).toBeLessThanOrEqual(4);
    });
  });

  test("buildGradeLut is the Rec.709 SDR recipe and stays in range", () => {
    expect(buildGradeLut(undefined)).toBe(null);
    expect(buildGradeLut({ contrast: 0 })).toBe(null);
    const lut = buildGradeLut({ exposure: 50, highlights: 50, wheels: { s: [50, 0, 0] } }, 9)!;
    expect(lut.size).toBe(9);
    expect(lut.data.length).toBe(9 * 9 * 9 * 3);
    for (const v of lut.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
