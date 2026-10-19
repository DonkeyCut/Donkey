// The export pass budget, sent with every export spec.
export const CUT_EXPORT_PASSES = {
  // The frames one ffmpeg pass may hold, MB. A long timeline renders in
  // passes held under it; a larger budget means fewer passes, each decoding
  // the stretch of file its cuts span.
  holdMB: 2048,
  // The most pieces one pass opens, whatever their size: each brings a
  // decoder and its threads.
  pieces: 48,
};
