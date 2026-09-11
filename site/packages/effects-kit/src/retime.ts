/**
 * Retiming: how a clip's footage maps onto the timeline.
 *
 * A clip plays its source span `[in, out]` at a rate. The rate is one number
 * (`speed`) or a curve — nodes of `[source second, rate]` joined by the same
 * monotone spline the tone curves use, holding flat past the first and last
 * node. Nodes live in source seconds, so trimming a clip or splitting it never
 * moves them: the footage keeps the pace it was given at every moment of it.
 *
 * Everything that turns a timeline second into a source second (the preview,
 * the exports, the filmstrip, the trim handles, the assistant's context) reads
 * this one map. The uniform case is closed form and costs nothing; a curve is
 * integrated once and memoized on its inputs.
 */

import { monotoneCubic } from "./monotone";

/** One node of a speed curve: the source second it sits on, and the rate there. */
export type SpeedNode = [number, number];

export const SPEED_CURVE_MIN = 0.1;
export const SPEED_CURVE_MAX = 10;

export interface Retimable {
  in: number;
  out: number;
  speed?: number;
  speedCurve?: SpeedNode[];
  /** The span plays backward: the head of the clip shows `out`, the tail
   * shows `in`. The rate (one number or a curve) still describes the footage
   * in source seconds, so the footprint is the same either way. */
  reverse?: boolean;
}

export interface Retime {
  in: number;
  out: number;
  /** Timeline seconds the span plays in. */
  len: number;
  /** One rate across the span (no curve). */
  uniform: boolean;
  /** The uniform rate, or the span's average rate under a curve. */
  rate: number;
  /** Source seconds fall as timeline seconds rise. */
  reverse: boolean;
  /** Timeline offset from the span's head → absolute source second. Linear
   * past either end at the edge rate, so a handle reaching outside the span
   * maps like the footage beside it. Falls with `tLocal` on a reversed span. */
  srcAt(tLocal: number): number;
  /** Absolute source second → timeline offset from the span's head. */
  tAt(src: number): number;
  /** Rate at a timeline offset. */
  rateAt(tLocal: number): number;
  /** Rate at a source second. */
  rateAtSrc(src: number): number;
  /** The map as a reduced polyline of `[source seconds past in, timeline
   * seconds past the head]`, ascending in source, first knot `[0, 0]`, last
   * `[out − in, len]`. On a reversed span the timeline column runs the other
   * way: first `[0, len]`, last `[out − in, 0]`. Renderers that cannot call
   * a function (an ffmpeg expression) read this. */
  knots: [number, number][];
  /** Fingerprint of everything the map depends on. */
  key: string;
}

const clampRate = (v: number) =>
  v < SPEED_CURVE_MIN ? SPEED_CURVE_MIN : v > SPEED_CURVE_MAX ? SPEED_CURVE_MAX : v;

/** A clip's curve, cleaned: finite nodes, rates in range, ascending by source
 * second, one node per moment. Undefined when the clip carries no usable
 * curve. */
export function speedCurveOf(c: { speedCurve?: SpeedNode[] }): SpeedNode[] | undefined {
  const raw = c.speedCurve;
  if (!raw || raw.length === 0) return undefined;
  const nodes = raw
    .filter((n) => Array.isArray(n) && Number.isFinite(n[0]) && Number.isFinite(n[1]))
    .map((n): SpeedNode => [n[0], clampRate(n[1])])
    .sort((a, b) => a[0] - b[0]);
  const out: SpeedNode[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - n[0]) < 1e-4) out[out.length - 1] = n;
    else out.push(n);
  }
  return out.length ? out : undefined;
}

export const hasSpeedCurve = (c: { speedCurve?: SpeedNode[] }) => !!speedCurveOf(c);

/** The rate function of a curve over source seconds. */
export function speedCurveRate(nodes: SpeedNode[]): (src: number) => number {
  const at = monotoneCubic(
    nodes.map((n) => n[0]),
    nodes.map((n) => n[1])
  );
  return (src) => clampRate(at(src));
}

/** Samples per source second the integral is taken at. */
const SAMPLES_PER_S = 120;
const MIN_SAMPLES = 32;
const MAX_SAMPLES = 8192;
/** Samples the integral takes over a span of source seconds. */
const sampleCount = (span: number) =>
  Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round(Math.max(0, span) * SAMPLES_PER_S)));

/** Knot tolerance, timeline seconds: a quarter of a 60 fps frame. */
const KNOT_EPS = 1 / 240;

const memo = new Map<string, Retime>();
const MEMO_CAP = 256;
/** The memo's ceiling in bytes. A curved entry holds three sample tables, so
 * counting entries alone would let a session of trimming hold tens of
 * megabytes; the tables are what the cap is about. */
const MEMO_BYTES = 8 << 20;
const memoBytes = new Map<string, number>();
let memoHeld = 0;

const uniformRate = (c: { speed?: number }) => (c.speed && c.speed > 0 ? c.speed : 1);

function uniformRetime(inS: number, outS: number, rate: number, key: string): Retime {
  const len = Math.max(0, outS - inS) / rate;
  return {
    in: inS,
    out: outS,
    len,
    uniform: true,
    rate,
    reverse: false,
    srcAt: (t) => inS + t * rate,
    tAt: (s) => (s - inS) / rate,
    rateAt: () => rate,
    rateAtSrc: () => rate,
    knots: [
      [0, 0],
      [Math.max(0, outS - inS), len],
    ],
    key,
  };
}

/** Douglas–Peucker on a monotone polyline, keeping both ends. */
function reduceKnots(xs: Float64Array, ys: Float64Array, eps: number): [number, number][] {
  const n = xs.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const dx = xs[b] - xs[a];
    const dy = ys[b] - ys[a];
    let worst = -1;
    let worstD = eps;
    for (let i = a + 1; i < b; i++) {
      const t = dx === 0 ? 0 : (xs[i] - xs[a]) / dx;
      const d = Math.abs(ys[i] - (ys[a] + dy * t));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push([xs[i], ys[i]]);
  return out;
}

function curvedRetime(inS: number, outS: number, nodes: SpeedNode[], key: string): Retime {
  const span = Math.max(0, outS - inS);
  const rate = speedCurveRate(nodes);
  const n = sampleCount(span);
  const ds = span / n;
  const srcs = new Float64Array(n + 1);
  const ts = new Float64Array(n + 1);
  let prevInv = 1 / rate(inS);
  srcs[0] = inS;
  for (let k = 1; k <= n; k++) {
    const s = inS + k * ds;
    const inv = 1 / rate(s);
    srcs[k] = s;
    ts[k] = ts[k - 1] + ds * 0.5 * (prevInv + inv);
    prevInv = inv;
  }
  const len = ts[n];
  const rateIn = rate(inS);
  const rateOut = rate(outS);
  const lookup = (table: Float64Array, v: number) => {
    // Largest index whose value is <= v.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, n - 1);
  };
  const srcAt = (t: number) => {
    if (t <= 0) return inS + t * rateIn;
    if (t >= len) return outS + (t - len) * rateOut;
    const k = lookup(ts, t);
    const w = ts[k + 1] - ts[k];
    const f = w > 0 ? (t - ts[k]) / w : 0;
    return srcs[k] + f * ds;
  };
  const tAt = (s: number) => {
    if (s <= inS) return (s - inS) / rateIn;
    if (s >= outS) return len + (s - outS) / rateOut;
    const k = Math.min(n - 1, Math.max(0, Math.floor((s - inS) / ds)));
    const f = (s - srcs[k]) / ds;
    return ts[k] + f * (ts[k + 1] - ts[k]);
  };
  const rel = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) rel[k] = srcs[k] - inS;
  return {
    in: inS,
    out: outS,
    len,
    uniform: false,
    rate: len > 0 ? span / len : rateIn,
    reverse: false,
    srcAt,
    tAt,
    rateAt: (t) => rate(srcAt(t)),
    rateAtSrc: rate,
    knots: reduceKnots(rel, ts, KNOT_EPS),
    key,
  };
}

/** The forward map turned around: the head of the span plays `out`, the tail
 * plays `in`, and every timeline offset reads the forward map at `len − t`.
 * The footprint, the average rate and the rate at each source second are the
 * forward span's own. */
function reversedRetime(f: Retime, key: string): Retime {
  const len = f.len;
  return {
    in: f.in,
    out: f.out,
    len,
    uniform: f.uniform,
    rate: f.rate,
    reverse: true,
    srcAt: (t) => f.srcAt(len - t),
    tAt: (s) => len - f.tAt(s),
    rateAt: (t) => f.rateAt(len - t),
    rateAtSrc: f.rateAtSrc,
    knots: f.knots.map(([x, y]): [number, number] => [x, len - y]),
    key,
  };
}

/** The retime of a clip's span, memoized on everything it depends on. */
export function retimeOf(c: Retimable): Retime {
  const nodes = speedCurveOf(c);
  const fwdKey = nodes
    ? `${c.in.toFixed(4)}|${c.out.toFixed(4)}|${nodes.map((nd) => `${nd[0].toFixed(4)}:${nd[1].toFixed(4)}`).join(",")}`
    : `${c.in}|${c.out}|u${uniformRate(c)}`;
  const key = c.reverse ? `${fwdKey}|r` : fwdKey;
  const hit = memo.get(key);
  if (hit) return hit;
  const forward = nodes
    ? curvedRetime(c.in, c.out, nodes, fwdKey)
    : uniformRetime(c.in, c.out, uniformRate(c), fwdKey);
  const built = c.reverse ? reversedRetime(forward, key) : forward;
  memo.set(key, built);
  // Three Float64 tables per curved entry, plus the knots it kept.
  const bytes = nodes ? (built.knots.length + 1) * 16 + sampleCount(c.out - c.in) * 24 : 128;
  memoBytes.set(key, bytes);
  memoHeld += bytes;
  while (memo.size > MEMO_CAP || memoHeld > MEMO_BYTES) {
    const oldest = memo.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    memo.delete(oldest);
    memoHeld -= memoBytes.get(oldest) ?? 0;
    memoBytes.delete(oldest);
  }
  return built;
}

/** Timeline seconds a clip occupies. */
export const retimeLen = (c: Retimable) => retimeOf(c).len;

/** The source second at the head of a span: `in`, or `out` when it plays
 * backward. */
export const headSrc = (c: Pick<Retimable, "in" | "out" | "reverse">) => (c.reverse ? c.out : c.in);
/** The source second at the tail of a span: `out`, or `in` when it plays
 * backward. */
export const tailSrc = (c: Pick<Retimable, "in" | "out" | "reverse">) => (c.reverse ? c.in : c.out);

/** The source seconds a timeline window `[tFrom, tTo]` of the map reads,
 * low end first whichever way the map runs. */
export function srcSpan(rt: Retime, tFrom: number, tTo: number): { lo: number; hi: number } {
  const a = rt.srcAt(tFrom);
  const b = rt.srcAt(tTo);
  return a <= b ? { lo: a, hi: b } : { lo: b, hi: a };
}

/** Rate below which a smoothed clip synthesizes frames. Exactly 1× shows
 * every source frame once; only a slower stretch repeats them. */
export const SLOW_RATE = 1 - 1e-3;

/** Whether a clip's picture is synthesized at timeline offset `tLocal`: the
 * clip smooths its slow motion, and the map runs slower than 1× there. */
export const smoothsAt = (c: { smoothSlow?: boolean }, rt: Retime, tLocal: number) =>
  !!c.smoothSlow && rt.rateAt(tLocal) < SLOW_RATE;

/**
 * The stretches of a span, in timeline seconds from its head, where the map
 * runs slower than 1×: `[from, to]` pairs, ascending, sampled every `step`
 * seconds (an output frame) with runs shorter than two samples dropped. A
 * uniform slow span is one run over its whole length; a curve that dips and
 * recovers gives one run per dip. A renderer that cannot ask the rate per
 * frame (an ffmpeg graph) interpolates exactly these.
 */
export function slowRuns(rt: Retime, step: number): [number, number][] {
  const runs: [number, number][] = [];
  if (!(step > 0) || rt.len <= 0) return runs;
  if (rt.uniform) return rt.rate < SLOW_RATE ? [[0, rt.len]] : runs;
  let open: number | null = null;
  const n = Math.ceil(rt.len / step);
  for (let i = 0; i <= n; i++) {
    const t = Math.min(rt.len, i * step);
    const slow = t < rt.len && rt.rateAt(t) < SLOW_RATE;
    if (slow && open === null) open = t;
    else if (!slow && open !== null) {
      if (t - open >= 2 * step - 1e-9) runs.push([open, t]);
      open = null;
    }
  }
  return runs;
}

/**
 * The same span over media that has been turned around: source second `s`
 * of the original sits at `pivot − s` in the turned copy. A reversed clip
 * over the original is a forward clip over the copy, with its curve's nodes
 * carried to the moments they still describe.
 */
export function mirrorRetimable<T extends Retimable>(c: T, pivot: number): T {
  const nodes = speedCurveOf(c);
  return {
    ...c,
    in: pivot - c.out,
    out: pivot - c.in,
    speedCurve: nodes ? nodes.map(([at, rate]): SpeedNode => [pivot - at, rate]).reverse() : undefined,
    reverse: undefined,
  };
}

/** A flat curve at the clip's current rate: four nodes spaced evenly
 * through the span, one on each edge and two between — what a clip starts
 * from when it enters curve editing, with handles already where a ramp
 * usually wants them. */
export function flatSpeedCurve(c: Retimable): SpeedNode[] {
  const rate = clampRate(uniformRate(c));
  const span = Math.max(0, c.out - c.in);
  return [0, 1 / 3, 2 / 3, 1].map((x): SpeedNode => [c.in + x * span, rate]);
}

/* ------------------------------------------------------------------ */
/* Preset ramps                                                        */
/* ------------------------------------------------------------------ */

export interface SpeedCurvePreset {
  id: string;
  label: string;
  /** What the ramp does, for menus and the assistant. */
  hint: string;
  /** Nodes as `[position 0..1 through the span, rate]`. */
  shape: SpeedNode[];
}

/** The fast and slow levels the presets sit on: half a decade either side of
 * 1×, the graph's dashed lines. */
const HI = Math.sqrt(10);
const LO = 1 / Math.sqrt(10);

export const SPEED_CURVE_PRESETS: SpeedCurvePreset[] = [
  {
    id: "flat",
    label: "Flat",
    hint: "one rate across the clip",
    shape: [
      [0, 1],
      [1 / 3, 1],
      [2 / 3, 1],
      [1, 1],
    ],
  },
  {
    id: "rampIn",
    label: "Ramp in",
    hint: "opens fast and eases into slow motion",
    shape: [
      [0, HI],
      [0.35, HI],
      [0.65, LO],
      [1, LO],
    ],
  },
  {
    id: "rampOut",
    label: "Ramp out",
    hint: "opens in slow motion and eases out fast",
    shape: [
      [0, LO],
      [0.35, LO],
      [0.65, HI],
      [1, HI],
    ],
  },
  {
    id: "drift",
    label: "Drift",
    hint: "a rush that sinks into slow motion, then recovers",
    shape: [
      [0, 1],
      [0.25, 1],
      [0.45, HI],
      [0.65, LO],
      [0.85, 1],
      [1, 1],
    ],
  },
  {
    id: "pulse",
    label: "Pulse",
    hint: "two rushes around a slow beat",
    shape: [
      [0, 1],
      [0.15, 1],
      [0.3, HI],
      [0.5, LO],
      [0.7, HI],
      [0.85, 1],
      [1, 1],
    ],
  },
  {
    id: "hold",
    label: "Hold",
    hint: "races in, slows into a moment in the middle, races out",
    shape: [
      [0, HI],
      [0.35, HI],
      [0.5, LO],
      [0.65, HI],
      [1, HI],
    ],
  },
  {
    id: "whip",
    label: "Whip",
    hint: "slow motion with a burst of speed in the middle",
    shape: [
      [0, LO],
      [0.4, LO],
      [0.5, HI],
      [0.6, LO],
      [1, LO],
    ],
  },
  {
    id: "stutter",
    label: "Stutter",
    hint: "alternating rushes and slow beats",
    shape: [
      [0, 1],
      [0.15, HI],
      [0.25, LO],
      [0.4, HI],
      [0.5, LO],
      [0.65, HI],
      [0.75, LO],
      [1, 1],
    ],
  },
];

export const SPEED_CURVE_PRESET_IDS = SPEED_CURVE_PRESETS.map((p) => p.id);

/** A preset laid over a span: its positions become source seconds. */
export function speedCurvePreset(id: string, inS: number, outS: number): SpeedNode[] | undefined {
  const p = SPEED_CURVE_PRESETS.find((x) => x.id === id);
  if (!p) return undefined;
  const span = Math.max(0, outS - inS);
  return p.shape.map(([x, r]): SpeedNode => [inS + x * span, r]);
}

/** The preset a curve is, when it is one: every node sits where the preset
 * puts it through the span, at the preset's rate. */
export function speedCurvePresetOf(nodes: SpeedNode[], inS: number, outS: number): string | undefined {
  const span = Math.max(0, outS - inS);
  if (span <= 0) return undefined;
  // Flat is a rate, not a node count: a curve at 1× everywhere is the Flat
  // preset however many nodes carry it, so one seeded before the preset grew
  // its middle nodes still reads as Flat.
  if (nodes.length >= 2 && nodes.every(([, rate]) => Math.abs(rate - 1) < 1e-3)) return "flat";
  return SPEED_CURVE_PRESETS.find(
    (p) =>
      p.shape.length === nodes.length &&
      p.shape.every(([x, r], i) => {
        const [at, rate] = nodes[i];
        return Math.abs((at - inS) / span - x) < 1e-3 && Math.abs(rate / r - 1) < 1e-3;
      })
  )?.id;
}

/** One line per preset, for the assistant's catalog. */
export const speedCurvePresetCatalogText = () =>
  SPEED_CURVE_PRESETS.map((p) => `${p.id} (${p.hint})`).join("; ");
