import { describe, expect, test } from "bun:test";
import { lutFacts, parse3dl, parseCube, parseLutFile, sampleLut } from "./lutFile";

const close = (got: readonly number[], want: readonly number[], eps = 1e-5) => {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(Math.abs(got[i] - want[i])).toBeLessThan(eps);
};

/** An identity cube of `size` nodes per axis, red fastest, as the spec lays it out. */
function identityCubeText(size: number, eol = "\n"): string {
  const out = [`LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++)
        out.push(`${r / (size - 1)} ${g / (size - 1)} ${b / (size - 1)}`);
  return out.join(eol) + eol;
}

const PROBES: [number, number, number][] = [
  [0, 0, 0],
  [1, 1, 1],
  [0.5, 0.5, 0.5],
  [0.2, 0.7, 0.1],
  [0.9, 0.1, 0.6],
  [0.33, 0.33, 0.8],
];

describe("parseCube", () => {
  test("an identity cube samples to its input", () => {
    const lut = parseCube(`TITLE "Identity"\n# a comment\n${identityCubeText(3)}`);
    expect(lut.title).toBe("Identity");
    expect(lutFacts(lut)).toEqual({ kind: "3d", size: 3 });
    for (const p of PROBES) close(sampleLut(lut, ...p), p);
  });

  test("CRLF files parse the same", () => {
    const lut = parseCube(identityCubeText(2, "\r\n"));
    for (const p of PROBES) close(sampleLut(lut, ...p), p);
  });

  test("a two-point shaper interpolates linearly", () => {
    const lut = parseCube("LUT_1D_SIZE 2\n0 0 0\n0.5 1 2\n");
    expect(lutFacts(lut)).toEqual({ kind: "1d", size: 2 });
    close(sampleLut(lut, 0.5, 0.5, 0.5), [0.25, 0.5, 1]);
    close(sampleLut(lut, 1, 0.25, 2), [0.5, 0.25, 2]);
  });

  test("DOMAIN_MIN/MAX map the input before the lattice", () => {
    const lut = parseCube(`DOMAIN_MIN -1 -1 -1\nDOMAIN_MAX 1 1 1\n${identityCubeText(2)}`);
    close(sampleLut(lut, 0, 0, 0), [0.5, 0.5, 0.5]);
    close(sampleLut(lut, -1, 1, 0.5), [0, 1, 0.75]);
  });

  test("a shaper followed by a cube applies both", () => {
    // Shaper halves every channel over 0..2; the cube inverts.
    const cube = ["LUT_3D_SIZE 2", "LUT_3D_INPUT_RANGE 0 1"];
    for (let b = 0; b < 2; b++)
      for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) cube.push(`${1 - r} ${1 - g} ${1 - b}`);
    const text = ["LUT_1D_SIZE 2", "LUT_1D_INPUT_RANGE 0 2", "0 0 0", "1 1 1", ...cube].join("\n");
    const lut = parseCube(text);
    expect(lutFacts(lut)).toEqual({ kind: "shaper+3d", size: 2 });
    close(sampleLut(lut, 2, 0, 1), [0, 1, 0.5]);
  });

  test("a graded cube is sampled tetrahedrally, red fastest", () => {
    // Output = (g, b, r): the data column order tells red from blue.
    const out = ["LUT_3D_SIZE 2"];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) out.push(`${g} ${b} ${r}`);
    const lut = parseCube(out.join("\n"));
    close(sampleLut(lut, 0.2, 0.7, 0.1), [0.7, 0.1, 0.2]);
  });

  test("malformed files name the problem", () => {
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0\n")).toThrow(/2 lines|8/);
    expect(() => parseCube("LUT_3D_SIZE 1\n")).toThrow(/2\.\.256/);
    expect(() => parseCube("LUT_1D_SIZE 70000\n")).toThrow(/2\.\.65536/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 x\n")).toThrow(/not a number/);
    expect(() => parseCube("0 0 0\n")).toThrow(/before/);
    expect(() => parseCube("# nothing\n")).toThrow(/no LUT_1D_SIZE/);
    expect(() => parseCube(`${identityCubeText(2)}0 0 0\n`)).toThrow(/more lines/);
  });
});

describe("parse3dl", () => {
  const SAMPLES = [0, 64, 128, 192, 256, 320, 384, 448, 512, 576, 640, 704, 768, 832, 896, 960, 1023];

  /** An identity at 10-bit over 17 sample points, blue fastest. */
  function identity3dl(eol = "\n"): string {
    const n = SAMPLES.length;
    const out = [SAMPLES.join(" ")];
    for (let r = 0; r < n; r++)
      for (let g = 0; g < n; g++)
        for (let b = 0; b < n; b++) out.push(`${SAMPLES[r]} ${SAMPLES[g]} ${SAMPLES[b]}`);
    return out.join(eol) + eol;
  }

  test("a 10-bit identity samples to its input", () => {
    const lut = parse3dl(identity3dl());
    expect(lutFacts(lut)).toEqual({ kind: "3d", size: 17 });
    for (const p of PROBES) close(sampleLut(lut, ...p), p, 2e-3);
  });

  test("blue-fastest data is reordered to red fastest", () => {
    // Output = (b, r, g) in 10-bit, over 2 sample points.
    const out = ["0 1023"];
    for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) out.push(`${b * 1023} ${r * 1023} ${g * 1023}`);
    const lut = parse3dl(out.join("\r\n"));
    close(sampleLut(lut, 0.2, 0.7, 0.1), [0.1, 0.2, 0.7], 1e-3);
  });

  test("output depth follows the Mesh header, then the largest value", () => {
    const twelve = ["3DMESH", "Mesh 1 12", "0 1023", ...Array(8).fill("4095 4095 4095")].join("\n");
    close(sampleLut(parse3dl(twelve), 0.5, 0.5, 0.5), [1, 1, 1]);
    const sixteen = ["0 1023", ...Array(8).fill("65535 0 0")].join("\n");
    close(sampleLut(parse3dl(sixteen), 0.5, 0.5, 0.5), [1, 0, 0]);
  });

  test("malformed files name the problem", () => {
    expect(() => parse3dl("0 1023\n0 0 0\n")).toThrow(/1 lines/);
    expect(() => parse3dl("0 1023\n0 0 1.5\n")).toThrow(/whole numbers/);
    expect(() => parse3dl("# only comments\n")).toThrow(/sample points/);
  });
});

describe("parseLutFile", () => {
  test("picks the parser by extension", () => {
    expect(lutFacts(parseLutFile("look.CUBE", identityCubeText(2))).kind).toBe("3d");
    expect(lutFacts(parseLutFile("look.3dl", "0 1023\n" + Array(8).fill("0 0 0").join("\n"))).size).toBe(2);
    expect(() => parseLutFile("look.txt", "")).toThrow(/\.cube or \.3dl/);
  });
});
