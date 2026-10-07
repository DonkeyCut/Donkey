/**
 * Lining up a separately recorded sound with a camera's own.
 *
 * Both devices heard the same room, so the camera's scratch track and the
 * clean recording carry the same events — words, claps, a door — at times
 * that differ by one constant: when each device started rolling. That
 * constant is where the two signals agree best, which is a cross-correlation.
 *
 * Correlating raw waveforms over a long recording costs too much and trips on
 * what the two microphones disagree about (distance, polarity, the room), so
 * the search runs in two passes. The coarse pass correlates loudness
 * envelopes — log energy per 20 ms, with the slow level drift taken out —
 * which survive any difference in gain or tone and turn an hour of sound into
 * a few hundred thousand numbers. The fine pass correlates the waveforms
 * themselves at 16 kHz, a few seconds of each, within a hair of where the
 * coarse pass landed, to put the offset on the sample.
 *
 * How sure the answer is reads off the coarse pass: the best agreement over
 * the runner-up a second or more away from it. A recording of a different
 * take, or two tracks with nothing loud in common, has no clear winner, and
 * the caller refuses it.
 *
 * Pure: arrays in, numbers out. The decoding happens where the file lives.
 */

/** The rate both signals are compared at. */
export const SYNC_RATE = 16000;
/** Samples per envelope hop: 20 ms. */
const ENV_HOP = 320;
export const ENV_HOP_S = ENV_HOP / SYNC_RATE;
/** Hops the slow level drift is measured over, taken out of the envelope. */
const DETREND_HOPS = 50;
/** A runner-up closer than this to the best lag is the same peak's shoulder. */
const PEAK_EXCLUDE_S = 1;
/** The least of either signal that has to overlap at a lag for it to count. */
const MIN_OVERLAP_SHARE = 0.5;
/** How far the fine pass searches either side of the coarse answer. */
const FINE_REACH_S = 0.06;
/** How much of the camera's sound the fine pass compares. */
const FINE_SECONDS = 4;
/** Confidence reported when the runner-up does not agree at all. */
const CONFIDENCE_CAP = 99;

/**
 * Folds decoded chunks of any rate and channel count into one mono signal at
 * `SYNC_RATE`: channels averaged, then each output sample the mean of the
 * input samples it covers — a box filter, enough to keep the fold from
 * aliasing what the correlation compares. A rate below `SYNC_RATE` (a voice
 * recorder's 8 kHz) holds each input sample for the outputs it spans.
 */
export class MonoResampler {
  private out: Float32Array;
  private n = 0;
  private sum = 0;
  private count = 0;
  /** Input position, in output samples. */
  private pos = 0;

  constructor(expectedSeconds = 60) {
    this.out = new Float32Array(Math.max(1024, Math.ceil(expectedSeconds * SYNC_RATE)));
  }

  push(channels: Float32Array[], sampleRate: number): void {
    const step = SYNC_RATE / sampleRate;
    const len = channels[0]?.length ?? 0;
    const k = channels.length;
    for (let i = 0; i < len; i++) {
      let v = 0;
      for (let c = 0; c < k; c++) v += channels[c][i];
      this.sum += v / k;
      this.count++;
      const next = this.pos + step;
      const outputs = Math.floor(next) - Math.floor(this.pos);
      if (outputs > 0) {
        const v = this.sum / this.count;
        for (let o = 0; o < outputs; o++) this.emit(v);
        this.sum = 0;
        this.count = 0;
      }
      this.pos = next;
    }
  }

  private emit(v: number): void {
    if (this.n === this.out.length) {
      const grown = new Float32Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.n++] = v;
  }

  /** The signal so far. */
  samples(): Float32Array {
    return this.out.subarray(0, this.n);
  }

  /** Hand the samples gathered since the last drain to `into` and let them
   * go, so a long signal streams through in one chunk's worth of memory. */
  drain(into: (mono: Float32Array) => void): void {
    if (this.n > 0) into(this.out.subarray(0, this.n));
    this.n = 0;
  }
}

/**
 * The loudness envelope the coarse pass compares, built from mono samples at
 * `SYNC_RATE` as they arrive: log RMS per hop. Kept separate from the
 * samples, so an hour of recording costs an hour of envelope.
 */
export class EnvelopeBuilder {
  private out: Float32Array;
  private n = 0;
  private acc = 0;
  private fill = 0;

  constructor(expectedSeconds = 60) {
    this.out = new Float32Array(Math.max(256, Math.ceil(expectedSeconds / ENV_HOP_S) + 1));
  }

  push(mono: Float32Array): void {
    for (let i = 0; i < mono.length; i++) {
      this.acc += mono[i] * mono[i];
      if (++this.fill === ENV_HOP) {
        if (this.n === this.out.length) {
          const grown = new Float32Array(this.out.length * 2);
          grown.set(this.out);
          this.out = grown;
        }
        this.out[this.n++] = Math.log(1e-8 + this.acc / ENV_HOP);
        this.acc = 0;
        this.fill = 0;
      }
    }
  }

  envelope(): Float32Array {
    return this.out.subarray(0, this.n);
  }
}

/** The envelope of a whole mono signal at `SYNC_RATE`. */
export function envelopeOf(mono: Float32Array): Float32Array {
  const b = new EnvelopeBuilder(mono.length / SYNC_RATE);
  b.push(mono);
  return b.envelope();
}

/** The envelope with its slow drift taken out and scaled to unit variance,
 * so the correlation weighs where loudness moves, whatever level a device
 * recorded. */
function normalizeEnvelope(env: Float32Array): Float64Array {
  const n = env.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  // Running mean over a centered window, by prefix sums.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const half = Math.floor(DETREND_HOPS / 2);
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    const v = env[i] - (prefix[b] - prefix[a]) / (b - a);
    out[i] = v;
    sq += v * v;
  }
  const sd = Math.sqrt(sq / n);
  if (sd > 1e-9) for (let i = 0; i < n; i++) out[i] /= sd;
  return out;
}

/** In-place radix-2 FFT; `inverse` runs it backward, unscaled. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half] * cr - im[i + k + half] * ci;
        const ai = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k + half] = re[i + k] - ar;
        im[i + k + half] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/**
 * Cross-correlation of `a` against `b` at every lag where they overlap:
 * `at(k)` is Σ a[i]·b[i + k], for k from −(a.length − 1) to b.length − 1.
 */
function crossCorrelate(
  a: ArrayLike<number>,
  b: ArrayLike<number>
): { at: (k: number) => number; min: number; max: number } {
  const need = a.length + b.length - 1;
  let n = 1;
  while (n < need) n <<= 1;
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < a.length; i++) ar[i] = a[i];
  for (let i = 0; i < b.length; i++) br[i] = b[i];
  fft(ar, ai, false);
  fft(br, bi, false);
  // conj(A)·B
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] + ai[i] * bi[i];
    const im = ar[i] * bi[i] - ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  const scale = 1 / n;
  return {
    at: (k) => ar[(k + n) % n] * scale,
    min: -(a.length - 1),
    max: b.length - 1,
  };
}

/** The coarse answer: the lag, in hops, at which the camera's envelope sits
 * best inside the recording's, and how clearly it beats the runner-up. */
interface CoarseSync {
  lag: number;
  confidence: number;
}

/**
 * Where `camera` (an envelope) sits inside `recording` (another): camera hop
 * i lines up with recording hop i + lag. Lags where less than half of the
 * shorter signal overlaps are never considered — a sliver of overlap agrees
 * with anything.
 */
export function coarseSync(camera: Float32Array, recording: Float32Array): CoarseSync | null {
  const a = normalizeEnvelope(camera);
  const b = normalizeEnvelope(recording);
  if (a.length < 4 || b.length < 4) return null;
  const xc = crossCorrelate(a, b);
  const need = Math.ceil(Math.min(a.length, b.length) * MIN_OVERLAP_SHARE);
  // Overlap at lag k: the hops of a that land inside b.
  const overlap = (k: number) => Math.min(a.length, b.length - k) - Math.max(0, -k);
  let best = -Infinity;
  let lag = 0;
  for (let k = xc.min; k <= xc.max; k++) {
    if (overlap(k) < need) continue;
    const v = xc.at(k);
    if (v > best) {
      best = v;
      lag = k;
    }
  }
  if (!Number.isFinite(best)) return null;
  const exclude = Math.round(PEAK_EXCLUDE_S / ENV_HOP_S);
  let second = -Infinity;
  for (let k = xc.min; k <= xc.max; k++) {
    if (Math.abs(k - lag) <= exclude || overlap(k) < need) continue;
    second = Math.max(second, xc.at(k));
  }
  const confidence =
    best <= 0 ? 0 : second <= 0 ? CONFIDENCE_CAP : Math.min(CONFIDENCE_CAP, best / second);
  return { lag, confidence };
}

/**
 * The fine pass: `camera` and `recording` are waveforms at `SYNC_RATE`, the
 * recording starting `reach` samples earlier than where the coarse pass put
 * the camera's first sample and running `reach` samples longer. Returns the
 * shift, in samples, that lines them up best (negative = the recording sits
 * earlier than the coarse answer), or null when no shift stands out. Polarity
 * is ignored: two microphones can face the source from opposite sides.
 */
function fineSync(camera: Float32Array, recording: Float32Array, reach: number): number | null {
  if (camera.length < 64 || recording.length < camera.length + 2 * reach) return null;
  const xc = crossCorrelate(camera, recording);
  let best = -1;
  let at = 0;
  for (let k = 0; k <= 2 * reach; k++) {
    const v = Math.abs(xc.at(k));
    if (v > best) {
      best = v;
      at = k;
    }
  }
  // The runner-up outside the peak's own cycle, a millisecond either side.
  const exclude = Math.round(SYNC_RATE / 1000);
  let second = 0;
  for (let k = 0; k <= 2 * reach; k++) {
    if (Math.abs(k - at) <= exclude) continue;
    second = Math.max(second, Math.abs(xc.at(k)));
  }
  if (!(best > 0) || best < second * 1.05) return null;
  return at - reach;
}

/** The loudest `seconds` of a signal at `SYNC_RATE`, by hop energy: where the
 * fine pass has the most to compare. Returns the first sample. */
function loudestStretch(mono: Float32Array, seconds: number): number {
  const len = Math.min(mono.length, Math.round(seconds * SYNC_RATE));
  if (len >= mono.length) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += mono[i] * mono[i];
  let best = sum;
  let at = 0;
  // Slide a hop at a time; exact enough and cheap.
  for (let s = ENV_HOP; s + len <= mono.length; s += ENV_HOP) {
    for (let i = s - ENV_HOP; i < s; i++) sum -= mono[i] * mono[i];
    for (let i = s + len - ENV_HOP; i < s + len; i++) sum += mono[i] * mono[i];
    if (sum > best) {
      best = sum;
      at = s;
    }
  }
  return at;
}

export interface SyncAnswer {
  /** Recording seconds = camera seconds + offset. */
  offset: number;
  confidence: number;
  /** Whether the fine pass put the offset on the sample; false leaves it at
   * the coarse pass's 20 ms grain. */
  refined: boolean;
}

/** Decoded audio of any rate and channel count, chunk by chunk, starting at
 * `timestamp` source seconds. */
export interface SyncChunk {
  channels: Float32Array[];
  timestamp: number;
  sampleRate: number;
}

/** Reads a span of each file's sound, wherever it lives. */
interface SyncReader {
  camera: (from: number, to: number) => AsyncIterable<SyncChunk>;
  recording: (from: number, to: number) => AsyncIterable<SyncChunk>;
}

/** A span folded to mono at `SYNC_RATE`, with the source second its first
 * sample sits at. */
async function monoOf(chunks: AsyncIterable<SyncChunk>, seconds: number) {
  const fold = new MonoResampler(seconds);
  let start: number | null = null;
  for await (const c of chunks) {
    start ??= c.timestamp;
    fold.push(c.channels, c.sampleRate);
  }
  return { mono: fold.samples(), start: start ?? 0 };
}

/**
 * Both passes over two files read as they stream: `cameraFrom..cameraTo` of
 * the camera (the stretch whose sound is matched), the recording's first
 * `recordingTo` seconds as an envelope only, and then the few seconds of the
 * recording the fine pass needs. Memory holds the camera's stretch, the
 * recording's envelope, and one chunk.
 */
export async function syncSound(
  read: SyncReader,
  opts: { cameraFrom: number; cameraTo: number; recordingTo: number }
): Promise<SyncAnswer | null> {
  const cam = await monoOf(read.camera(opts.cameraFrom, opts.cameraTo), opts.cameraTo - opts.cameraFrom);
  if (cam.mono.length < SYNC_RATE) return null;
  const fold = new MonoResampler(10);
  const env = new EnvelopeBuilder(opts.recordingTo);
  let recStart: number | null = null;
  for await (const c of read.recording(0, opts.recordingTo)) {
    recStart ??= c.timestamp;
    fold.push(c.channels, c.sampleRate);
    fold.drain((m) => env.push(m));
  }
  const coarse = coarseSync(envelopeOf(cam.mono), env.envelope());
  if (!coarse) return null;
  const offset = (recStart ?? 0) - cam.start + coarse.lag * ENV_HOP_S;
  // The fine pass: the camera's loudest few seconds against the recording
  // around where the coarse pass put them.
  const reach = Math.round(FINE_REACH_S * SYNC_RATE);
  const from = loudestStretch(cam.mono, FINE_SECONDS);
  const piece = cam.mono.subarray(from, from + Math.round(FINE_SECONDS * SYNC_RATE));
  const at = cam.start + from / SYNC_RATE + offset - reach / SYNC_RATE;
  const window = Math.max(0, at - 0.25);
  const rec = await monoOf(read.recording(window, at + (piece.length + 2 * reach) / SYNC_RATE + 0.25), FINE_SECONDS + 1);
  const recAt = Math.round((at - rec.start) * SYNC_RATE);
  const shift =
    recAt >= 0 && recAt + piece.length + 2 * reach <= rec.mono.length
      ? fineSync(piece, rec.mono.subarray(recAt, recAt + piece.length + 2 * reach), reach)
      : null;
  return {
    offset: shift === null ? offset : offset + shift / SYNC_RATE,
    confidence: coarse.confidence,
    refined: shift !== null,
  };
}
