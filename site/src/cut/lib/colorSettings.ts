// The color pipeline's constants, read wherever a LUT is sized.
export const CUT_COLOR = {
  // Lattice nodes per axis of a clip's color LUT: Rec.709 and sRGB sources
  // take the smaller cube, log and HDR sources the wider one.
  lutSize: 33,
  lutSizeWide: 65,
  // The cube drawn while a slider is moving; the full cube follows.
  draftLutSize: 17,
  // The preview proxy's largest height, and its HEVC quality (x265 crf; the
  // VideoToolbox quality maps from it). 18 is visually lossless for 10-bit
  // footage that is only ever previewed.
  proxyMaxHeight: 2160,
  proxyCrf: 18,
  // A LUT file past this is something else.
  lutFileMaxBytes: 64 * 1024 ** 2,
};
