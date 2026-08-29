/**
 * Time-ranged audio effects — the sound's side of the effect elements.
 *
 * A visual effect filters the picture under its stretch of timeline; an audio
 * effect filters the mix under it: everything audible in that window, clip
 * sound, upper-track sound and soundtrack alike, treated as one.
 *
 * Each effect is one declarative recipe (`AudioFxRecipe`) that three renderers
 * read: the Web Audio graph the preview plays and the in-tab export folds, the
 * ffmpeg chain the engine and the cloud worker splice into their mix, and the
 * bar figures the picker tiles animate. Describing the effect as data instead
 * of as three hand-written chains is what keeps those three the same sound —
 * a delay tap moved here moves in every renderer at once.
 *
 * Every ffmpeg filter used is in the LGPL build the shipped engine bundles.
 */

/** Delay-and-filter recipes cover every effect here; the ids name the sound. */
export type AudioEffectId =
  | "echo"
  | "reverb"
  | "muffle"
  | "telephone"
  | "deep"
  | "bright"
  | "wobble"
  | "crush";

export const AUDIO_EFFECT_IDS: AudioEffectId[] = [
  "echo",
  "reverb",
  "muffle",
  "telephone",
  "deep",
  "bright",
  "wobble",
  "crush",
];

export const AUDIO_EFFECT_LABELS: Record<AudioEffectId, string> = {
  echo: "Echo",
  reverb: "Reverb",
  muffle: "Muffle",
  telephone: "Telephone",
  deep: "Deep",
  bright: "Bright",
  wobble: "Wobble",
  crush: "Crush",
};

export const isAudioEffect = (id: string): id is AudioEffectId =>
  (AUDIO_EFFECT_IDS as string[]).includes(id);

/** One two-pole section. Shelves and peaks carry a decibel gain; the passes
 * carry none. The names are the Web Audio filter types, and each maps to the
 * ffmpeg filter of the same shape. */
export interface AudioBandSpec {
  type: "lowpass" | "highpass" | "lowshelf" | "highshelf" | "peaking";
  hz: number;
  /** Resonance; absent = 0.707, the flat Butterworth response ffmpeg's
   * two-pole passes have. */
  q?: number;
  /** Shelf or peak gain in decibels. */
  db?: number;
}

/** Downward compression: everything over `thresholdDb` is pulled toward it
 * by `ratio`, reacting over `attackMs` and letting go over `releaseMs`. */
export interface AudioCompressorSpec {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
}

/**
 * What an audio effect does, in the terms both renderers can build.
 *
 * The delay taps are a finite echo: the dry signal plus each tap's delayed
 * copy at its own gain, which is exactly what ffmpeg's `aecho` computes, so
 * one description drives both. Bands, tremolo, bit crush, the compressor, the
 * limiter and makeup gain run after the taps, in that order.
 */
export interface AudioFxRecipe {
  /** Gain on the untreated signal that the taps are added to. */
  dry: number;
  /** Delayed copies, in milliseconds and gain. */
  taps: { ms: number; gain: number }[];
  /** Filter sections applied in order. */
  bands: AudioBandSpec[];
  /** Amplitude modulation: rate in Hz, depth 0..1. */
  tremolo?: { hz: number; depth: number };
  /** Bit-depth reduction, and how much of the crushed signal is heard. */
  crush?: { bits: number; mix: number };
  /** Level control after the filters. */
  compressor?: AudioCompressorSpec;
  /** A ceiling in dBFS the signal is held under. */
  limiter?: { ceilingDb: number };
  /** Makeup gain on the finished chain; absent = 1. */
  gain?: number;
}

/* ------------------------------------------------------- clip sound */

/**
 * A clip's own sound treatment — the Inspector's Sound quality section.
 *
 * Where an effect element treats the mix under a window, this rides one clip
 * and runs on that clip's sound alone, before its fades and the duck. Every
 * stage is optional and a fully neutral treatment is stored as absence, so a
 * clip that was never touched carries nothing.
 */
export interface ClipSound {
  /** Gain in dB per `SOUND_EQ_BANDS` entry, in that order. Absent = flat. */
  eq?: number[];
  /** dB, ratio (:1), attack ms, release ms. */
  compressor?: { threshold: number; ratio: number; attack: number; release: number };
  /** Ceiling in dBFS. */
  limiter?: { ceiling: number };
}

/** The fixed band layout of the clip equalizer: a shelf at each end and
 * peaks between, spaced where speech lives. Fixed frequencies keep a preset
 * to seven numbers, which is what the sliders, the tool schema and a saved
 * preset all carry. */
export const SOUND_EQ_BANDS: {
  hz: number;
  type: AudioBandSpec["type"];
  label: string;
  /** The region of the spectrum the band sits in, named the way a mixer
   * names it. */
  group: "Low" | "Mids" | "Presence" | "Highs";
}[] = [
  { hz: 100, type: "lowshelf", label: "100 Hz", group: "Low" },
  { hz: 200, type: "peaking", label: "200 Hz", group: "Low" },
  { hz: 400, type: "peaking", label: "400 Hz", group: "Mids" },
  { hz: 1000, type: "peaking", label: "1 kHz", group: "Mids" },
  { hz: 3000, type: "peaking", label: "3 kHz", group: "Presence" },
  { hz: 5000, type: "peaking", label: "5 kHz", group: "Presence" },
  { hz: 10000, type: "highshelf", label: "10 kHz", group: "Highs" },
];

/** A peak's width: about an octave and a half, wide enough that two adjacent
 * bands moved together read as one shape. */
const SOUND_EQ_Q = 1.0;

export const SOUND_EQ_DB_RANGE = 12;
/** What the stage sliders offer. A ratio of 1:1 and a ceiling of 0 dBFS are
 * the stage doing nothing, and `normalizeSound` stores them as absence, so
 * the ranges stop short of both — dragging to an endpoint shapes the sound
 * rather than deleting the stage mid-gesture. Switching the section off is
 * how a stage goes away. */
export const SOUND_COMPRESSOR_RANGE = {
  threshold: { min: -60, max: -1 },
  ratio: { min: 1.5, max: 20 },
  attack: { min: 0.1, max: 200 },
  release: { min: 5, max: 1000 },
};
export const SOUND_LIMITER_RANGE = { ceiling: { min: -20, max: -0.1 } };

/** The settings a compressor or limiter opens at when its switch is turned
 * on — the voice presets' shared numbers, since that is what the switch is for. */
export const SOUND_COMPRESSOR_DEFAULT = { threshold: -18, ratio: 3, attack: 10, release: 80 };
export const SOUND_LIMITER_DEFAULT = { ceiling: -1 };

/** A voice preset's dynamics: the shared attack and release with its own
 * ratio and threshold, held under the −1 dB ceiling. */
const voiceDynamics = (ratio: number, threshold: number) => ({
  compressor: { ...SOUND_COMPRESSOR_DEFAULT, ratio, threshold },
  limiter: SOUND_LIMITER_DEFAULT,
});

/**
 * The treatments shipped with the editor. `sound` undefined is the flat one.
 * `character` is the one-line description the picker and the chat catalog
 * both read, so the two describe a preset the same way.
 */
export const SOUND_PRESETS: {
  id: string;
  name: string;
  character: string;
  sound: ClipSound | undefined;
}[] = [
  { id: "flat", name: "Flat", character: "Untouched", sound: undefined },
  {
    id: "clear-voice",
    name: "Clear voice",
    character: "Warm, clear podcast voice",
    sound: { eq: [2, 1, -2, -1, 1.5, 1, -1], ...voiceDynamics(3, -18) },
  },
  {
    id: "warm-rich",
    name: "Warm & Rich",
    character: "Deep, smooth, expensive-sounding",
    sound: { eq: [2, 1, -2, -1, 0.5, 1, -1], ...voiceDynamics(3, -18) },
  },
  {
    id: "crisp-clear",
    name: "Crisp & Clear",
    character: "Bright, clean, highly intelligible",
    sound: { eq: [-1.5, -1, -2, 0, 2, 3, 1], ...voiceDynamics(2.5, -18) },
  },
  {
    id: "broadcast",
    name: "Broadcast",
    character: "Polished podcast/radio voice, more compressed",
    sound: { eq: [1.5, 2, -2, -1, 1, 2, -0.5], ...voiceDynamics(4, -20) },
  },
  {
    id: "natural",
    name: "Natural",
    character: "Balanced, close to the real voice",
    sound: { eq: [0.5, 0, -1, 0, 1, 1, 0], ...voiceDynamics(2, -18) },
  },
  {
    id: "deep-voice",
    name: "Deep Voice",
    character: "Darker, heavier, deeper without turning muddy",
    sound: { eq: [3, 2, -2, -1, 0, 1, -2], ...voiceDynamics(3, -18) },
  },
  {
    id: "airy",
    name: "Airy",
    character: "Bright, open, modern creator voice",
    sound: { eq: [-0.5, -1, -1, 0, 1, 2, 2.5], ...voiceDynamics(2.5, -18) },
  },
  {
    id: "studio",
    name: "Studio",
    character: "Warm, clear, controlled, professional — the talking-head default",
    sound: { eq: [1.5, 1, -2, -1, 1, 2, 0.5], ...voiceDynamics(3, -18) },
  },
  {
    id: "phone",
    name: "Phone / Lo-Fi",
    character: "Narrow, mid-heavy, phone-like; for skits, flashbacks and transitions",
    sound: { eq: [-10, -3, 1, 2, 3, 2, -9] },
  },
  {
    id: "cinematic",
    name: "Cinematic",
    character: "Warm, dark, intimate storytelling voice",
    sound: { eq: [2.5, 1, -2, -1, 0.5, 0, -2.5], ...voiceDynamics(3, -20) },
  },
  {
    id: "close-asmr",
    name: "Close / ASMR",
    character: "Intimate, close, detailed",
    sound: { eq: [2.5, 2, -1, 0, 1, 1, 1.5], ...voiceDynamics(3, -20) },
  },
];

export const soundPresetById = (id: string) => SOUND_PRESETS.find((p) => p.id === id);

const clampTo = (v: number, r: { min: number; max: number }) =>
  Math.max(r.min, Math.min(r.max, v));

/**
 * A sound with every stage clamped into range and every neutral stage
 * dropped, or undefined when nothing is left: the one shape the doc stores.
 * A flat equalizer, a compressor at 1:1 and a limiter at 0 dB all do nothing,
 * so they are not kept.
 */
export function normalizeSound(sound: ClipSound | undefined | null): ClipSound | undefined {
  if (!sound) return undefined;
  const out: ClipSound = {};
  if (sound.eq) {
    const eq = SOUND_EQ_BANDS.map((_, i) => {
      const v = Number(sound.eq![i] ?? 0);
      return Number.isFinite(v) ? clampTo(v, { min: -SOUND_EQ_DB_RANGE, max: SOUND_EQ_DB_RANGE }) : 0;
    });
    if (eq.some((v) => Math.abs(v) > 1e-3)) out.eq = eq;
  }
  if (sound.compressor) {
    const c = sound.compressor;
    const r = SOUND_COMPRESSOR_RANGE;
    if (Number.isFinite(c.ratio) && c.ratio > 1 + 1e-3) {
      out.compressor = {
        threshold: clampTo(c.threshold, r.threshold),
        ratio: clampTo(c.ratio, r.ratio),
        attack: clampTo(c.attack, r.attack),
        release: clampTo(c.release, r.release),
      };
    }
  }
  if (sound.limiter) {
    const raw = sound.limiter.ceiling;
    if (Number.isFinite(raw) && raw < -1e-3) {
      out.limiter = { ceiling: clampTo(raw, SOUND_LIMITER_RANGE.ceiling) };
    }
  }
  return out.eq || out.compressor || out.limiter ? out : undefined;
}

/** The recipe a clip's sound builds, or null when it is neutral. */
export function soundRecipe(sound: ClipSound | undefined | null): AudioFxRecipe | null {
  const s = normalizeSound(sound);
  if (!s) return null;
  const bands: AudioBandSpec[] = [];
  if (s.eq) {
    SOUND_EQ_BANDS.forEach((b, i) => {
      const db = s.eq![i];
      if (Math.abs(db) < 1e-3) return;
      bands.push({ type: b.type, hz: b.hz, db, ...(b.type === "peaking" ? { q: SOUND_EQ_Q } : {}) });
    });
  }
  return {
    dry: 1,
    taps: [],
    bands,
    ...(s.compressor
      ? {
          compressor: {
            thresholdDb: s.compressor.threshold,
            ratio: s.compressor.ratio,
            attackMs: s.compressor.attack,
            releaseMs: s.compressor.release,
          },
        }
      : {}),
    ...(s.limiter ? { limiter: { ceilingDb: s.limiter.ceiling } } : {}),
  };
}

/** How long the treated signal takes to come in and go out at an effect
 * window's edges, in seconds. Short enough to read as an instant switch, long
 * enough that the switch cannot click. */
export const AUDIO_FX_RAMP = 0.04;

const clampAmount = (k: number | undefined) => Math.max(0.05, Math.min(1, k ?? 0.5));
const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString();

/** The delays a reverb's reflections arrive at, in milliseconds. They are
 * mutually prime so the copies never stack into a single flutter, and they run
 * out past two thirds of a second: a handful of early reflections alone reads
 * as a thickening, and what makes a room audible is the tail behind them. */
const ROOM_TAPS = [29, 43, 67, 89, 113, 149, 191, 239, 307, 383, 467, 571, 683];

/**
 * The recipe for one effect at strength `amount` (0.05..1).
 *
 * The strength moves what the effect is made of — how loud the echoes come
 * back, how far down the muffle closes, how deep the crush bites — so the
 * slider reads as more of the same sound rather than a wet/dry blend.
 */
export function audioFxRecipe(effect: string, amount?: number): AudioFxRecipe | null {
  const k = clampAmount(amount);
  switch (effect as AudioEffectId) {
    case "echo":
      // Three repeats a quarter second apart, each quieter than the last.
      return {
        dry: 1,
        taps: [
          { ms: 250, gain: 0.75 * k },
          { ms: 500, gain: 0.5 * k },
          { ms: 750, gain: 0.3 * k },
        ],
        bands: [],
      };
    case "reverb":
      // A room, built from its reflections: dense taps decaying across three
      // quarters of a second, with the top rolled off so the tail sits behind
      // the voice. The decay is slow enough that the tail is still there after
      // the word that made it, which is the part that is heard as a room.
      return {
        dry: 1,
        taps: ROOM_TAPS.map((ms, i) => ({ ms, gain: 0.55 * k * Math.exp(-0.22 * i) })),
        bands: [{ type: "lowpass", hz: 5000 }],
        gain: 0.8,
      };
    case "muffle":
      // Heard through a wall: two passes take the top off at twenty-four
      // decibels an octave, and a shelf pulls down what leaks past them, so
      // the consonants go and the body stays. Makeup gain keeps the window at
      // the level of the mix around it.
      return {
        dry: 1,
        taps: [],
        bands: [
          { type: "lowpass", hz: 2000 - 1500 * k },
          { type: "lowpass", hz: 2000 - 1500 * k },
          { type: "highshelf", hz: 3000, db: -(6 + 12 * k) },
        ],
        gain: 1 + 0.8 * k,
      };
    case "telephone":
      // The band a phone line passes, with the middle pushed up so speech
      // carries through it.
      return {
        dry: 1,
        taps: [],
        bands: [
          { type: "highpass", hz: 500 + 300 * k },
          { type: "highpass", hz: 500 + 300 * k },
          { type: "lowpass", hz: 3200 - 1000 * k },
          { type: "peaking", hz: 1800, q: 1.2, db: 4 + 6 * k },
        ],
        gain: 1.3,
      };
    case "deep":
      // Bigger and lower. The lift sits at 180 Hz, inside what a laptop
      // speaker and a phone can actually reproduce, and the top comes down
      // with it — a voice reads as deep by what it loses as much as by what it
      // gains, and the loss is what carries on small speakers.
      return {
        dry: 1,
        taps: [],
        bands: [
          { type: "lowshelf", hz: 180, db: 6 + 10 * k },
          { type: "highshelf", hz: 2600, db: -(5 + 9 * k) },
        ],
        gain: 0.9,
      };
    case "bright":
      // Thin and forward: the bottom comes off, a presence peak pushes the
      // consonants out, and the shelf above it opens the air.
      return {
        dry: 1,
        taps: [],
        bands: [
          { type: "lowshelf", hz: 220, db: -(4 + 8 * k) },
          { type: "peaking", hz: 4500, q: 0.9, db: 4 + 7 * k },
          { type: "highshelf", hz: 8000, db: 4 + 8 * k },
        ],
        gain: 0.95,
      };
    case "wobble":
      // Six swings a second, and the shallowest of them still drops the level
      // by a third — a tremolo that only grazes the signal is heard as nothing
      // at all.
      return { dry: 1, taps: [], bands: [], tremolo: { hz: 6, depth: 0.35 + 0.65 * k } };
    case "crush":
      // Down to three bits at the top of the slider, mixed in over the clean
      // signal so the words survive the grit. Eight bits and up is a change a
      // meter sees and an ear does not, so even the low end of the slider
      // quantizes hard enough to hear.
      return {
        dry: 1,
        taps: [],
        bands: [],
        crush: { bits: Math.max(3, Math.round(7 - 4 * k)), mix: 0.5 + 0.5 * k },
        gain: 0.9,
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------- ffmpeg */

/** The ffmpeg name and argument spelling of one band. */
function bandFilter(b: AudioBandSpec): string {
  const q = b.q ?? 0.707;
  switch (b.type) {
    case "lowpass":
      return `lowpass=f=${fmt(b.hz)}:width_type=q:w=${fmt(q)}`;
    case "highpass":
      return `highpass=f=${fmt(b.hz)}:width_type=q:w=${fmt(q)}`;
    // Web Audio's shelf nodes ignore Q and run at slope S=1; ffmpeg defaults
    // to a Q width of 0.5, which is a different curve at the corner. Spelling
    // the slope out is what keeps the preview and the export on one sound.
    case "lowshelf":
      return `lowshelf=f=${fmt(b.hz)}:width_type=s:w=1:g=${fmt(b.db ?? 0)}`;
    case "highshelf":
      return `highshelf=f=${fmt(b.hz)}:width_type=s:w=1:g=${fmt(b.db ?? 0)}`;
    case "peaking":
      return `equalizer=f=${fmt(b.hz)}:width_type=q:w=${fmt(q)}:g=${fmt(b.db ?? 0)}`;
  }
}

/** dBFS as the linear amplitude ffmpeg's dynamics filters take. */
const linear = (db: number) => Math.pow(10, db / 20);

/**
 * The effect as one ffmpeg audio chain — comma-joined filters, no stream
 * labels, so the caller splices it into whatever window it runs over. Null for
 * an unknown id: the export then renders the sound untreated rather than
 * failing.
 */
export function audioFxFilters(effect: string, amount?: number): string | null {
  const r = audioFxRecipe(effect, amount);
  return r ? recipeFilters(r) : null;
}

/** A clip's sound as one ffmpeg chain, or null when it is neutral. */
export function soundFilters(sound: ClipSound | undefined | null): string | null {
  const r = soundRecipe(sound);
  return r ? recipeFilters(r) : null;
}

/** One recipe spelled as ffmpeg filters, in the order the graph builds them. */
export function recipeFilters(r: AudioFxRecipe): string | null {
  const steps: string[] = [];
  if (r.taps.length > 0) {
    // aecho computes in_gain*dry + out_gain*Σ decay_i·delayed_i, which is the
    // tap list exactly; out_gain stays at 1 so each tap's own gain is what is
    // heard. Its decays must stay under 1, which the recipes hold to.
    steps.push(
      `aecho=${fmt(r.dry)}:1:` +
        r.taps.map((t) => fmt(t.ms)).join("|") +
        ":" +
        r.taps.map((t) => fmt(Math.min(0.9, t.gain))).join("|")
    );
  } else if (r.dry !== 1) {
    steps.push(`volume=${fmt(r.dry)}`);
  }
  for (const b of r.bands) steps.push(bandFilter(b));
  if (r.tremolo) steps.push(`tremolo=f=${fmt(r.tremolo.hz)}:d=${fmt(r.tremolo.depth)}`);
  if (r.crush) steps.push(`acrusher=bits=${fmt(r.crush.bits)}:mix=${fmt(r.crush.mix)}:mode=lin`);
  if (r.compressor) {
    const c = r.compressor;
    // acompressor's threshold is linear amplitude; attack and release are ms.
    // No makeup, so the two sides agree: the Web Audio node adds none either.
    steps.push(
      `acompressor=threshold=${fmt(linear(c.thresholdDb))}:ratio=${fmt(c.ratio)}` +
        `:attack=${fmt(c.attackMs)}:release=${fmt(c.releaseMs)}:knee=2:makeup=1`
    );
  }
  if (r.limiter) {
    // A lookahead of a few milliseconds, the same as the browser's dynamics
    // node carries, and no automatic level: the ceiling is the whole point.
    steps.push(`alimiter=limit=${fmt(linear(r.limiter.ceilingDb))}:attack=5:release=50:level=false`);
  }
  if (r.gain !== undefined && r.gain !== 1) steps.push(`volume=${fmt(r.gain)}`);
  return steps.length > 0 ? steps.join(",") : null;
}

/* ---------------------------------------------------------- Web Audio */

/** The two ends of a built chain: connect sound into `input`, take it out of
 * `output`. */
export interface AudioFxNodes {
  input: AudioNode;
  output: AudioNode;
  /** Modulators the chain started, so a caller can stop them with it. */
  sources: AudioScheduledSourceNode[];
}

/** The quantization curve of a bit crush, as a WaveShaper table: the same
 * staircase `acrusher` applies in linear mode. */
function crushCurve(bits: number): Float32Array<ArrayBuffer> {
  const steps = Math.max(2, Math.pow(2, Math.max(1, bits)) / 2);
  const curve = new Float32Array(new ArrayBuffer(1024 * 4));
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.round(x * steps) / steps;
  }
  return curve;
}

/**
 * Build one effect's Web Audio graph on `ctx`.
 *
 * `startAt` is the context time the modulators run from, so an offline fold
 * can line a wobble's phase up with the window it treats. Live playback passes
 * the moment the chain joins the graph.
 */
export function buildAudioFx(
  ctx: BaseAudioContext,
  recipe: AudioFxRecipe,
  startAt = 0
): AudioFxNodes {
  const input = ctx.createGain();
  const sources: AudioScheduledSourceNode[] = [];

  // The taps and the dry signal meet here; with no taps the sum is the dry
  // path alone, which is a gain of the recipe's own dry level.
  const sum = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = recipe.dry;
  input.connect(dry);
  dry.connect(sum);
  for (const tap of recipe.taps) {
    const delay = ctx.createDelay(Math.max(0.05, tap.ms / 1000 + 0.05));
    delay.delayTime.value = tap.ms / 1000;
    const gain = ctx.createGain();
    gain.gain.value = tap.gain;
    input.connect(delay);
    delay.connect(gain);
    gain.connect(sum);
  }

  let node: AudioNode = sum;
  for (const b of recipe.bands) {
    const filter = ctx.createBiquadFilter();
    filter.type = b.type;
    filter.frequency.value = b.hz;
    filter.Q.value = b.q ?? 0.707;
    if (b.db !== undefined) filter.gain.value = b.db;
    node.connect(filter);
    node = filter;
  }

  if (recipe.tremolo) {
    const { hz, depth } = recipe.tremolo;
    const trem = ctx.createGain();
    // The same swing ffmpeg's tremolo has: the level rides between full and
    // (1 − depth), so the average stays where the mix was.
    trem.gain.value = 1 - depth / 2;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = hz;
    const swing = ctx.createGain();
    swing.gain.value = depth / 2;
    lfo.connect(swing);
    swing.connect(trem.gain);
    lfo.start(startAt);
    sources.push(lfo);
    node.connect(trem);
    node = trem;
  }

  if (recipe.crush) {
    // The crushed copy and the clean one, at the recipe's mix — `acrusher`'s
    // own blend.
    const shaper = ctx.createWaveShaper();
    shaper.curve = crushCurve(recipe.crush.bits);
    const wet = ctx.createGain();
    wet.gain.value = recipe.crush.mix;
    const clean = ctx.createGain();
    clean.gain.value = 1 - recipe.crush.mix;
    const mixed = ctx.createGain();
    node.connect(shaper);
    shaper.connect(wet);
    wet.connect(mixed);
    node.connect(clean);
    clean.connect(mixed);
    node = mixed;
  }

  if (recipe.compressor) {
    const c = recipe.compressor;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = c.thresholdDb;
    comp.ratio.value = Math.max(1, Math.min(20, c.ratio));
    comp.knee.value = 2;
    comp.attack.value = c.attackMs / 1000;
    comp.release.value = c.releaseMs / 1000;
    node.connect(comp);
    node = comp;
  }

  if (recipe.limiter) {
    // Web Audio has no limiter node; a hard-knee compressor at the steepest
    // ratio the node takes, reacting at once, holds the ceiling the same way.
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = recipe.limiter.ceilingDb;
    lim.ratio.value = 20;
    lim.knee.value = 0;
    lim.attack.value = 0.001;
    lim.release.value = 0.05;
    node.connect(lim);
    node = lim;
  }

  if (recipe.gain !== undefined && recipe.gain !== 1) {
    const makeup = ctx.createGain();
    makeup.gain.value = recipe.gain;
    node.connect(makeup);
    node = makeup;
  }

  return { input, output: node, sources };
}

/* -------------------------------------------------------------- tiles */

/** How many bars a picker tile draws. */
export const AUDIO_FX_BARS = 28;

/** The untreated level at bar `i` of `n` at time `t` — a rolling figure with
 * a speech-like envelope, so every tile shapes the same sound. */
function baseBar(i: number, n: number, t: number): number {
  const u = i / n + t * 0.4;
  const detail =
    0.5 * Math.abs(Math.sin(2 * Math.PI * 1.3 * u)) +
    0.3 * Math.abs(Math.sin(2 * Math.PI * 2.9 * u + 1.1)) +
    0.2 * Math.abs(Math.sin(2 * Math.PI * 7.1 * u + 2.3));
  const envelope = 0.45 + 0.55 * Math.abs(Math.sin(Math.PI * (u * 0.6 + 0.15)));
  return detail * envelope;
}

/** A box blur over the bars, the figure's stand-in for a filter that takes
 * the top off. */
function smooth(bars: number[], width: number): number[] {
  const w = Math.max(1, Math.round(width));
  if (w <= 1) return bars;
  return bars.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = i - w; j <= i + w; j++) {
      if (j < 0 || j >= bars.length) continue;
      sum += bars[j];
      count++;
    }
    return sum / Math.max(1, count);
  });
}

/**
 * The bar figure a picker tile draws for one effect at time `t`, each value
 * 0..1.
 *
 * It is read off the same recipe the sound is built from — taps add their
 * delayed copies, a low pass rounds the figure off, a shelf leans it toward
 * body or detail, tremolo swings the whole thing, a crush steps it — so a
 * recipe change shows on its tile without a second description of the effect.
 */
export function audioFxBars(
  effect: string | null,
  t: number,
  n = AUDIO_FX_BARS,
  amount?: number
): number[] {
  let bars = Array.from({ length: n }, (_, i) => baseBar(i, n, t));
  const recipe = effect ? audioFxRecipe(effect, amount) : null;
  if (recipe) {
    if (recipe.taps.length > 0) {
      const dry = bars.map((v) => v * recipe.dry);
      const withTaps = [...dry];
      for (const tap of recipe.taps) {
        // A second of sound reads as the tile's width, so a quarter-second
        // repeat lands a quarter of the way along and can be seen as one.
        const shift = Math.max(1, Math.round((tap.ms / 1000) * n * 0.9));
        for (let i = 0; i < n; i++) {
          const from = i - shift;
          if (from >= 0) withTaps[i] += dry[from] * tap.gain;
        }
      }
      bars = withTaps;
    }
    // The passes are read as a pair of edges rather than one at a time: two
    // sections at the same cutoff are one steeper filter, and blurring the
    // figure twice for them leaves a bar with no shape in it at all.
    let lowest = Infinity;
    let highest = 0;
    for (const b of recipe.bands) {
      if (b.type === "lowpass") {
        lowest = Math.min(lowest, b.hz);
        continue;
      }
      if (b.type === "highpass") {
        highest = Math.max(highest, b.hz);
        continue;
      }
      const body = smooth(bars, 3);
      const lift = (b.db ?? 0) / 24;
      bars =
        b.type === "highshelf"
          ? bars.map((v, i) => v + Math.max(0, v - body[i]) * lift * 3)
          : bars.map((v, i) => v + body[i] * lift);
    }
    if (lowest < Infinity) {
      // Rounded off and smaller: what the pass takes off the top is gone from
      // the figure the same way it is gone from the sound.
      const keep = Math.max(0.45, Math.min(1, lowest / 3500));
      bars = smooth(bars, Math.min(3, 2400 / Math.max(200, lowest))).map((v) => v * keep);
    }
    if (highest > 0) {
      const body = smooth(bars, 3);
      bars = bars.map((v, i) => Math.max(0, v - body[i] * Math.min(0.9, highest / 1200)));
    }
    if (recipe.tremolo) {
      const { hz, depth } = recipe.tremolo;
      const swing = 1 - depth / 2 + (depth / 2) * Math.sin(2 * Math.PI * hz * t);
      bars = bars.map((v) => v * swing);
    }
    if (recipe.crush) {
      const steps = Math.max(2, Math.round(recipe.crush.bits / 2));
      bars = bars.map(
        (v) => v * (1 - recipe.crush!.mix) + (Math.round(v * steps) / steps) * recipe.crush!.mix
      );
    }
    if (recipe.gain !== undefined) bars = bars.map((v) => v * recipe.gain!);
  }
  // Louder than the tile is tall: the figure is scaled back to fit rather than
  // flattened against the top, so an effect that adds level keeps its shape.
  // A figure a filter has taken most of the level out of is scaled the other
  // way for the same reason — pressed against the floor it has no shape left
  // to read either.
  const peak = Math.max(...bars);
  if (peak > 1) bars = bars.map((v) => v / peak);
  else if (peak > 0.01 && peak < 0.55) bars = bars.map((v) => (v * 0.55) / peak);
  // A floor keeps every bar visible: the figure shows the shape of the effect,
  // and a bar at zero reads as a gap in the tile.
  return bars.map((v) => Math.max(0.1, Math.min(1, v)));
}
