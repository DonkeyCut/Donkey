/**
 * Colour lookup-table files as people download them: `.cube`
 * and Autodesk `.3dl`.
 *
 * A parsed file is a shaper (a 1D table), a cube (a 3D table), or both, each
 * with its own input domain. Data is stored normalized to 0..1 with red
 * running fastest, which is the order ffmpeg's lut3d, the WebGL 3D texture
 * and the CPU path already share. Malformed files throw an Error whose
 * message is short enough to show the person who dropped the file.
 *
 * Specs: Adobe Cube LUT Specification 1.0; the widely written
 * `LUT_1D_INPUT_RANGE` / `LUT_3D_INPUT_RANGE` extension and its
 * shaper-then-cube layout; Autodesk
 * `.3dl` (sample-point header, integer triplets, blue fastest).
 */

type Triple = [number, number, number];

export interface LutTable {
  size: number;
  /** Normalized outputs: `size*3` for a shaper, `size³*3` (red fastest) for a cube. */
  data: Float32Array;
  min: Triple;
  max: Triple;
}

export interface ParsedLut {
  title?: string;
  shaper?: LutTable;
  cube?: LutTable;
}

export type LutKind = "1d" | "3d" | "shaper+3d";

const SHAPER_MIN = 2;
const SHAPER_MAX = 65536;
const CUBE_MIN = 2;
const CUBE_MAX = 256;

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

function numbers(line: string, what: string): number[] {
  const parts = line.split(/\s+/);
  const out: number[] = [];
  for (const p of parts) {
    if (!NUMBER.test(p)) throw new Error(`${what}: "${line}" is not a number.`);
    out.push(Number(p));
  }
  return out;
}

function triple(line: string, what: string): Triple {
  const n = numbers(line, what);
  if (n.length !== 3) throw new Error(`${what}: "${line}" should be three numbers.`);
  return [n[0], n[1], n[2]];
}

function range(min: Triple, max: Triple): void {
  for (let i = 0; i < 3; i++) {
    if (!(max[i] > min[i])) throw new Error("LUT input range is empty.");
  }
}

/** Adobe Cube LUT Spec 1.0, with the input-range keywords and the
 * shaper-followed-by-cube layout. */
export function parseCube(text: string): ParsedLut {
  let title: string | undefined;
  let domainMin: Triple | undefined;
  let domainMax: Triple | undefined;
  type Block = {
    kind: "1d" | "3d";
    size: number;
    data: Float32Array;
    filled: number;
    range?: [number, number];
  };
  let shaper: Block | undefined;
  let cube: Block | undefined;
  let current: Block | undefined;

  for (const line of lines(text)) {
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line)?.[0];
    if (word) {
      const rest = line.slice(word.length).trim();
      switch (word) {
        case "TITLE":
          title = rest.replace(/^"(.*)"$/, "$1");
          break;
        case "DOMAIN_MIN":
          domainMin = triple(rest, "DOMAIN_MIN");
          break;
        case "DOMAIN_MAX":
          domainMax = triple(rest, "DOMAIN_MAX");
          break;
        case "LUT_1D_SIZE": {
          if (shaper) throw new Error("LUT_1D_SIZE appears twice.");
          const size = Number(rest);
          if (!Number.isInteger(size) || size < SHAPER_MIN || size > SHAPER_MAX)
            throw new Error(`LUT_1D_SIZE must be ${SHAPER_MIN}..${SHAPER_MAX}.`);
          shaper = current = { kind: "1d", size, data: new Float32Array(size * 3), filled: 0 };
          break;
        }
        case "LUT_3D_SIZE": {
          if (cube) throw new Error("LUT_3D_SIZE appears twice.");
          const size = Number(rest);
          if (!Number.isInteger(size) || size < CUBE_MIN || size > CUBE_MAX)
            throw new Error(`LUT_3D_SIZE must be ${CUBE_MIN}..${CUBE_MAX}.`);
          cube = current = { kind: "3d", size, data: new Float32Array(size * size * size * 3), filled: 0 };
          break;
        }
        case "LUT_1D_INPUT_RANGE":
        case "LUT_3D_INPUT_RANGE": {
          const n = numbers(rest, word);
          if (n.length !== 2) throw new Error(`${word} should be two numbers.`);
          const block = word === "LUT_1D_INPUT_RANGE" ? shaper : cube;
          if (!block) throw new Error(`${word} comes before its size.`);
          block.range = [n[0], n[1]];
          break;
        }
        default:
          // Vendor keywords ride along in real files; they change nothing here.
          break;
      }
      continue;
    }
    if (!current) throw new Error("LUT data comes before LUT_1D_SIZE or LUT_3D_SIZE.");
    if (current.filled >= current.data.length) throw new Error("The LUT has more lines than its size says.");
    const [r, g, b] = triple(line, "LUT data");
    current.data[current.filled++] = r;
    current.data[current.filled++] = g;
    current.data[current.filled++] = b;
  }

  if (!shaper && !cube) throw new Error("The file has no LUT_1D_SIZE or LUT_3D_SIZE.");
  const finish = (block: Block): LutTable => {
    if (block.filled !== block.data.length)
      throw new Error(
        `The LUT has ${block.filled / 3} lines; its size says ${block.data.length / 3}.`,
      );
    const min: Triple = block.range ? [block.range[0], block.range[0], block.range[0]] : domainMin ?? [0, 0, 0];
    const max: Triple = block.range ? [block.range[1], block.range[1], block.range[1]] : domainMax ?? [1, 1, 1];
    range(min, max);
    return { size: block.size, data: block.data, min, max };
  };
  const out: ParsedLut = {};
  if (title) out.title = title;
  if (shaper) out.shaper = finish(shaper);
  if (cube) out.cube = finish(cube);
  return out;
}

/** Autodesk `.3dl`: a line of input sample points, then integer output
 * triplets with blue running fastest. Bit depths are read off the file: input
 * from the last sample point, output from a `Mesh` header when there is one
 * and from the largest value otherwise. */
export function parse3dl(text: string): ParsedLut {
  const body = lines(text);
  let meshBits: number | undefined;
  let samples: number[] | undefined;
  const values: number[] = [];
  for (const line of body) {
    if (/^3DMESH\b/i.test(line)) continue;
    const mesh = /^Mesh\s+(\d+)\s+(\d+)/i.exec(line);
    if (mesh) {
      meshBits = Number(mesh[2]);
      continue;
    }
    if (/^[A-Za-z]/.test(line)) continue;
    if (!samples) {
      samples = numbers(line, "3dl sample points");
      if (samples.length < CUBE_MIN || samples.length > CUBE_MAX)
        throw new Error(`A 3dl LUT has ${CUBE_MIN}..${CUBE_MAX} sample points per axis.`);
      continue;
    }
    const n = numbers(line, "3dl data");
    if (n.length !== 3) throw new Error(`3dl data: "${line}" should be three numbers.`);
    for (const v of n) {
      if (!Number.isInteger(v) || v < 0) throw new Error(`3dl data: "${line}" should be whole numbers.`);
      values.push(v);
    }
  }
  if (!samples) throw new Error("The 3dl file has no sample points line.");
  const size = samples.length;
  if (values.length !== size * size * size * 3)
    throw new Error(`The 3dl LUT has ${values.length / 3} lines; ${size} sample points need ${size ** 3}.`);
  const top = samples[size - 1];
  const inputBits = Math.max(1, Math.ceil(Math.log2(top + 1)));
  const inputScale = 2 ** inputBits - 1;
  let peak = 0;
  for (const v of values) if (v > peak) peak = v;
  const detected = peak <= 1023 ? 10 : peak <= 4095 ? 12 : 16;
  const outputBits = meshBits ?? Math.max(inputBits, detected);
  const outputScale = 2 ** outputBits - 1;
  const data = new Float32Array(size * size * size * 3);
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const from = ((r * size + g) * size + b) * 3;
        const to = ((b * size + g) * size + r) * 3;
        data[to] = values[from] / outputScale;
        data[to + 1] = values[from + 1] / outputScale;
        data[to + 2] = values[from + 2] / outputScale;
      }
    }
  }
  const lo = samples[0] / inputScale;
  const hi = top / inputScale;
  const min: Triple = [lo, lo, lo];
  const max: Triple = [hi, hi, hi];
  range(min, max);
  return { cube: { size, data, min, max } };
}

/** Parse by the file's extension — a technical field, never the user's words. */
export function parseLutFile(fileName: string, text: string): ParsedLut {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === "cube") return parseCube(text);
  if (ext === "3dl") return parse3dl(text);
  throw new Error("LUT files are .cube or .3dl.");
}

const unit = (v: number, lo: number, hi: number): number => {
  const t = (v - lo) / (hi - lo);
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
};

function sampleShaper(t: LutTable, v: number, c: number): number {
  const x = unit(v, t.min[c], t.max[c]) * (t.size - 1);
  const i0 = Math.min(t.size - 2, Math.floor(x));
  const f = x - i0;
  const a = t.data[i0 * 3 + c];
  const b = t.data[(i0 + 1) * 3 + c];
  return a + (b - a) * f;
}

/** Tetrahedral interpolation on the cube: the scheme ffmpeg's lut3d defaults
 * to and the one the preview and the CPU path use for grade lattices. */
function sampleCube(t: LutTable, r: number, g: number, b: number): Triple {
  const { size, data } = t;
  const rf = unit(r, t.min[0], t.max[0]) * (size - 1);
  const gf = unit(g, t.min[1], t.max[1]) * (size - 1);
  const bf = unit(b, t.min[2], t.max[2]) * (size - 1);
  const r0 = Math.min(size - 2, Math.floor(rf));
  const g0 = Math.min(size - 2, Math.floor(gf));
  const b0 = Math.min(size - 2, Math.floor(bf));
  const dr = rf - r0;
  const dg = gf - g0;
  const db = bf - b0;
  const R = 3;
  const G = size * 3;
  const B = size * size * 3;
  const c0 = (b0 * size * size + g0 * size + r0) * 3;
  let w1: number, w2: number, w3: number, o1: number, o2: number, o3: number;
  if (dr >= dg) {
    if (dg >= db) {
      w1 = dr - dg; w2 = dg - db; w3 = db; o1 = R; o2 = R + G; o3 = R + G + B;
    } else if (dr >= db) {
      w1 = dr - db; w2 = db - dg; w3 = dg; o1 = R; o2 = R + B; o3 = R + G + B;
    } else {
      w1 = db - dr; w2 = dr - dg; w3 = dg; o1 = B; o2 = R + B; o3 = R + G + B;
    }
  } else if (db >= dg) {
    w1 = db - dg; w2 = dg - dr; w3 = dr; o1 = B; o2 = G + B; o3 = R + G + B;
  } else if (db >= dr) {
    w1 = dg - db; w2 = db - dr; w3 = dr; o1 = G; o2 = G + B; o3 = R + G + B;
  } else {
    w1 = dg - dr; w2 = dr - db; w3 = db; o1 = G; o2 = R + G; o3 = R + G + B;
  }
  const w0 = 1 - w1 - w2 - w3;
  const out: Triple = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    out[c] =
      w0 * data[c0 + c] +
      w1 * data[c0 + o1 + c] +
      w2 * data[c0 + o2 + c] +
      w3 * data[c0 + o3 + c];
  }
  return out;
}

/** The LUT's output for one colour: the shaper per channel (linear), then the
 * cube (tetrahedral), each mapped through its own input domain. Outputs are
 * returned as the file gives them, unclamped. */
export function sampleLut(lut: ParsedLut, r: number, g: number, b: number): Triple {
  if (lut.shaper) {
    r = sampleShaper(lut.shaper, r, 0);
    g = sampleShaper(lut.shaper, g, 1);
    b = sampleShaper(lut.shaper, b, 2);
  }
  if (lut.cube) return sampleCube(lut.cube, r, g, b);
  return [r, g, b];
}

/** What a card or a chip says about the file. */
export function lutFacts(lut: ParsedLut): { kind: LutKind; size: number } {
  if (lut.cube) return { kind: lut.shaper ? "shaper+3d" : "3d", size: lut.cube.size };
  if (lut.shaper) return { kind: "1d", size: lut.shaper.size };
  throw new Error("The LUT has no table.");
}

/** Bytes the parsed tables stand on, for a cache that counts them. */
export const lutBytes = (lut: ParsedLut): number =>
  (lut.shaper?.data.byteLength ?? 0) + (lut.cube?.data.byteLength ?? 0);
