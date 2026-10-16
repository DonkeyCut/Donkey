import { retimeOf } from "@donkeycut/effects-kit";
import { CLIP_MIN_SECONDS, type AudioClip, type Overlay, type VideoClip } from "./types";

/** Timeline footprint of a clip: its source span through its rate, or through
 * its speed curve when it carries one (see retimeOf). */
export function clipLen(c: VideoClip | AudioClip) {
  return Math.max(CLIP_MIN_SECONDS, retimeOf(c).len);
}

/** Where a timeline ends. Anything on any row extends it: a layer or
 * soundtrack running past track 0's end is still reachable, and so is a title
 * or sticker left standing after the last clip — it plays over black. Lists a
 * stored doc lacks count as empty. */
export function timelineEnd(s: {
  clips?: VideoClip[];
  audioClips?: AudioClip[];
  overlays?: Overlay[];
}): number {
  let end = 0;
  for (const c of s.clips ?? []) end = Math.max(end, c.start + clipLen(c));
  for (const a of s.audioClips ?? []) end = Math.max(end, a.start + clipLen(a));
  for (const o of s.overlays ?? []) end = Math.max(end, o.end);
  return Math.max(0, end);
}
