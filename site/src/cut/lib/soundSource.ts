/**
 * Where a clip's sound comes from.
 *
 * A camera records the picture and a scratch track beside it; a recorder on
 * the speaker records the sound worth keeping. Binding the recording to the
 * video asset (`soundFrom`) puts every clip of that video on the recording:
 * the clip keeps its trim, rate and direction, and each source second of the
 * video is read off the recording `offset` seconds later. The binding sits on
 * the asset, so a split, a trim, a retime, a reverse
 * or a copy cannot leave the sound behind. Every reader of a clip's sound —
 * the preview, the fold the tab exports and transcribes through, the spec the
 * engine and the worker render, the tools that listen — resolves it here.
 */

import { retimeOf, speedCurveOf, srcSpan, type Retimable, type SpeedNode } from "@donkeycut/effects-kit";
import { assetIsSilent, type StoredAsset } from "./types";

type Sourced = Pick<StoredAsset, "id" | "type" | "duration" | "soundFrom">;

/** The longest a split edit carries a clip's sound past its picture, either
 * side, in seconds. */
export const SPLIT_EDIT_MAX_S = 5;

/** The sound a video plays: its own file's track, or the recording bound to
 * it, with the seconds added to its source time to land on that file. */
export interface SoundSource<A> {
  asset: A;
  offset: number;
  /** The last second the sound file holds, for a bound recording; the
   * asset's own track is read as far as it goes. */
  limit: number;
  bound: boolean;
}

/** `asset`'s sound. A binding to a recording that is gone, silent, or the
 * video itself plays the camera's own track. One hop: a recording's own
 * binding is never followed. */
export function soundSourceOf<A extends Sourced>(
  asset: A,
  assets: readonly A[] | ReadonlyMap<string, A>
): SoundSource<A> {
  const from = asset.soundFrom;
  if (from && from.assetId !== asset.id && Number.isFinite(from.offset)) {
    const rec = isMap(assets) ? assets.get(from.assetId) : assets.find((a) => a.id === from.assetId);
    if (rec && !assetIsSilent(rec))
      return { asset: rec, offset: from.offset, limit: rec.duration > 0 ? rec.duration : Infinity, bound: true };
  }
  return { asset, offset: 0, limit: Infinity, bound: false };
}

const isMap = <A>(v: readonly A[] | ReadonlyMap<string, A>): v is ReadonlyMap<string, A> => v instanceof Map;

/** Source seconds of the sound file on either side of a clip's trim: what a
 * handle, a split edit or a crossing can reach into before its head and past
 * its tail. A reversed clip's head faces the source's end. */
export function soundRoom(
  c: { in: number; out: number; reverse?: boolean },
  src: { asset: { duration: number }; offset: number }
): { head: number; tail: number } {
  const lo = c.in + src.offset;
  const hi = c.out + src.offset;
  const end = src.asset.duration;
  return c.reverse ? { head: end - hi, tail: lo } : { head: lo, tail: end - hi };
}

/** A span moved onto its sound's clock: the same map from the timeline,
 * `offset` seconds later in the source. Speed curve nodes sit in source
 * seconds, so they move with it. */
export function shiftSpan<T extends Retimable>(c: T, offset: number): T {
  if (!offset) return c;
  const nodes = speedCurveOf(c);
  return {
    ...c,
    in: c.in + offset,
    out: c.out + offset,
    ...(nodes ? { speedCurve: nodes.map(([at, rate]): SpeedNode => [at + offset, rate]) } : {}),
  };
}

/** What one stretch of a span's sound reads from its file. */
export interface SoundWindow {
  /** Seconds on the sound file, low end first. */
  lo: number;
  hi: number;
  /** Timeline seconds into the window the sound begins: a recording that
   * starts after the window does leaves silence ahead of it. */
  at: number;
  /** Timeline seconds the sound runs. */
  len: number;
  /** The stretch as a span of its own on the sound file — the map a renderer
   * lays it through. */
  span: Retimable;
}

/**
 * The sound of span `c` over the window `[fromT, toT]`, timeline seconds from
 * its head (negative reaches before it, past its length beyond it), read from
 * the source `src` describes. The window narrows to what the file holds: a
 * recording rolled after the camera did, or stopped before it, leaves the
 * rest of the window silent. Null when nothing of the window is on the file.
 */
export function soundWindow(
  c: Retimable,
  src: { offset: number; limit: number },
  fromT: number,
  toT: number
): SoundWindow | null {
  const moved = shiftSpan(c, src.offset);
  const rt = retimeOf(moved);
  const want = srcSpan(rt, fromT, toT);
  const lo = Math.max(0, want.lo);
  const hi = Math.min(src.limit, want.hi);
  if (!(hi - lo > 1e-4)) return null;
  const t0 = rt.tAt(rt.reverse ? hi : lo);
  const t1 = rt.tAt(rt.reverse ? lo : hi);
  return {
    lo,
    hi,
    at: Math.max(0, t0 - fromT),
    len: Math.max(0, t1 - t0),
    span: { in: lo, out: hi, speed: moved.speed, speedCurve: moved.speedCurve, reverse: moved.reverse },
  };
}

/** A bound recording as a render spec carries it: the file the sound reads,
 * its clock's offset from the video's, and its length. */
export interface SpecSound {
  file: string;
  offset: number;
  duration: number;
}

/** The spec entry for `asset`'s bound recording, named the way the spec
 * names files; absent when the video plays its own track. */
export function specSound<A extends Sourced>(
  asset: A,
  assets: readonly A[] | ReadonlyMap<string, A>,
  fileOf: (a: A) => string
): SpecSound | undefined {
  const src = soundSourceOf(asset, assets);
  if (!src.bound) return undefined;
  return { file: fileOf(src.asset), offset: src.offset, duration: src.asset.duration };
}
