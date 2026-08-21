/**
 * The audio effects on a timeline, and how loud each one runs at a moment.
 *
 * An audio effect element treats every sound under its stretch of timeline.
 * Inside the window the treated signal is what is heard, outside it the mix is
 * untouched, and the edges cross over in a few milliseconds so switching the
 * effect on cannot click. Both mixes read this: the live preview asks per
 * frame, the offline fold asks for the whole list and schedules the same
 * ramps.
 */

import { AUDIO_FX_RAMP, isAudioEffect, type AudioEffectId } from "@donkeycut/effects-kit";
import { isEffectOverlay, type Overlay } from "./types";

/** One effect element's window, with the knobs its recipe reads. */
export interface AudioFxSpan {
  id: string;
  effect: AudioEffectId;
  amount?: number;
  start: number;
  end: number;
}

/** The audio effect elements of a doc, in timeline order, clipped to
 * `duration` when one is given. Hidden elements are left out, the same as
 * everywhere else. */
export function audioFxSpans(overlays: Overlay[], duration?: number): AudioFxSpan[] {
  const spans: AudioFxSpan[] = [];
  for (const o of overlays) {
    if (!isEffectOverlay(o) || o.hidden || !isAudioEffect(o.effect)) continue;
    const end = duration === undefined ? o.end : Math.min(o.end, duration);
    if (!(end > o.start)) continue;
    spans.push({ id: o.id, effect: o.effect, amount: o.amount, start: Math.max(0, o.start), end });
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Whether a doc carries any audio effect at all — asked before the per-frame
 * work of finding out which ones are live. */
export const hasAudioEffects = (overlays: Overlay[]) =>
  overlays.some((o) => isEffectOverlay(o) && isAudioEffect(o.effect));

/** How much of the treated signal is heard at `t`: 1 through the window, 0
 * outside it, ramping across the edges. */
export function audioFxWetAt(span: AudioFxSpan, t: number): number {
  const ramp = Math.min(AUDIO_FX_RAMP, Math.max(0.001, (span.end - span.start) / 2));
  if (t <= span.start - ramp || t >= span.end + ramp) return 0;
  const inP = (t - (span.start - ramp)) / (2 * ramp);
  const outP = (span.end + ramp - t) / (2 * ramp);
  return Math.max(0, Math.min(1, Math.min(inP, outP)));
}

/**
 * The effects the preview keeps built at `t`, each with the wet level it runs
 * at right now.
 *
 * The list holds every effect whose window is near the playhead, rather than
 * only the ones sounding: a chain joins and leaves the graph while its wet
 * level is zero, so the rebuild it costs is silent.
 */
export function liveAudioFxAt(
  overlays: Overlay[],
  t: number
): { span: AudioFxSpan; wet: number }[] {
  const NEAR = 0.5;
  return audioFxSpans(overlays)
    .filter((s) => t > s.start - NEAR && t < s.end + NEAR)
    .map((span) => ({ span, wet: audioFxWetAt(span, t) }));
}
