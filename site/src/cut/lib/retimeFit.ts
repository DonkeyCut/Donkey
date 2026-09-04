/**
 * A decoded stretch of a clip's sound, laid along the timeline by the clip's
 * map: stretched to the seconds the map gives it, pitch kept, and turned
 * around when the map runs backward. Every renderer of a clip's sound — the
 * preview mixer, the in-tab export, the engine's bake — lays its spans through
 * this, so all three hear the same thing.
 */

import type { Retime } from "@donkeycut/effects-kit";
import { timeStretch } from "./timeStretch";

/** A rate this close to 1 lays the sound at the source's own pace. The number
 * is here once: a caller asking whether a fit is needed and the fit deciding
 * it has nothing to do have to agree, and a caller with the looser bar hands
 * a clip at 1.0005× its sound unstretched while the picture runs at the
 * clip's rate — sixty milliseconds of drift over a minute, growing with the
 * clip. */
const SAME_RATE = 1e-9;

/** Whether a map lays sound at anything but the source's own pace and
 * direction. */
export const retimeFits = (rt: Retime) =>
  !rt.uniform || Math.abs(rt.rate - 1) > SAME_RATE || rt.reverse;

const turned = (data: Float32Array) => {
  const out = new Float32Array(data.length);
  for (let i = 0, j = data.length - 1; j >= 0; i++, j--) out[i] = data[j];
  return out;
};

export interface FittedSpan {
  channels: Float32Array[];
  /** The source second the first sample sits at: `lo` forward, and the far
   * end of what was actually read once turned around. */
  head: number;
  /**
   * Seconds to add to where the span says it starts, to land the samples in
   * hand at the moment they belong to.
   *
   * Zero whenever the read came back with everything it asked for, which is
   * nearly always. A read can end early — the source ends first — and on a
   * reversed span the missing part is the end that plays first, so the sound
   * in hand starts later than the span does. Laid at the span's own head it
   * would run early for the clip's whole length, sound ahead of picture.
   */
  shift: number;
}

/**
 * `channels` hold the source from second `lo` onward; the result is that
 * sound in timeline order at the map's pace.
 *
 * `wanted` is the source second the read was meant to reach, which is what
 * the caller placed the span by. Left out, the samples in hand are taken as
 * the whole of what was asked for.
 */
export function fitSpan(
  channels: Float32Array[],
  sampleRate: number,
  rt: Retime,
  lo: number,
  wanted?: number
): FittedSpan {
  const hi = lo + (channels[0]?.length ?? 0) / sampleRate;
  const head = rt.reverse ? hi : lo;
  const asked = rt.reverse ? (wanted ?? hi) : lo;
  const shift = rt.tAt(head) - rt.tAt(asked);
  const ordered = rt.reverse ? channels.map(turned) : channels;
  if (rt.uniform && Math.abs(rt.rate - 1) <= SAME_RATE)
    return { channels: ordered, head, shift };
  // Sample `i` of the ordered input is source second lo + i/sr, or hi − i/sr
  // once turned; the rate at that source second sets the stretch there.
  return {
    channels: timeStretch(
      ordered,
      sampleRate,
      rt.uniform
        ? 1 / rt.rate
        : {
            factorAt: (sec) => 1 / rt.rateAtSrc(rt.reverse ? hi - sec : lo + sec),
            outLength: Math.round(Math.abs(rt.tAt(hi) - rt.tAt(lo)) * sampleRate),
          }
    ),
    head,
    shift,
  };
}
