/**
 * Changing how long audio lasts without changing how it sounds.
 *
 * Playing a buffer faster is the obvious way to speed a clip up, and it is the
 * wrong one: resampling moves every frequency with the rate, so a voice at 1.5×
 * comes back about seven semitones high. Both of Cut's other renderers avoid
 * that — ffmpeg through `atempo`, and the preview through the browser's own
 * `preservesPitch` — so an export that resampled would be the only place the
 * cut sounds different.
 *
 * This is WSOLA: overlap-add, where each frame is taken from wherever nearby it
 * best continues the waveform already written. Cutting and re-laying the signal
 * at those points changes its length while leaving its periods — and so its
 * pitch — alone. It is the same family of algorithm `atempo` uses.
 */

/** Analysis/synthesis frame, in seconds. Long enough to hold a pitch period of
 * a low voice, short enough that a transient is not smeared across it. */
const FRAME_SECONDS = 0.03;
/** How far on either side of the ideal position a frame may be taken from. */
const SEARCH_SECONDS = 0.008;
/** How much of the frame the similarity match compares. */
const MATCH_SECONDS = 0.01;
/** The match samples every Nth value. Alignment only needs the shape of the
 * waveform, not every sample of it, and the search runs for every output frame
 * — so this is most of what keeps stretching a long clip from costing more than
 * the encode it feeds. */
const MATCH_STRIDE = 4;

/** Periodic Hann. At 50% overlap successive windows sum to exactly 1, so the
 * overlap-add needs no normalising pass. */
function hann(length: number): Float32Array {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  return w;
}

/** Straight linear resample to `length` — the pitch-shifting behaviour, used
 * only where there is too little audio for a frame-based stretch to mean
 * anything. */
function resampleLinear(input: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  if (input.length === 0 || length === 0) return out;
  const ratio = (input.length - 1) / Math.max(1, length - 1);
  for (let i = 0; i < length; i++) {
    const at = i * ratio;
    const j = Math.floor(at);
    const frac = at - j;
    const a = input[Math.min(j, input.length - 1)];
    const b = input[Math.min(j + 1, input.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Stretch `channels` so the result is `factor` times as long, at the same pitch.
 *
 * `factor` is the output length over the input length: 0.5 makes a clip play in
 * half the time (a 2× speed-up), 2 makes it take twice as long. Every channel is
 * cut at the same points — choosing them per channel would move the two sides of
 * a stereo image independently and collapse it.
 */
export function timeStretch(
  channels: Float32Array[],
  sampleRate: number,
  factor: number
): Float32Array[] {
  if (channels.length === 0) return [];
  if (!(factor > 0) || !Number.isFinite(factor)) return channels.map((c) => c.slice());
  if (factor === 1) return channels.map((c) => c.slice());

  const inLength = channels[0].length;
  const outLength = Math.max(1, Math.round(inLength * factor));
  // An even frame keeps the synthesis hop exactly half of it, which is what
  // makes the windows sum to one.
  const frame = Math.max(4, Math.round(FRAME_SECONDS * sampleRate) & ~1);
  if (inLength < frame * 2) {
    return channels.map((c) => resampleLinear(c, outLength));
  }

  const hop = frame >> 1;
  const analysisHop = Math.max(1, Math.round(hop / factor));
  const search = Math.max(1, Math.round(SEARCH_SECONDS * sampleRate));
  const match = Math.max(2, Math.min(hop, Math.round(MATCH_SECONDS * sampleRate)));
  const window = hann(frame);

  // Overlap-add runs a frame past the end and is trimmed back after.
  const out = channels.map(() => new Float32Array(outLength + frame));
  // The match runs against one channel so every channel is cut alike.
  const guide = channels[0];

  /** The samples that followed the frame just used — what the next frame should
   * continue from if the waveform is to stay unbroken. */
  let expected: Float32Array | null = null;
  let analysis = 0;
  let outPos = 0;

  while (outPos < outLength && analysis + frame <= inLength) {
    let offset = 0;
    if (expected && expected.length >= MATCH_STRIDE) {
      let bestScore = -Infinity;
      const lo = Math.max(-search, -analysis);
      const hi = Math.min(search, inLength - frame - analysis);
      for (let d = lo; d <= hi; d++) {
        const at = analysis + d;
        let score = 0;
        for (let i = 0; i < expected.length; i += MATCH_STRIDE) score += guide[at + i] * expected[i];
        if (score > bestScore) {
          bestScore = score;
          offset = d;
        }
      }
    }
    const from = Math.min(Math.max(0, analysis + offset), inLength - frame);

    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < frame; i++) dst[outPos + i] += src[from + i] * window[i];
    }

    const nextFrom = from + hop;
    expected =
      nextFrom + match <= inLength ? guide.subarray(nextFrom, nextFrom + match) : null;
    outPos += hop;
    analysis += analysisHop;
  }

  // The first and last half-frame are only covered by one window, so they fade
  // in and out over about fifteen milliseconds. That is short enough to be
  // inaudible and is what lets the interior need no normalising.
  return out.map((o) => o.subarray(0, outLength));
}
