"use client";

/**
 * The cut's audible mix, rendered in the browser.
 *
 * One `OfflineAudioContext` fold that mirrors the engine's ffmpeg audio graph:
 * track-0 clip audio folds sequentially with cross-dissolves overlapping,
 * upper-track clips and soundtrack items land at their absolute starts with
 * their own volumes and fades, a ducking voiceover pulls everything else down
 * while it speaks, and the whole-project fade rides over the sum.
 *
 * Two callers want this and want it at different shapes. Transcription needs a
 * 16 kHz mono buffer, because that is what a speech model reads; an export
 * needs full-rate stereo, because that is what goes in the file. Same fold,
 * different rate and channel count — which is why those are parameters and the
 * fold is written once. A mix that drifted between them would put captions on
 * words that the exported audio says at another time.
 */

import { AUDIO_FX_RAMP, audioFxRecipe, buildAudioFx } from "@donkeycut/effects-kit";
import { decodeAudioSpan } from "./mediaRead";
import { timeStretch } from "./timeStretch";

/** One track-0 clip's audio in the sequential fold. A spacer (no file) only
 * shapes time. */
export interface MixClip {
  file: string;
  in: number;
  out: number;
  muted: boolean;
  speed?: number;
  /** Gain on the clip's own audio; absent = 1. */
  volume?: number;
  /** Cross-dissolve overlap into the next clip, timeline seconds. */
  transition?: number;
  /** Sound dissolve into the next clip, timeline seconds: this clip fades out
   * over the window before the cut and the next one fades in over the window
   * after it. Set instead of `transition` when the handover is on the sound. */
  soundCross?: number;
}

/** A clip placed at an absolute time: an upper-track video's audio, a
 * soundtrack bed, or a voiceover. */
export interface MixItem {
  file: string;
  in: number;
  out: number;
  start: number;
  volume: number;
  speed?: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  /** While this item is audible, everything else drops to this gain. */
  duck?: number;
}

/** One audio effect element: the treatment it names, and the stretch of
 * timeline it treats. */
export interface MixEffect {
  effect: string;
  amount?: number;
  start: number;
  end: number;
}

export interface MixSpec {
  duration: number;
  clips: MixClip[];
  /** Soundtrack, voiceovers, and upper-track clip audio. */
  items: MixItem[];
  /** Audio effect elements over the finished mix, in timeline order. */
  effects?: MixEffect[];
  /** Whole-project audio fades, seconds. */
  fadeIn?: number;
  fadeOut?: number;
}

export interface MixOptions {
  sampleRate: number;
  channels: number;
  /** Resolves a spec file name to something the reader can open. */
  resolve: (file: string) => string;
}

const speedOf = (s?: number) => (s && s > 0 ? s : 1);

/** Timeline length of one clip: source span over speed. A gap spacer keeps its
 * exact length — flooring it would land everything after it late. */
const clipDur = (c: MixClip) =>
  c.file ? Math.max(0.1, (c.out - c.in) / speedOf(c.speed)) : Math.max(0, c.out - c.in);

/** Timeline footprint of a placed item. */
const itemDur = (a: MixItem) => Math.max(0, (a.out - a.in) / speedOf(a.speed));

/**
 * Where the sequential fold puts each track-0 clip, and how long its
 * transition edges are. Clips abut — a transition claims no layout — and its
 * sound is the outgoing clip fading across the blend window while the next
 * enters clean at the cut, exactly like the engine's tail-fade + hard join.
 *
 * A sound dissolve is the same fade out with the next clip's fade in against
 * it: the picture cuts and the sound crosses over the cut.
 */
export function foldClips(clips: MixClip[]) {
  const geo = clips.map((clip) => ({ clip, at: 0, dur: clipDur(clip), fadeIn: 0, fadeOut: 0 }));
  let acc = 0;
  geo.forEach((g, j) => {
    g.at = acc;
    acc += g.dur;
    const next = geo[j + 1];
    if (!next) return;
    const fade = Math.min(g.clip.transition ?? 0, g.dur * 0.9);
    if (fade > 0.01) g.fadeOut = fade;
    const cross = Math.min(g.clip.soundCross ?? 0, g.dur * 0.9, next.dur * 0.9);
    if (cross > 0.01) {
      g.fadeOut = Math.max(g.fadeOut, cross);
      next.fadeIn = Math.max(next.fadeIn, cross);
    }
  });
  return geo;
}

/**
 * The windows during which a ducking item is audible, merged into a single
 * envelope: each entry is a stretch of timeline where everything that is not
 * itself ducking drops to `gain`.
 *
 * Overlapping voiceovers take the lowest gain of the ones speaking, which is
 * what the preview does frame by frame — computed here once for the whole
 * timeline instead, because a scheduled ramp cannot ask "what is live now?".
 */
export function duckWindows(items: MixItem[]): { start: number; end: number; gain: number }[] {
  const edges = items
    .filter((a) => a.duck !== undefined && a.duck < 1)
    .map((a) => ({ start: a.start, end: a.start + itemDur(a), gain: Math.max(0, a.duck!) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number; gain: number }[] = [];
  for (const w of edges) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) {
      last.end = Math.max(last.end, w.end);
      last.gain = Math.min(last.gain, w.gain);
    } else {
      merged.push({ ...w });
    }
  }
  return merged;
}

/** Schedule a duck envelope onto a gain node: 1 everywhere except inside the
 * windows, where it steps down and back. The steps are ramps a few
 * milliseconds long so the drop doesn't click. */
const DUCK_RAMP = 0.08;

function scheduleDuck(gain: GainNode, windows: { start: number; end: number; gain: number }[]) {
  gain.gain.value = 1;
  for (const w of windows) {
    gain.gain.setValueAtTime(1, Math.max(0, w.start - DUCK_RAMP));
    gain.gain.linearRampToValueAtTime(w.gain, w.start);
    gain.gain.setValueAtTime(w.gain, Math.max(w.start, w.end - DUCK_RAMP));
    gain.gain.linearRampToValueAtTime(1, w.end);
  }
}

/**
 * Render `spec` to a buffer, or null when nothing in it makes a sound.
 *
 * A clip that plays at a speed other than 1 is time-stretched to fit, so it
 * keeps its pitch — the same thing ffmpeg's atempo does for the engine and the
 * browser's `preservesPitch` does for the preview.
 */
export async function renderMix(spec: MixSpec, opts: MixOptions): Promise<AudioBuffer | null> {
  const { sampleRate, channels, resolve } = opts;
  const length = Math.max(1, Math.ceil(spec.duration * sampleRate));
  const ctx = new OfflineAudioContext(channels, length, sampleRate);

  // Only the spans that are actually heard are decoded, and only for entries
  // that can be heard at all. Decoding whole sources instead would mean a
  // ten-second trim of a ninety-minute recording pulling the entire recording
  // into memory — around 1.4 GB an hour at 48 kHz stereo — and several of them
  // at once.
  const wanted = new Map<string, { file: string; from: number; to: number }>();
  const spanKey = (c: { file: string; in: number; out: number }) =>
    `${c.file}|${c.in.toFixed(3)}|${c.out.toFixed(3)}`;
  for (const c of spec.clips) {
    if (!c.file || c.muted) continue;
    wanted.set(spanKey(c), { file: c.file, from: Math.max(0, c.in), to: c.out });
  }
  for (const a of spec.items) {
    if (!a.file || a.muted) continue;
    wanted.set(spanKey(a), { file: a.file, from: Math.max(0, a.in), to: a.out });
  }

  const buffers = new Map<string, AudioBuffer>();
  await Promise.all(
    [...wanted].map(async ([key, span]) => {
      // A source with no audio track at all — a silent recording, a still —
      // reads back null and mixes as silence, like the engine's hasStream
      // check. A source that could not be *read* is a different thing and is
      // allowed to fail the render: silently dropping it would hand the user a
      // finished file with a clip, or a whole voiceover, missing its sound.
      const buf = await decodeAudioSpan(resolve(span.file), span.from, span.to);
      if (buf) buffers.set(key, buf);
    })
  );

  if (buffers.size === 0) return null;

  // Everything that can be ducked passes through one node; the voiceovers doing
  // the ducking connect past it, so they never duck themselves.
  const ducked = ctx.createGain();
  scheduleDuck(ducked, duckWindows(spec.items));

  // Every sound meets on the bus, which is what the effect elements treat —
  // the ffmpeg graph applies them to the mixed stream in the same place.
  const bus = ctx.createGain();
  ducked.connect(bus);

  // The project fade is the last thing on the way out, matching the export's
  // fade on the final mix.
  const master = ctx.createGain();
  const fadeIn = Math.max(0, spec.fadeIn ?? 0);
  const fadeOut = Math.max(0, spec.fadeOut ?? 0);
  master.gain.value = 1;
  if (fadeIn > 0) {
    master.gain.setValueAtTime(0, 0);
    master.gain.linearRampToValueAtTime(1, fadeIn);
  }
  if (fadeOut > 0 && spec.duration > fadeOut) {
    master.gain.setValueAtTime(1, spec.duration - fadeOut);
    master.gain.linearRampToValueAtTime(0, spec.duration);
  }
  // The effects run in series off the bus, each crossed in over its own
  // window: inside it the treated signal is heard, outside it the untouched
  // one, with the edges ramping so the switch cannot click.
  let treated: AudioNode = bus;
  for (const fx of spec.effects ?? []) {
    const recipe = audioFxRecipe(fx.effect, fx.amount);
    const from = Math.max(0, fx.start);
    const to = Math.min(fx.end, spec.duration);
    if (!recipe || !(to > from)) continue;
    const nodes = buildAudioFx(ctx, recipe, from);
    const wet = ctx.createGain();
    const dry = ctx.createGain();
    const out = ctx.createGain();
    const ramp = Math.min(AUDIO_FX_RAMP, Math.max(0.001, (to - from) / 2));
    const cross = (gain: GainNode, inside: number) => {
      const outside = 1 - inside;
      gain.gain.setValueAtTime(outside, 0);
      gain.gain.setValueAtTime(outside, Math.max(0, from - ramp));
      gain.gain.linearRampToValueAtTime(inside, from + ramp);
      gain.gain.setValueAtTime(inside, Math.max(from + ramp, to - ramp));
      gain.gain.linearRampToValueAtTime(outside, to + ramp);
    };
    cross(wet, 1);
    cross(dry, 0);
    treated.connect(nodes.input);
    nodes.output.connect(wet);
    wet.connect(out);
    treated.connect(dry);
    dry.connect(out);
    treated = out;
  }
  treated.connect(master);
  master.connect(ctx.destination);

  /**
   * Fit a span to the time its clip occupies, keeping its pitch.
   *
   * `playbackRate` would do the fitting for free, and resample while it did it —
   * a clip at 1.5× would come back seven semitones high, which neither the
   * preview nor the engine's `atempo` does. So the buffer is stretched to the
   * length it needs first, and then played at its own rate.
   */
  const stretched = new Map<string, AudioBuffer>();
  const fitted = (key: string, buf: AudioBuffer, speed: number): AudioBuffer => {
    if (speed === 1) return buf;
    // A span used by more than one clip at the same speed is stretched once.
    const memo = `${key}@${speed}`;
    const hit = stretched.get(memo);
    if (hit) return hit;
    const channels = Array.from({ length: buf.numberOfChannels }, (_, c) =>
      buf.getChannelData(c)
    );
    const fit = timeStretch(channels, buf.sampleRate, 1 / speed);
    const out = new AudioBuffer({
      length: Math.max(1, fit[0].length),
      numberOfChannels: buf.numberOfChannels,
      sampleRate: buf.sampleRate,
    });
    fit.forEach((data, c) => out.getChannelData(c).set(data));
    stretched.set(memo, out);
    return out;
  };

  // Each buffer holds exactly the span its entry plays, already fitted to the
  // time that entry occupies, so it starts at its own zero and runs at 1.
  const play = (
    buf: AudioBuffer,
    at: number,
    duration: number,
    into: AudioNode,
    shape: (gain: GainNode) => void
  ) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    shape(gain);
    src.connect(gain);
    gain.connect(into);
    src.start(Math.max(0, at), 0, Math.max(0, duration));
  };

  for (const g of foldClips(spec.clips)) {
    const c = g.clip;
    const buf = !c.muted && c.file ? buffers.get(spanKey(c)) : undefined;
    if (!buf) continue; // muted, silent, or a gap spacer: only shapes time
    play(fitted(spanKey(c), buf, speedOf(c.speed)), g.at, g.dur, ducked, (gain) => {
      const level = Math.max(0, c.volume ?? 1);
      gain.gain.value = level;
      if (g.fadeIn > 0) {
        gain.gain.setValueAtTime(0, g.at);
        gain.gain.linearRampToValueAtTime(level, g.at + g.fadeIn);
      }
      if (g.fadeOut > 0) {
        gain.gain.setValueAtTime(level, g.at + g.dur - g.fadeOut);
        gain.gain.linearRampToValueAtTime(0, g.at + g.dur);
      }
    });
  }

  for (const a of spec.items) {
    const buf = a.muted ? undefined : buffers.get(spanKey(a));
    if (!buf) continue;
    const dur = itemDur(a);
    // A voiceover that ducks everything else is not itself ducked; it still
    // lands on the bus, so the effect elements treat it with the rest.
    const into = a.duck !== undefined && a.duck < 1 ? bus : ducked;
    play(fitted(spanKey(a), buf, speedOf(a.speed)), a.start, dur, into, (gain) => {
      const level = Math.max(0, a.volume);
      gain.gain.value = level;
      const fIn = Math.min(a.fadeIn ?? 0, dur);
      const fOut = Math.min(a.fadeOut ?? 0, dur);
      if (fIn > 0) {
        gain.gain.setValueAtTime(0, a.start);
        gain.gain.linearRampToValueAtTime(level, a.start + fIn);
      }
      if (fOut > 0) {
        gain.gain.setValueAtTime(level, a.start + dur - fOut);
        gain.gain.linearRampToValueAtTime(0, a.start + dur);
      }
    });
  }

  return ctx.startRendering();
}
