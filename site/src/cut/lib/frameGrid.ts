import { isAudioEffect } from "@donkeycut/effects-kit";
import { isEffectOverlay, laneOf, type Overlay } from "./types";

/**
 * The frames an export lays the timeline on.
 *
 * An export samples the cut at k / fps. A footprint shows on the grid frames
 * from the first at or after its start to the first at or after its end, so a
 * clip shorter than one output frame can fall between two and show on none: a
 * 1/60 s flash in a 30 fps file. On a lane, such a clip holds the one frame at
 * or after its start and the clip after it takes the next, the rule the
 * ffmpeg join has always kept on track 0. Every renderer reads it from here.
 */

/** How far past a whole frame a time may sit, in frames, and still count as
 * on it: rounding in a sum of clip lengths never pushes a cut a frame late. */
const GRID_SLACK = 1e-3;

/** The first output frame at or after `t` seconds. */
export const gridFrame = (t: number, fps: number) => Math.ceil(t * fps - GRID_SLACK);

/** The output frames `[first, last)` a footprint holds once the grid moves
 * it, and the window that shows exactly those: half a frame either side, so
 * no frame time sits on an edge. */
export interface HeldFrames {
  first: number;
  last: number;
  from: number;
  to: number;
}

/**
 * For each footprint on one lane, sorted by start and never overlapping, the
 * frames it holds when the grid moves it, else null: it shows over its own
 * footprint. A footprint with no frame of its own takes the one at or after
 * its start, and a neighbor that frame belonged to starts one later.
 *
 * Example at 30 fps: [0.01, 0.0267) holds frame 1 (t = 0.0333), and a clip
 * from 0.0267 that would have opened on frame 1 opens on frame 2.
 */
export function heldFrames(
  items: readonly { start: number; end: number }[],
  fps: number
): (HeldFrames | null)[] {
  let taken = -Infinity;
  return items.map(({ start, end }) => {
    const own = gridFrame(start, fps);
    const ownEnd = gridFrame(end, fps);
    const first = Math.max(own, taken);
    const last = Math.max(first + 1, ownEnd);
    taken = last;
    if (first === own && last === ownEnd) {
      return null;
    }
    return { first, last, from: (first - 0.5) / fps, to: (last - 0.5) / fps };
  });
}

/** How far short of an edge a time may sit and still count as on it, in
 * seconds: a sum of clip lengths ends a hair past the next clip's start
 * (2.6000000000000005 against 2.6), and the frame on that cut is the next
 * clip's. */
const EDGE_SLACK_S = 1e-6;

/** Whether a footprint shows at `t`, read through its held frames when the
 * grid moved it. */
export const showsAt = (start: number, end: number, held: HeldFrames | null, t: number) =>
  held ? t >= held.from && t < held.to : t >= start - EDGE_SLACK_S && t < end - EDGE_SLACK_S;

/**
 * The elements with every footprint the grid moves at `fps` widened onto the
 * frames it holds, lane by lane. A pushed start moves to its first frame; an
 * end moves out to the frame after its last. Sound effects carry no picture
 * and hidden elements show nothing, so neither holds a frame.
 */
export function holdOverlays<O extends Overlay>(overlays: O[], fps: number): O[] {
  const pictured = (o: O) => !o.hidden && !(isEffectOverlay(o) && isAudioEffect(o.effect));

  // Each lane in start order, so a held element pushes the one after it.
  const lanes = new Map<number, O[]>();
  for (const o of overlays) {
    if (!pictured(o)) {
      continue;
    }
    const lane = lanes.get(laneOf(o)) ?? [];
    lane.push(o);
    lanes.set(laneOf(o), lane);
  }
  const moved = new Map<O, O>();
  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.start - b.start);
    heldFrames(lane, fps).forEach((held, i) => {
      if (!held) {
        return;
      }
      const o = lane[i];
      moved.set(o, {
        ...o,
        start: held.first > gridFrame(o.start, fps) ? held.from : o.start,
        end: held.last > gridFrame(o.end, fps) ? held.to : o.end,
      });
    });
  }
  return moved.size ? overlays.map((o) => moved.get(o) ?? o) : overlays;
}
