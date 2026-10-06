/**
 * Loudness as ITU-R BS.1770-4 and EBU R128 define it, and the mastering that
 * reads it.
 *
 * A level in dBFS answers "how much signal is there". Loudness answers how
 * loud a listener hears it, and the two part ways wherever the energy sits in
 * the spectrum: a bass line and a voice at the same RMS do not sound equally
 * loud. BS.1770 closes that gap with a fixed pre-filter, the K-weighting — a
 * high shelf that lifts what the head boosts above 2 kHz and a high-pass that
 * drops the rumble the ear barely registers — and then measures power.
 *
 * Integrated loudness is the power over the whole programme, measured in
 * 400 ms blocks every 100 ms and gated twice: blocks under −70 LUFS are
 * silence, and blocks more than 10 LU under the loudness of what remains are
 * the pauses between things. What survives is what the listener actually
 * hears as the programme. Loudness range is the spread of the 3 s short-term
 * loudness between its 10th and 95th percentile, after its own gates.
 *
 * True peak is where the waveform goes between the samples. A converter
 * draws a smooth curve through them, and that curve can rise above every
 * sample it passes through; a lossy encoder adds its own overshoot on top. So
 * the peak is read on a 4× oversampled copy, and the limiter holds that peak
 * under its ceiling.
 *
 * Everything here works on plain sample arrays and keeps its state across
 * calls, so the tab can hand it a whole mix and the engine a file read a
 * second at a time, and both reach the same answer.
 */

/** Blocks under this are silence (EBU R128 absolute gate). */
const ABSOLUTE_GATE = -70;
/** Integrated loudness drops blocks this far under the ungated mean. */
const RELATIVE_GATE = -10;
/** Loudness range drops short-term values this far under their mean. */
const RANGE_GATE = -20;
/** The gating step: 100 ms, so a 400 ms block is four steps. */
const STEP_S = 0.1;
const BLOCK_STEPS = 4;
/** Short-term loudness reads 3 s. */
const SHORT_TERM_STEPS = 30;

/** One K-weighting biquad, as a/b with a0 = 1. */
export interface Biquad {
  b: [number, number, number];
  a: [number, number, number];
}

/**
 * The K-weighting pre-filter at `sampleRate`: the high-shelf stage, then the
 * RLB high-pass stage.
 *
 * BS.1770 prints the coefficients for 48 kHz only. The analog prototypes
 * below are the ones those coefficients come from, so the bilinear
 * transform reproduces the printed values at 48 kHz and gives the same
 * response at 44.1 kHz or 96 kHz.
 */
export function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: the high shelf, +4 dB above about 1.7 kHz.
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = 10 ** (gain / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    a: [1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
  // Stage 2: the RLB high-pass at about 38 Hz.
  const f1 = 38.13547087602444;
  const q1 = 0.5003270373238773;
  const k1 = Math.tan((Math.PI * f1) / sampleRate);
  const d = 1 + k1 / q1 + k1 * k1;
  const highpass: Biquad = {
    b: [1, -2, 1],
    a: [1, (2 * (k1 * k1 - 1)) / d, (1 - k1 / q1 + k1 * k1) / d],
  };
  return [shelf, highpass];
}

/** Channel weights for a layout: front channels count once, the surrounds
 * 1.41 (+1.5 dB), and the LFE not at all. Mono and stereo are all ones. */
export function channelWeights(channels: number): number[] {
  // L R C LFE Ls Rs
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41];
  return Array.from({ length: channels }, () => 1);
}

/** Power to LUFS: −0.691 cancels the K-weighting's gain at 997 Hz, so a
 * full-scale sine there reads −3.01 LUFS in one channel. */
const lufs = (power: number) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);
const fromLufs = (l: number) => 10 ** ((l + 0.691) / 10);

/* ------------------------------------------------------- true peak */

/** Half the interpolator's taps: each phase reads this many samples on each
 * side of the point it estimates. */
const HALF_TAPS = 8;
const TAPS = HALF_TAPS * 2;

/** How far the curve between two samples is taken to rise over the louder
 * of them. Audio rises about 3 dB there at the very worst (a quarter-rate
 * tone sampled either side of its crest); twice that is the margin. A point
 * whose neighbours could not reach the peak in hand times this is never
 * interpolated, which is what keeps the meter cheap on a dense mix. */
const OVERSHOOT = 2;

/**
 * The 4× interpolator, as three fractional-delay filters: the values a
 * quarter, a half and three quarters of the way from one sample to the next.
 * The sample itself is the fourth phase. Each filter is a Kaiser-windowed
 * sinc normalized to unity gain at DC.
 */
function interpolatorPhases(factor: number): Float64Array[] {
  const besselI0 = (x: number) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 32; k++) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  const beta = 6;
  const span = HALF_TAPS + 0.5;
  const phases: Float64Array[] = [];
  for (let p = 1; p < factor; p++) {
    const frac = p / factor;
    const taps = new Float64Array(TAPS);
    let total = 0;
    for (let j = 0; j < TAPS; j++) {
      // Tap j reads the sample at offset j - (HALF_TAPS - 1) from the left
      // neighbour of the point, which sits `frac` past it.
      const d = frac - (j - (HALF_TAPS - 1));
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const r = d / span;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / besselI0(beta);
      taps[j] = sinc * w;
      total += taps[j];
    }
    for (let j = 0; j < TAPS; j++) taps[j] /= total;
    phases.push(taps);
  }
  return phases;
}

/** Oversampling that reads a true peak at a rate: 4× up to 96 kHz, 2× to
 * 192 kHz, and the samples themselves above that. */
function oversampling(sampleRate: number): number {
  return sampleRate >= 176400 ? 1 : sampleRate >= 88200 ? 2 : 4;
}

/** The oversampled curve between samples. */
class Interpolator {
  /** Up to three phases' taps; a phase the rate does not use is all zeros
   * and reads as silence, which never wins the peak. */
  private readonly h1: Float64Array;
  private readonly h2: Float64Array;
  private readonly h3: Float64Array;

  constructor(sampleRate: number) {
    const phases = interpolatorPhases(oversampling(sampleRate));
    const zero = new Float64Array(TAPS);
    // 2× has one phase, the midpoint; 4× has three.
    this.h1 = phases.length === 3 ? phases[0] : zero;
    this.h2 = phases.length === 3 ? phases[1] : (phases[0] ?? zero);
    this.h3 = phases.length === 3 ? phases[2] : zero;
  }

  /** The loudest interpolated value between x[i] and x[i + 1], where the
   * window x[i - HALF_TAPS + 1 .. i + HALF_TAPS] is all in range. Every
   * phase is read in one pass over the window. */
  between(x: Float32Array | Float64Array, i: number): number {
    const base = i - (HALF_TAPS - 1);
    const { h1, h2, h3 } = this;
    let y1 = 0;
    let y2 = 0;
    let y3 = 0;
    for (let j = 0; j < TAPS; j++) {
      const v = x[base + j];
      y1 += h1[j] * v;
      y2 += h2[j] * v;
      y3 += h3[j] * v;
    }
    const a1 = y1 < 0 ? -y1 : y1;
    const a2 = y2 < 0 ? -y2 : y2;
    const a3 = y3 < 0 ? -y3 : y3;
    return a1 > a2 ? (a1 > a3 ? a1 : a3) : a2 > a3 ? a2 : a3;
  }
}

/* ------------------------------------------------------- the meter */

/** What a stretch of audio measures. */
export interface LoudnessMeasure {
  /** Gated programme loudness, LUFS; −Infinity when nothing clears the
   * absolute gate. */
  integratedLufs: number;
  /** The loudest point of the waveform, sample or in between, dBTP. */
  truePeakDbtp: number;
  /** The loudest sample, dBFS. */
  samplePeakDbfs: number;
  /** Spread of the short-term loudness, LU (EBU Tech 3342). */
  loudnessRangeLu: number;
  /** The loudest 400 ms block, LUFS. */
  maxMomentaryLufs: number;
  /** The loudest 3 s window, LUFS. */
  maxShortTermLufs: number;
  /** Seconds measured. */
  seconds: number;
}

/**
 * A streaming BS.1770 meter. Push planar chunks of any length; read the
 * result at the end.
 *
 * The weighted power of every 100 ms step is kept — ten numbers a second —
 * and the blocks, the gates and the range are all computed from those at the
 * end, so a chunk boundary can land anywhere without changing the answer.
 */
export class LoudnessMeter {
  private readonly stages: [Biquad, Biquad];
  /** Per channel: the two biquads' state, x1 x2 y1 y2 for each. */
  private readonly state: Float64Array[];
  private readonly weights: number[];
  private readonly stepLength: number;
  private stepPower = 0;
  private stepFill = 0;
  /** Weighted mean square of every finished step. */
  private steps: number[] = [];
  private samples = 0;
  private samplePeak = 0;
  private truePeak = 0;
  private readonly interp: Interpolator;
  /** The last samples of each channel, for interpolating across chunks. */
  private tails: Float32Array[];

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    opts: { weights?: number[] } = {}
  ) {
    this.stages = kWeighting(sampleRate);
    this.state = Array.from({ length: channels }, () => new Float64Array(8));
    this.weights = opts.weights ?? channelWeights(channels);
    this.stepLength = Math.round(sampleRate * STEP_S);
    this.interp = new Interpolator(sampleRate);
    // The stream opens on silence: the first samples interpolate against
    // zeros, the way a converter starting from rest would draw them.
    this.tails = Array.from({ length: channels }, () => new Float32Array(TAPS - 1));
  }

  /** Measure `chunk`: one array per channel, all the same length. */
  push(chunk: ArrayLike<number>[]): void {
    const n = chunk[0]?.length ?? 0;
    if (n === 0) return;
    this.weigh(chunk, n);
    this.peaks(chunk, n);
    this.samples += n;
  }

  private weigh(chunk: ArrayLike<number>[], n: number) {
    const [s1, s2] = this.stages;
    const [p0, p1, p2] = s1.b;
    const [, pa1, pa2] = s1.a;
    const [q0, q1, q2] = s2.b;
    const [, qa1, qa2] = s2.a;
    let offset = 0;
    while (offset < n) {
      const take = Math.min(n - offset, this.stepLength - this.stepFill);
      let power = 0;
      for (let c = 0; c < this.channels; c++) {
        const w = this.weights[c] ?? 1;
        const x = chunk[c];
        const st = this.state[c];
        let [ax1, ax2, ay1, ay2, bx1, bx2, by1, by2] = st;
        let sum = 0;
        for (let i = offset; i < offset + take; i++) {
          const v = x[i];
          const y = p0 * v + p1 * ax1 + p2 * ax2 - pa1 * ay1 - pa2 * ay2;
          ax2 = ax1;
          ax1 = v;
          ay2 = ay1;
          ay1 = y;
          const z = q0 * y + q1 * bx1 + q2 * bx2 - qa1 * by1 - qa2 * by2;
          bx2 = bx1;
          bx1 = y;
          by2 = by1;
          by1 = z;
          sum += z * z;
        }
        st[0] = ax1;
        st[1] = ax2;
        st[2] = ay1;
        st[3] = ay2;
        st[4] = bx1;
        st[5] = bx2;
        st[6] = by1;
        st[7] = by2;
        if (w !== 0) power += w * sum;
      }
      this.stepPower += power;
      this.stepFill += take;
      offset += take;
      if (this.stepFill === this.stepLength) {
        this.steps.push(this.stepPower / this.stepLength);
        this.stepPower = 0;
        this.stepFill = 0;
      }
    }
  }

  private peaks(chunk: ArrayLike<number>[], n: number) {
    const keep = TAPS - 1;
    for (let c = 0; c < this.channels; c++) {
      const x = chunk[c];
      // The window is the previous chunk's tail followed by this chunk, so
      // the points between the two are measured too.
      const ext = new Float32Array(keep + n);
      ext.set(this.tails[c], 0);
      for (let i = 0; i < n; i++) {
        const v = x[i];
        ext[keep + i] = v;
        const a = v < 0 ? -v : v;
        if (a > this.samplePeak) this.samplePeak = a;
      }
      if (this.samplePeak > this.truePeak) this.truePeak = this.samplePeak;
      this.truePeak = Math.max(this.truePeak, scanBetween(this.interp, ext, this.truePeak));
      this.tails[c] = ext.slice(ext.length - keep);
    }
  }

  /** The measurement of everything pushed so far. */
  result(): LoudnessMeasure {
    // The curve past the last samples, as it falls back to rest.
    let truePeak = this.truePeak;
    for (const tail of this.tails) {
      const ext = new Float32Array(tail.length + HALF_TAPS + 1);
      ext.set(tail, 0);
      truePeak = Math.max(truePeak, scanBetween(this.interp, ext, truePeak));
    }
    const steps = this.steps;
    const blocks: number[] = [];
    for (let j = 0; j + BLOCK_STEPS <= steps.length; j++) {
      let p = 0;
      for (let k = 0; k < BLOCK_STEPS; k++) p += steps[j + k];
      blocks.push(p / BLOCK_STEPS);
    }
    const shortTerm: number[] = [];
    for (let j = 0; j + SHORT_TERM_STEPS <= steps.length; j++) {
      let p = 0;
      for (let k = 0; k < SHORT_TERM_STEPS; k++) p += steps[j + k];
      shortTerm.push(p / SHORT_TERM_STEPS);
    }
    return {
      integratedLufs: integratedFrom(blocks),
      truePeakDbtp: 20 * Math.log10(truePeak || 1e-10),
      samplePeakDbfs: 20 * Math.log10(this.samplePeak || 1e-10),
      loudnessRangeLu: rangeFrom(shortTerm),
      maxMomentaryLufs: lufs(blocks.reduce((m, p) => (p > m ? p : m), 0)),
      maxShortTermLufs: lufs(shortTerm.reduce((m, p) => (p > m ? p : m), 0)),
      seconds: this.samples / this.sampleRate,
    };
  }
}

/** The loudest point between samples in `x` that could beat `floor`. Points
 * whose window cannot reach it are never interpolated. */
function scanBetween(interp: Interpolator, x: Float32Array, floor: number): number {
  let peak = floor;
  const first = HALF_TAPS - 1;
  const last = x.length - HALF_TAPS - 1;
  for (let i = first; i <= last; i++) {
    const a = x[i] < 0 ? -x[i] : x[i];
    const b = x[i + 1] < 0 ? -x[i + 1] : x[i + 1];
    if ((a > b ? a : b) * OVERSHOOT <= peak) continue;
    const v = interp.between(x, i);
    if (v > peak) peak = v;
  }
  return peak;
}

/** Integrated loudness from block powers: the absolute gate, then the
 * relative gate 10 LU under what the absolute gate kept. */
export function integratedFrom(blocks: number[]): number {
  const abs = fromLufs(ABSOLUTE_GATE);
  const loud = blocks.filter((p) => p > abs);
  if (loud.length === 0) return -Infinity;
  const ungated = loud.reduce((s, p) => s + p, 0) / loud.length;
  const rel = fromLufs(lufs(ungated) + RELATIVE_GATE);
  const kept = loud.filter((p) => p > rel);
  if (kept.length === 0) return -Infinity;
  return lufs(kept.reduce((s, p) => s + p, 0) / kept.length);
}

/** Loudness range from short-term powers (EBU Tech 3342): gate at −70 LUFS
 * and 20 LU under the mean, then the 10th to the 95th percentile. */
export function rangeFrom(shortTerm: number[]): number {
  const abs = fromLufs(ABSOLUTE_GATE);
  const loud = shortTerm.filter((p) => p > abs);
  if (loud.length === 0) return 0;
  const mean = loud.reduce((s, p) => s + p, 0) / loud.length;
  const rel = fromLufs(lufs(mean) + RANGE_GATE);
  const kept = loud
    .filter((p) => p > rel)
    .map(lufs)
    .sort((a, b) => a - b);
  if (kept.length === 0) return 0;
  const at = (q: number) => {
    const pos = q * (kept.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(kept.length - 1, lo + 1);
    return kept[lo] + (kept[hi] - kept[lo]) * (pos - lo);
  };
  return at(0.95) - at(0.1);
}

/** Measure whole planar buffers in one go. */
export function measureLoudness(channels: ArrayLike<number>[], sampleRate: number): LoudnessMeasure {
  const meter = new LoudnessMeter(sampleRate, channels.length);
  meter.push(channels);
  return meter.result();
}

/** `measureLoudness` in half-second slices with a yield between them, for a
 * whole mix measured on the page's thread. */
export async function measureLoudnessSliced(channels: Float32Array[], sampleRate: number): Promise<LoudnessMeasure> {
  const meter = new LoudnessMeter(sampleRate, channels.length);
  const slice = Math.max(1, Math.round(sampleRate / 2));
  const length = channels[0]?.length ?? 0;
  for (let i = 0; i < length; i += slice) {
    meter.push(channels.map((c) => c.subarray(i, Math.min(length, i + slice))));
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  return meter.result();
}

/** A measurement rounded for a reply: two decimals, and null where there is
 * no number (silence has no integrated loudness). */
export function roundedLoudness(m: LoudnessMeasure) {
  const r = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  return {
    integratedLufs: r(m.integratedLufs),
    truePeakDbtp: r(m.truePeakDbtp),
    loudnessRangeLu: r(m.loudnessRangeLu),
    maxShortTermLufs: r(m.maxShortTermLufs),
  };
}

/* ------------------------------------------------------- mastering */

/** What a master does to a mix: one static gain, and the limiter only when
 * the gained mix would cross the ceiling. */
export interface MasterPlan {
  gainDb: number;
  limit: boolean;
  /** The true peak the gain alone would leave, dBTP. */
  peakAfterGainDbtp: number;
}

/**
 * Plan a master from a measurement. Silence has no loudness to move, so it
 * keeps its level; anything else moves by exactly the distance to the
 * target, and the limiter runs only where that gain carries the true peak
 * past the ceiling.
 */
export function masterPlan(measured: LoudnessMeasure, targetLufs: number, ceilingDbtp: number): MasterPlan {
  const gainDb = Number.isFinite(measured.integratedLufs) ? targetLufs - measured.integratedLufs : 0;
  const peakAfterGainDbtp = measured.truePeakDbtp + gainDb;
  return { gainDb, limit: peakAfterGainDbtp > ceilingDbtp, peakAfterGainDbtp };
}

/** How long the limiter looks ahead, and so how long it takes to reach a
 * reduction: long enough that the gain glides down, short enough that a
 * transient does not pull the sound before it audibly early. */
const LOOKAHEAD_S = 0.005;
/** How quickly the reduction lets go, as a time constant. Long enough to
 * avoid the flutter a fast release makes on bass, short enough that the mix
 * does not sit audibly lower after a hit. */
const RELEASE_S = 0.12;
/** Headroom kept under the ceiling for the small error between the gain the
 * limiter applies and the curve it predicts. */
const CEILING_MARGIN_DB = 0.05;

/**
 * A look-ahead true-peak limiter, linked across channels.
 *
 * For every sample it works out the gain that would keep the loudest point
 * near it — the sample, or the interpolated curve on either side — under the
 * ceiling. The gain it applies is that requirement held over the look-ahead
 * window, let go on an exponential release, and averaged over the window
 * again. Every held value that goes into a sample's average is no more than
 * that sample's requirement, so the average is no more than it either and the
 * ceiling holds; and the averaging is what makes the gain glide instead of
 * stepping, which is the difference between limiting and clipping.
 *
 * The output runs `latency` samples behind the input. `process` returns what
 * is ready and `flush` the rest, so the total comes out the same length as
 * what went in and lines up with it sample for sample.
 */
export class TruePeakLimiter {
  readonly latency: number;
  private readonly window: number;
  private readonly ceiling: number;
  private readonly release: number;
  private readonly interp: Interpolator;
  /** Input history per channel: long enough to interpolate and to delay. */
  private readonly hist: Float64Array[];
  /** The loudest channel's |x| per sample, on the same ring. */
  private readonly loudest: Float64Array;
  private readonly histMask: number;
  /** Samples fed (real and the flush's padding), real ones received, and
   * samples handed back. */
  private fed = 0;
  private received = 0;
  private emitted = 0;
  /** Required gains, a monotonic deque over them for the forward minimum,
   * and the held gains the running average reads: rings by sample index. */
  private readonly need: Float64Array;
  private readonly dq: Int32Array;
  private dqHead = 0;
  private dqTail = 0;
  private readonly held: Float64Array;
  private readonly ringMask: number;
  private heldSum: number;
  private lastHeld = 1;
  /** The interpolated peak just before the position being decided. */
  private betweenPrev = 0;
  private readonly scratch = new Float64Array(TAPS);

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    ceilingDbtp: number
  ) {
    this.window = Math.max(1, Math.round(LOOKAHEAD_S * sampleRate));
    this.ceiling = 10 ** ((ceilingDbtp - CEILING_MARGIN_DB) / 20);
    this.release = Math.exp(-1 / (RELEASE_S * sampleRate));
    this.interp = new Interpolator(sampleRate);
    // A position is decided once the interpolator can see HALF_TAPS past it,
    // and a sample's gain settles once the window after it is decided.
    this.latency = HALF_TAPS + this.window - 1;
    const histLen = 1 << Math.ceil(Math.log2(this.latency + TAPS + 2));
    this.histMask = histLen - 1;
    this.hist = Array.from({ length: channels }, () => new Float64Array(histLen));
    this.loudest = new Float64Array(histLen);
    const ring = 1 << Math.ceil(Math.log2(this.window + 2));
    this.ringMask = ring - 1;
    this.need = new Float64Array(ring);
    this.dq = new Int32Array(ring);
    // The gains before the first sample are unity.
    this.held = new Float64Array(ring).fill(1);
    this.heldSum = this.window;
  }

  /** Feed planar input; returns the planar output that is ready. */
  process(input: ArrayLike<number>[]): Float32Array[] {
    const n = input[0]?.length ?? 0;
    const out = Array.from({ length: this.channels }, () => new Float32Array(n));
    let w = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) this.hist[c][this.fed & this.histMask] = input[c][i];
      this.received++;
      w = this.advance(out, w);
    }
    return w === n ? out : out.map((o) => o.subarray(0, w));
  }

  /** The output the look-ahead is still holding. */
  flush(): Float32Array[] {
    const left = this.received - this.emitted;
    const out = Array.from({ length: this.channels }, () => new Float32Array(left));
    let w = 0;
    // Silence past the end lets every held sample through.
    while (this.emitted < this.received) {
      for (let c = 0; c < this.channels; c++) this.hist[c][this.fed & this.histMask] = 0;
      w = this.advance(out, w);
    }
    return out.map((o) => o.subarray(0, w));
  }

  /** Take in the sample just written at `fed`, decide what it unlocks, and
   * emit the sample whose gain settled. */
  private advance(out: Float32Array[], w: number): number {
    const t = this.fed++;
    const m = this.histMask;
    let loud = 0;
    for (let c = 0; c < this.channels; c++) {
      const v = this.hist[c][t & m];
      const a = v < 0 ? -v : v;
      if (a > loud) loud = a;
    }
    this.loudest[t & m] = loud;
    const pos = t - HALF_TAPS;
    if (pos < 0) return w;
    const s = this.decide(pos);
    if (s < 0 || s >= this.received) return w;
    const g = this.heldSum / this.window;
    for (let c = 0; c < this.channels; c++) out[c][w] = this.hist[c][s & m] * g;
    this.emitted++;
    return w + 1;
  }

  /** Decide the requirement at `pos` and settle the held gain of the sample
   * a window before it, which is returned (negative while none has). */
  private decide(pos: number): number {
    const m = this.histMask;
    const near = Math.max(this.loudest[pos & m], this.loudest[(pos + 1) & m]);
    // The curve between pos and pos + 1, read only where it could reach the
    // ceiling.
    let between = 0;
    if (near * OVERSHOOT > this.ceiling) {
      const x = this.scratch;
      for (let c = 0; c < this.channels; c++) {
        for (let j = 0; j < TAPS; j++) {
          const i = pos - (HALF_TAPS - 1) + j;
          x[j] = i >= 0 ? this.hist[c][i & m] : 0;
        }
        const v = this.interp.between(x, HALF_TAPS - 1);
        if (v > between) between = v;
      }
    }
    const peak = Math.max(this.loudest[pos & m], between, this.betweenPrev);
    this.betweenPrev = between;
    const need = peak > this.ceiling ? this.ceiling / peak : 1;

    // The forward minimum of the requirement over [s, s + window - 1].
    const r = this.ringMask;
    this.need[pos & r] = need;
    while (this.dqTail > this.dqHead && this.need[this.dq[(this.dqTail - 1) & r] & r] >= need) this.dqTail--;
    this.dq[this.dqTail++ & r] = pos;
    const s = pos - this.window + 1;
    while (this.dq[this.dqHead & r] < s) this.dqHead++;
    if (s < 0) return s;
    const hold = this.need[this.dq[this.dqHead & r] & r];
    // Let go exponentially, never above what the window demands.
    const g = Math.min(hold, 1 - (1 - this.lastHeld) * this.release);
    this.lastHeld = g;
    if (s === 0) {
      // Nothing plays before the first sample, so the average leading into
      // it starts at the first sample's own held gain: a unity run there
      // would let the opening peaks through.
      this.held.fill(g);
      this.heldSum = this.window * g;
    } else {
      this.heldSum += g - this.held[(s - this.window) & r];
      this.held[s & r] = g;
    }
    return s;
  }
}

/** What a master did. */
export interface MasterReport {
  /** The mix as it came in. */
  measured: LoudnessMeasure;
  plan: MasterPlan;
}

/**
 * Master a stream of planar chunks to `targetLufs` under `ceilingDbtp`.
 *
 * Two reads of the same audio: the first measures it, the second applies the
 * gain and, only when the plan calls for it, the limiter. `chunks` is called
 * once per read; `write` receives the mastered audio in order, the same
 * number of samples as went in. The tab hands it its mix buffer a slice at a
 * time and the engine its rendered mix a second at a time, so both run this
 * exact code.
 */
export async function masterStream(
  chunks: () => AsyncIterable<Float32Array[]>,
  write: (chunk: Float32Array[]) => Promise<void> | void,
  opts: { sampleRate: number; channels: number; targetLufs: number; ceilingDbtp: number }
): Promise<MasterReport> {
  const meter = new LoudnessMeter(opts.sampleRate, opts.channels);
  for await (const chunk of chunks()) meter.push(chunk);
  const measured = meter.result();
  const plan = masterPlan(measured, opts.targetLufs, opts.ceilingDbtp);
  const gain = 10 ** (plan.gainDb / 20);
  const limiter = plan.limit ? new TruePeakLimiter(opts.sampleRate, opts.channels, opts.ceilingDbtp) : null;
  for await (const chunk of chunks()) {
    const gained = chunk.map((x) => {
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = x[i] * gain;
      return y;
    });
    const out = limiter ? limiter.process(gained) : gained;
    if (out[0].length > 0) await write(out);
  }
  if (limiter) {
    const rest = limiter.flush();
    if (rest[0].length > 0) await write(rest);
  }
  return { measured, plan };
}

/** Master planar buffers in place; see `masterStream`. Reads and writes in
 * half-second slices and yields between them, so a long mix never holds the
 * thread for the whole of it. */
export async function masterInPlace(
  channels: Float32Array[],
  opts: { sampleRate: number; targetLufs: number; ceilingDbtp: number }
): Promise<MasterReport> {
  const slice = Math.max(1, Math.round(opts.sampleRate / 2));
  const length = channels[0]?.length ?? 0;
  const pause = () => new Promise<void>((r) => setTimeout(r, 0));
  let at = 0;
  return masterStream(
    async function* () {
      for (let i = 0; i < length; i += slice) {
        // A copy: the limiter's writes land behind the read, on the same
        // arrays.
        yield channels.map((c) => c.slice(i, Math.min(length, i + slice)));
        await pause();
      }
    },
    (chunk) => {
      chunk.forEach((c, k) => channels[k].set(c, at));
      at += chunk[0].length;
    },
    { ...opts, channels: channels.length }
  );
}

