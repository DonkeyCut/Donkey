/**
 * One mapping per clip. A clip's color is a pure function from its source
 * code values to the project's output code values, baked into one 3D LUT
 * that the WebGL pass, the CPU pass and ffmpeg's lut3d consume unchanged:
 *
 *   1 source conversion → the output's display values (none for Rec.709 /
 *     sRGB in SDR, and none for an HLG or PQ file delivered in its own
 *     encoding; Apple Log and Apple Log 2 decode to scene-linear ACES and go
 *     through the ACES 2.0 output transform — the Rec.709 100-nit transform
 *     for an SDR project, the Rec.2100 1000-nit HLG one when the project
 *     delivers HDR; HLG and PQ take the same transform into SDR, and cross
 *     into each other through the BT.2100 transfer at 1000 nits, so an HDR
 *     source keeps its range)
 *   2 the clip's library LUT, mixed by its amount
 *   3 the grade (preset layer, then manual), gradeMath.ts
 *   4 output: SDR as is; an SDR source delivered as HDR takes the BT.2408
 *     mapping (Rec.709 white to 203 nits in the Rec.2020 container)
 *
 * Sharpen and clarity are spatial and run on the picture afterwards
 * (detail.ts); they never enter the LUT or its key.
 *
 * The source conversion is the expensive stage (the ACES transform), and it
 * never changes while sliders move, so it can be sampled once onto its own
 * lattice and the cheap stages composed on top per edit.
 */

import { type ColorGrade, gradeWithoutDetail } from "./colorGrade";
import { type AcesOutputPresetId, acesOutputTransform } from "./acesOutput";
import {
  type CodeFormat,
  type Mat3,
  type OutputSpace,
  type SourceProfile,
  AP0_PRIMARIES,
  APPLE_WIDE_GAMUT_PRIMARIES,
  BRADFORD,
  HLG_SCENE_WHITE,
  REC2020_PRIMARIES,
  appleLogDecode,
  bt1886Decode,
  hlgOetf,
  hlgOetfInverse,
  hlgOotf,
  hlgOotfInverse,
  mat3Apply,
  mat3Inv,
  pqDecode,
  pqEncode,
  rgbToRgbMatrix,
  sdrToHlg,
  sdrToPq,
} from "./colorSpace";
import { type GradeLut, GRADE_LUT_SIZE, stableJson } from "./gradeLut";
import { type GradeTransform, createGradeTransform } from "./gradeMath";
import { type ParsedLut, sampleLut } from "./lutFile";

/** The file's Y'CbCr matrix and range beside the ones the decoder drew the
 * picture with. A browser decoder reads its matrix from tags, and the tags
 * are rewritten to Rec.709 so it draws code values; the picture then holds
 * R'G'B' made through the wrong matrix, and the source stage undoes that
 * before anything else. */
export interface DrawnColor {
  matrix: CodeFormat["matrix"];
  fullRange: boolean;
  drawnMatrix: CodeFormat["matrix"];
  drawnFullRange: boolean;
}

export interface ClipColorRecipe extends Partial<DrawnColor> {
  profile: SourceProfile;
  grade?: ColorGrade | null;
  output: OutputSpace;
  /** Lattice nodes per axis. */
  size: number;
}

/** True when the picture was drawn through a matrix or range that differs
 * from the file's. Missing fields mean Rec.709 limited on both sides. */
export function needsMatrixFix(drawn: Partial<DrawnColor> | undefined): drawn is DrawnColor {
  if (!drawn || drawn.drawnMatrix === undefined) return false;
  return drawn.drawnMatrix !== (drawn.matrix ?? "bt709") || (drawn.drawnFullRange ?? false) !== (drawn.fullRange ?? false);
}

/** True when the source's code values already are the output's: Rec.709 or
 * sRGB delivered as SDR, or an HLG or PQ file delivered in its own encoding,
 * drawn through the file's own matrix. */
export function recipeIsIdentity(profile: SourceProfile, output: OutputSpace, drawn?: Partial<DrawnColor>): boolean {
  const same = output === "sdr" ? profile === "rec709" || profile === "srgb" : profile === output;
  return same && !needsMatrixFix(drawn);
}

/** The space an HDR delivery composites in: every clip, graphic and effect
 * meets in HLG, and a PQ file is the final pass over the finished picture. */
export function compositeSpaceFor(output: OutputSpace): OutputSpace {
  return output === "sdr" ? "sdr" : "hlg";
}

/** The fix spelled for a cache key: "" when the picture needs none. */
export const drawnColorKey = (drawn: Partial<DrawnColor> | undefined): string =>
  needsMatrixFix(drawn)
    ? `${drawn.drawnMatrix}${drawn.drawnFullRange ? "f" : "l"}>${drawn.matrix}${drawn.fullRange ? "f" : "l"}`
    : "";

const isSdrSource = (profile: SourceProfile) => profile === "rec709" || profile === "srgb";
const isHdrSource = (profile: SourceProfile) => profile === "hlg" || profile === "pq";

/** A stable identity for the recipe's baked result. The LUT is referenced by
 * its id; the spatial controls are left out. "" when the recipe is an
 * identity mapping with no grade. */
export function recipeKey(recipe: ClipColorRecipe): string {
  const grade = gradeWithoutDetail(recipe.grade);
  if (!grade && recipeIsIdentity(recipe.profile, recipe.output, recipe)) return "";
  const drawn = drawnColorKey(recipe);
  return stableJson({
    profile: isSdrSource(recipe.profile) ? "rec709" : recipe.profile,
    output: recipe.output,
    size: recipe.size,
    ...(drawn ? { drawn } : {}),
    ...(grade ? { grade } : {}),
  });
}

/* ------------------------------------------------------------------ */
/* Stage 0: the drawn matrix                                           */
/* ------------------------------------------------------------------ */

/** Luma weights (Kr, Kb) of each matrix; Kg is what is left. */
const LUMA_WEIGHTS: Record<CodeFormat["matrix"], [number, number]> = {
  bt709: [0.2126, 0.0722],
  bt601: [0.299, 0.114],
  bt2020nc: [0.2627, 0.0593],
};

/** R'G'B' → Y'CbCr (Y' in [0,1], Cb/Cr centered on 0). */
function rgbToYccMatrix(matrix: CodeFormat["matrix"]): Mat3 {
  const [kr, kb] = LUMA_WEIGHTS[matrix];
  const kg = 1 - kr - kb;
  return [kr, kg, kb, -kr / (2 * (1 - kb)), -kg / (2 * (1 - kb)), 0.5, 0.5, -kg / (2 * (1 - kr)), -kb / (2 * (1 - kr))];
}

/** Y'CbCr code values (each in [0,1] of its 8-bit scale, chroma centered on
 * 128/255) → R'G'B' through the matrix at the range. What a decoder draws. */
export function decodeYcc(
  format: Pick<CodeFormat, "matrix" | "fullRange">,
  y: number,
  cb: number,
  cr: number
): [number, number, number] {
  const [yy, cbb, crr] = format.fullRange
    ? [y, cb - 128 / 255, cr - 128 / 255]
    : [((y * 255 - 16) / 219), ((cb * 255 - 128) / 224), ((cr * 255 - 128) / 224)];
  return mat3Apply(mat3Inv(rgbToYccMatrix(format.matrix)), yy, cbb, crr);
}

/** R'G'B' → Y'CbCr code values at the range: the inverse of `decodeYcc`. */
function encodeYcc(format: Pick<CodeFormat, "matrix" | "fullRange">, r: number, g: number, b: number): [number, number, number] {
  const [y, cb, cr] = mat3Apply(rgbToYccMatrix(format.matrix), r, g, b);
  return format.fullRange
    ? [y, cb + 128 / 255, cr + 128 / 255]
    : [(16 + 219 * y) / 255, (128 + 224 * cb) / 255, (128 + 224 * cr) / 255];
}

/** The affine map from the drawn R'G'B' back to the code values and out
 * through the file's own matrix and range. */
function matrixFixTransform(drawn: DrawnColor): GradeTransform {
  const fix = (r: number, g: number, b: number): [number, number, number] => {
    const [y, cb, cr] = encodeYcc({ matrix: drawn.drawnMatrix, fullRange: drawn.drawnFullRange }, r, g, b);
    return decodeYcc({ matrix: drawn.matrix, fullRange: drawn.fullRange }, y, cb, cr);
  };
  // The map is affine, so three basis probes and the offset pin it down.
  const t = fix(0, 0, 0);
  const cr = fix(1, 0, 0);
  const cg = fix(0, 1, 0);
  const cb = fix(0, 0, 1);
  const m: Mat3 = [
    cr[0] - t[0], cg[0] - t[0], cb[0] - t[0],
    cr[1] - t[1], cg[1] - t[1], cb[1] - t[1],
    cr[2] - t[2], cg[2] - t[2], cb[2] - t[2],
  ];
  return (r, g, b) => {
    const v = mat3Apply(m, r, g, b);
    return [v[0] + t[0], v[1] + t[1], v[2] + t[2]];
  };
}

/* ------------------------------------------------------------------ */
/* Stage 1: source conversion                                          */
/* ------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const REC2020_TO_AP0 = rgbToRgbMatrix(REC2020_PRIMARIES, AP0_PRIMARIES, BRADFORD);
const AWG_TO_AP0 = rgbToRgbMatrix(APPLE_WIDE_GAMUT_PRIMARIES, AP0_PRIMARIES, BRADFORD);
const HLG_TO_ACES_SCALE = 1 / HLG_SCENE_WHITE;

function acesPresetFor(output: OutputSpace): AcesOutputPresetId {
  return output === "hlg" ? "rec2100-hlg-1000" : output === "pq" ? "rec2100-pq-1000" : "rec709-100";
}

/** Code values → scene-linear AP0 for the profiles that carry a scene. */
function sceneDecoder(profile: SourceProfile): ((r: number, g: number, b: number) => [number, number, number]) | null {
  const toAp0 = (m: Mat3, r: number, g: number, b: number): [number, number, number] => [
    m[0] * r + m[1] * g + m[2] * b,
    m[3] * r + m[4] * g + m[5] * b,
    m[6] * r + m[7] * g + m[8] * b,
  ];
  switch (profile) {
    case "apple-log":
      return (r, g, b) => toAp0(REC2020_TO_AP0, appleLogDecode(r), appleLogDecode(g), appleLogDecode(b));
    case "apple-log-2":
      return (r, g, b) => toAp0(AWG_TO_AP0, appleLogDecode(r), appleLogDecode(g), appleLogDecode(b));
    case "hlg":
      // BT.2100 inverse OETF gives the HLG scene; BT.2408 puts its reference
      // white at the 75% signal, and ACES puts diffuse white at 1.0.
      return (r, g, b) =>
        toAp0(
          REC2020_TO_AP0,
          hlgOetfInverse(r) * HLG_TO_ACES_SCALE,
          hlgOetfInverse(g) * HLG_TO_ACES_SCALE,
          hlgOetfInverse(b) * HLG_TO_ACES_SCALE
        );
    case "pq":
      // PQ is display-referred: the ST 2084 EOTF gives nits, and the BT.2390
      // inverse OOTF for a 1000-nit display recovers the HLG scene.
      return (r, g, b) => {
        const [rs, gs, bs] = hlgOotfInverse(pqDecode(r), pqDecode(g), pqDecode(b), 1000);
        return toAp0(REC2020_TO_AP0, rs * HLG_TO_ACES_SCALE, gs * HLG_TO_ACES_SCALE, bs * HLG_TO_ACES_SCALE);
      };
    default:
      return null;
  }
}

/** HLG signal → PQ signal on a 1000-nit display: the BT.2100 OOTF gives the
 * display light, and ST 2084 encodes it. What the final pass of a PQ
 * delivery runs over the HLG composite. */
export function hlgToPq(r: number, g: number, b: number): [number, number, number] {
  const [rd, gd, bd] = hlgOotf(hlgOetfInverse(r), hlgOetfInverse(g), hlgOetfInverse(b), 1000);
  return [pqEncode(rd), pqEncode(gd), pqEncode(bd)];
}

/** PQ signal → HLG signal, the inverse: display light back through the
 * BT.2390 inverse OOTF at 1000 nits and the HLG OETF. */
export function pqToHlg(r: number, g: number, b: number): [number, number, number] {
  const [rs, gs, bs] = hlgOotfInverse(pqDecode(r), pqDecode(g), pqDecode(b), 1000);
  return [hlgOetf(rs), hlgOetf(gs), hlgOetf(bs)];
}

/** The source conversion for a profile into the output's display values, or
 * null when the source already is display values in the grade's container.
 * A drawn matrix that differs from the file's is undone first. An HDR file
 * delivered as the other HDR encoding crosses through the transfer alone —
 * same range, same display, so nothing is re-rendered. */
export function sourceTransform(
  profile: SourceProfile,
  output: OutputSpace,
  drawn?: Partial<DrawnColor>
): GradeTransform | null {
  const fix = needsMatrixFix(drawn) ? matrixFixTransform(drawn) : null;
  if (recipeIsIdentity(profile, output)) return fix;
  if (isHdrSource(profile) && output !== "sdr") {
    const cross = output === "pq" ? hlgToPq : pqToHlg;
    return (r, g, b) => {
      const [fr, fg, fb] = fix ? fix(r, g, b) : [r, g, b];
      return cross(clamp01(fr), clamp01(fg), clamp01(fb));
    };
  }
  const scene = sceneDecoder(profile);
  if (!scene) return fix;
  const ot = acesOutputTransform(acesPresetFor(output));
  return (r, g, b) => {
    const [fr, fg, fb] = fix ? fix(r, g, b) : [r, g, b];
    const [ar, ag, ab] = scene(clamp01(fr), clamp01(fg), clamp01(fb));
    return ot.forward(ar, ag, ab);
  };
}

/* ------------------------------------------------------------------ */
/* Stage 4: output                                                     */
/* ------------------------------------------------------------------ */

/** SDR display values into the HDR container (BT.2408), or null when the
 * grade already worked in the output container. */
function outputTransform(profile: SourceProfile, output: OutputSpace): GradeTransform | null {
  if (output === "sdr" || !isSdrSource(profile)) return null;
  const map = output === "hlg" ? sdrToHlg : sdrToPq;
  return (r, g, b) => map(bt1886Decode(r), bt1886Decode(g), bt1886Decode(b));
}

/* ------------------------------------------------------------------ */
/* The composed mapping                                                */
/* ------------------------------------------------------------------ */

/** Stages 2–4: the LUT, the grade and the output mapping on display values. */
function postSourceTransform(recipe: ClipColorRecipe, userLut: ParsedLut | undefined): GradeTransform | null {
  const grade = gradeWithoutDetail(recipe.grade);
  const gradeSpace: OutputSpace = isSdrSource(recipe.profile) ? "sdr" : recipe.output;
  const lutRef = grade?.lut;
  const lutAmount = lutRef && userLut ? (lutRef.amount ?? 1) : 0;
  const gradeFn = createGradeTransform(grade, gradeSpace);
  const outFn = outputTransform(recipe.profile, recipe.output);
  if (!lutAmount && !gradeFn && !outFn) return null;
  return (r, g, b) => {
    let v: [number, number, number] = [r, g, b];
    if (lutAmount && userLut) {
      const l = sampleLut(userLut, clamp01(v[0]), clamp01(v[1]), clamp01(v[2]));
      v = [
        v[0] + (l[0] - v[0]) * lutAmount,
        v[1] + (l[1] - v[1]) * lutAmount,
        v[2] + (l[2] - v[2]) * lutAmount,
      ];
    }
    if (gradeFn) v = gradeFn(v[0], v[1], v[2]);
    if (outFn) v = outFn(clamp01(v[0]), clamp01(v[1]), clamp01(v[2]));
    return v;
  };
}

/**
 * Compile the recipe into the pure mapping from source code values to output
 * code values, both in [0,1]. Returns null when the mapping is identity: an
 * SDR-in-SDR clip with no grade and no LUT.
 */
export function createClipTransform(recipe: ClipColorRecipe, userLut?: ParsedLut): GradeTransform | null {
  const source = sourceTransform(recipe.profile, recipe.output, recipe);
  const post = postSourceTransform(recipe, userLut);
  if (!source && !post) return null;
  return (r, g, b) => {
    let v: [number, number, number] = source ? source(r, g, b) : [r, g, b];
    if (post) v = post(v[0], v[1], v[2]);
    return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])];
  };
}

/* ------------------------------------------------------------------ */
/* Lattices                                                            */
/* ------------------------------------------------------------------ */

/** The source conversion sampled onto a lattice: display values of the
 * output container at every node of the source cube. */
export interface SourceLattice {
  profile: SourceProfile;
  output: OutputSpace;
  size: number;
  /** The drawn-matrix fix baked in, as `drawnKey` spells it; "" for none. */
  drawn: string;
  data: Float32Array;
}

function fillLattice(size: number, fn: GradeTransform): Float32Array {
  const data = new Float32Array(size * size * size * 3);
  const step = 1 / (size - 1);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const out = fn(r * step, g * step, b * step);
        data[i++] = out[0];
        data[i++] = out[1];
        data[i++] = out[2];
      }
    }
  }
  return data;
}

/** A fixed mapping sampled onto a lattice: the HLG → PQ pass a PQ delivery
 * ends with, and the sRGB → HLG mapping every graphic takes into an HDR
 * composite. */
export function buildTransferLut(size: number, fn: GradeTransform): GradeLut {
  return {
    size,
    data: fillLattice(size, (r, g, b) => {
      const v = fn(r, g, b);
      return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])];
    }),
  };
}

/** The mapping a graphic drawn in sRGB — a title, a caption, a sticker, the
 * frame color — takes into the HLG composite: BT.2408, white at 75%. */
export function graphicsToHlg(r: number, g: number, b: number): [number, number, number] {
  return sdrToHlg(bt1886Decode(clamp01(r)), bt1886Decode(clamp01(g)), bt1886Decode(clamp01(b)));
}

/** A CSS hex color mapped into the HLG composite, as hex again. */
export function hexToHlgHex(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const [r, g, b] = graphicsToHlg(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  const q = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${q(r)}${q(g)}${q(b)}`;
}

/** Sample the source conversion alone. Null when the profile needs none. */
export function buildSourceLattice(
  profile: SourceProfile,
  output: OutputSpace,
  size: number,
  drawn?: Partial<DrawnColor>
): SourceLattice | null {
  const source = sourceTransform(profile, output, drawn);
  if (!source) return null;
  return { profile, output, size, drawn: drawnColorKey(drawn), data: fillLattice(size, source) };
}

/** A few source lattices kept for the grade-only rebuilds while sliders
 * move; the cap is bytes, so four 65³ lattices at most. */
const SOURCE_LATTICE_CACHE_BYTES = 16 * 1024 * 1024;
const sourceLatticeCache = new Map<string, SourceLattice>();
let sourceLatticeBytes = 0;

function cachedSourceLattice(
  profile: SourceProfile,
  output: OutputSpace,
  size: number,
  drawn: Partial<DrawnColor> | undefined
): SourceLattice | null {
  const key = `${profile}|${output}|${size}|${drawnColorKey(drawn)}`;
  const hit = sourceLatticeCache.get(key);
  if (hit) {
    sourceLatticeCache.delete(key);
    sourceLatticeCache.set(key, hit);
    return hit;
  }
  const built = buildSourceLattice(profile, output, size, drawn);
  if (!built) return null;
  const bytes = built.data.byteLength;
  while (sourceLatticeBytes + bytes > SOURCE_LATTICE_CACHE_BYTES && sourceLatticeCache.size) {
    const oldest = sourceLatticeCache.keys().next().value as string;
    sourceLatticeBytes -= sourceLatticeCache.get(oldest)!.data.byteLength;
    sourceLatticeCache.delete(oldest);
  }
  sourceLatticeCache.set(key, built);
  sourceLatticeBytes += bytes;
  return built;
}

export function clearSourceLatticeCache(): void {
  sourceLatticeCache.clear();
  sourceLatticeBytes = 0;
}

/**
 * Sample the whole recipe onto the lattice. Returns null for an identity
 * mapping. A source lattice of the same profile, output and size composes the
 * cheap stages over it; without one the cached lattice is used, built on
 * first sight.
 */
export function buildClipLut(recipe: ClipColorRecipe, userLut?: ParsedLut, source?: SourceLattice): GradeLut | null {
  const size = recipe.size;
  const post = postSourceTransform(recipe, userLut);
  const lattice =
    source &&
    source.profile === recipe.profile &&
    source.output === recipe.output &&
    source.size === size &&
    source.drawn === drawnColorKey(recipe)
      ? source
      : cachedSourceLattice(recipe.profile, recipe.output, size, recipe);
  if (!lattice) {
    if (!post) return null;
    return {
      size,
      data: fillLattice(size, (r, g, b) => {
        const v = post(r, g, b);
        return [clamp01(v[0]), clamp01(v[1]), clamp01(v[2])];
      }),
    };
  }
  const src = lattice.data;
  const data = new Float32Array(src.length);
  if (!post) {
    for (let i = 0; i < src.length; i++) data[i] = clamp01(src[i]);
    return { size, data };
  }
  for (let i = 0; i < src.length; i += 3) {
    const v = post(src[i], src[i + 1], src[i + 2]);
    data[i] = clamp01(v[0]);
    data[i + 1] = clamp01(v[1]);
    data[i + 2] = clamp01(v[2]);
  }
  return { size, data };
}

/** The LUT of a grade alone on a Rec.709 source delivered as SDR: preset
 * tiles, thumbnails and the grade tests. */
export function buildGradeLut(g: ColorGrade | undefined | null, size = GRADE_LUT_SIZE): GradeLut | null {
  return buildClipLut({ profile: "rec709", grade: g, output: "sdr", size });
}
