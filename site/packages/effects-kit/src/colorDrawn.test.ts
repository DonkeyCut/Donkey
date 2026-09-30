import { describe, expect, test } from "bun:test";
import {
  buildClipLut,
  buildSourceLattice,
  clearSourceLatticeCache,
  createClipTransform,
  decodeYcc,
  needsMatrixFix,
  recipeIsIdentity,
  recipeKey,
  sourceTransform,
  type DrawnColor,
} from "./colorPipeline";

const near = (a: number[], b: number[], eps: number) => {
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(eps);
};

/** A Rec.2020 limited file the browser drew through Rec.709 limited. */
const SKEWED: DrawnColor = { matrix: "bt2020nc", fullRange: false, drawnMatrix: "bt709", drawnFullRange: false };

describe("drawn matrix", () => {
  test("identity holds only when the drawn matrix and range are the file's", () => {
    expect(recipeIsIdentity("rec709", "sdr")).toBe(true);
    expect(recipeIsIdentity("rec709", "sdr", { matrix: "bt709", fullRange: false, drawnMatrix: "bt709", drawnFullRange: false })).toBe(true);
    expect(recipeIsIdentity("rec709", "sdr", { drawnMatrix: "bt709", drawnFullRange: false })).toBe(true);
    expect(recipeIsIdentity("rec709", "sdr", SKEWED)).toBe(false);
    expect(recipeIsIdentity("rec709", "sdr", { matrix: "bt709", fullRange: true, drawnMatrix: "bt709", drawnFullRange: false })).toBe(false);
    expect(needsMatrixFix({ matrix: "bt601", fullRange: false })).toBe(false);
  });

  test("the key carries the fix and drops it when there is none", () => {
    const plain = recipeKey({ profile: "hlg", output: "sdr", size: 17 });
    const fixed = recipeKey({ profile: "hlg", output: "sdr", size: 17, ...SKEWED });
    expect(fixed).not.toBe(plain);
    expect(fixed).toContain("bt709l>bt2020ncl");
    expect(recipeKey({ profile: "hlg", output: "sdr", size: 17, matrix: "bt2020nc", fullRange: false, drawnMatrix: "bt2020nc", drawnFullRange: false })).toBe(plain);
    expect(recipeKey({ profile: "rec709", output: "sdr", size: 17, ...SKEWED })).not.toBe("");
  });

  test("the fix recovers the code values the wrong matrix hid", () => {
    // Code values through the true matrix, then through the drawn one, then the fix.
    const codes: [number, number, number][] = [
      [135 / 255, 91 / 255, 157 / 255],
      [113 / 255, 164 / 255, 97 / 255],
      [124 / 255, 128 / 255, 128 / 255],
      [206 / 255, 128 / 255, 128 / 255],
      [40 / 255, 200 / 255, 60 / 255],
    ];
    const fix = sourceTransform("rec709", "sdr", SKEWED)!;
    for (const [y, cb, cr] of codes) {
      const truth = decodeYcc({ matrix: "bt2020nc", fullRange: false }, y, cb, cr);
      const drawn = decodeYcc({ matrix: "bt709", fullRange: false }, y, cb, cr);
      near(fix(drawn[0], drawn[1], drawn[2]), truth, 1e-9);
    }
  });

  test("a range mismatch is undone too", () => {
    const fix = sourceTransform("rec709", "sdr", { matrix: "bt709", fullRange: true, drawnMatrix: "bt709", drawnFullRange: false })!;
    const drawn = decodeYcc({ matrix: "bt709", fullRange: false }, 124 / 255, 128 / 255, 128 / 255);
    near(fix(drawn[0], drawn[1], drawn[2]), [124 / 255, 124 / 255, 124 / 255], 1e-9);
  });

  test("the fix sits before the scene decode", () => {
    const direct = sourceTransform("hlg", "sdr")!;
    const fixed = sourceTransform("hlg", "sdr", SKEWED)!;
    const drawn = decodeYcc({ matrix: "bt709", fullRange: false }, 135 / 255, 91 / 255, 157 / 255);
    const truth = decodeYcc({ matrix: "bt2020nc", fullRange: false }, 135 / 255, 91 / 255, 157 / 255);
    near(fixed(drawn[0], drawn[1], drawn[2]), direct(truth[0], truth[1], truth[2]), 1e-6);
  });

  test("lattices and the clip transform agree, and a lattice without the fix is never reused for it", () => {
    clearSourceLatticeCache();
    const recipe = { profile: "hlg" as const, output: "sdr" as const, size: 9, ...SKEWED };
    const withFix = buildClipLut(recipe)!;
    const plainLattice = buildSourceLattice("hlg", "sdr", 9)!;
    const viaPlain = buildClipLut(recipe, undefined, plainLattice)!;
    expect(Array.from(viaPlain.data)).toEqual(Array.from(withFix.data));
    const fn = createClipTransform(recipe)!;
    const lut = buildClipLut({ profile: "rec709", output: "sdr", size: 9, ...SKEWED })!;
    const fn709 = createClipTransform({ profile: "rec709", output: "sdr", size: 9, ...SKEWED })!;
    // Node (4,2,6) of a 9-cube.
    const i = ((6 * 9 + 2) * 9 + 4) * 3;
    near([lut.data[i], lut.data[i + 1], lut.data[i + 2]], fn709(4 / 8, 2 / 8, 6 / 8), 1e-6);
    expect(fn(0.5, 0.5, 0.5)).toHaveLength(3);
  });
});
