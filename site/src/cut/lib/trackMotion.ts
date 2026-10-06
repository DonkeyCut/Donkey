"use client";

/**
 * Track a target through a clip's footage and drive an item with it — the
 * one path the chat's track_motion tool and the inspector's Track control
 * both run.
 *
 * It picks the footage (the item itself, a named clip, or the clip under an
 * element), samples the stretch the two share on the timeline's clock, reads
 * it through the landmarkers (tracking.ts), settles and places the path
 * (trackKeys.ts), and lands the result on the item as one undo step.
 */

import { MASK_FEATHER_MAX, poseAt, retimeOf } from "@donkeycut/effects-kit";
import { cutTracking } from "./chatRuntime";
import { clipLen, useEditor } from "./store";
import { trackFootage } from "./tracking";
import {
  followKeys,
  pictureToFrame,
  settleTrack,
  trackedMask,
  type FollowMode,
  type Pt,
  type TrackItem,
  type TrackSample,
} from "./trackKeys";
import { trackTargetOf, type TrackTarget, type TrackUse } from "./trackTargets";
import { clipPoseAt, isEffectOverlay, type MediaAsset, type VideoClip } from "./types";

/** The shortest stretch worth a track: a couple of frames. */
const MIN_TRACK_SECONDS = 0.05;
/** The most in-view stretches and path points a track reports. */
const TRACK_SPANS_MAX = 12;
const TRACK_PATH_POINTS = 24;

/** A track that cannot run, in words for the person or the model. */
export class TrackError extends Error {}

export interface TrackRequest {
  /** The item driven: a video clip or an overlay element. */
  id: string;
  target: TrackTarget;
  use: TrackUse;
  /** The video clip whose footage is read; see `trackMotion`. */
  sourceId?: string;
  /** Timeline seconds bounding the track. */
  from?: number;
  to?: number;
  follow?: FollowMode;
  feather?: number;
  invert?: boolean;
  /** Share of frames read so far, 0..1. */
  onProgress?: (share: number) => void;
}

export async function trackMotion(req: TrackRequest) {
  const s = useEditor.getState();
  const o = s.overlays.find((x) => x.id === req.id);
  const own = o ? undefined : s.clips.find((c) => c.id === req.id);
  if (!o && !own) throw new TrackError("No overlay element or video clip with that id.");
  if (o && req.use === "mask" && isEffectOverlay(o)) throw new TrackError("Effect elements have no pixels to mask.");

  // The footage read: the named clip, the item itself, or the clip that
  // most covers the element.
  const span = o ? { start: o.start, end: o.end } : { start: own!.start, end: own!.start + clipLen(own!) };
  const named = req.sourceId === undefined ? undefined : s.clips.find((c) => c.id === req.sourceId);
  if (req.sourceId !== undefined && !named) throw new TrackError("No video clip with that source_id.");
  const source = named ?? own ?? clipUnder(s.clips, s.assets, span);
  if (!source) throw new TrackError("No video clip plays under that element — pass source_id.");
  const asset = s.assets.find((a) => a.id === source.assetId);
  const picture = asset?.type === "video" && asset.width && asset.height ? { width: asset.width, height: asset.height } : null;
  if (!asset || !picture) throw new TrackError("The source clip has no video picture to track.");

  // The stretch tracked: where the item and the source overlap, narrowed by
  // from/to, sampled evenly on the timeline's clock.
  const srcEnd = source.start + clipLen(source);
  const a = Math.max(span.start, source.start, req.from ?? -Infinity);
  const b = Math.min(span.end, srcEnd, req.to ?? Infinity);
  if (b - a < MIN_TRACK_SECONDS)
    throw new TrackError(`The item and the source clip share no stretch to track (${round2(source.start)}–${round2(srcEnd)}s holds the footage).`);
  const tune = cutTracking();
  const fps = Math.min(tune.sampleFps, tune.maxFrames / (b - a));
  const n = Math.max(2, Math.floor((b - a) * fps) + 1);
  const last = b - 1 / (2 * tune.sampleFps);
  const times = Array.from({ length: n }, (_, k) => a + ((last - a) * k) / (n - 1));
  const rt = retimeOf(source);
  const srcTimes = times.map((t) => rt.srcAt(t - source.start));

  // Read, settle, and place the path in the project frame.
  const raw = await trackFootage(asset.url, picture, req.target, srcTimes, (done, total) => req.onProgress?.(done / total));
  const settled = settleTrack(times, raw, tune);
  const place = pictureToFrame(source, picture, s.aspect);
  const framed = settled.map((x) =>
    x ? { outline: x.outline.map(place), center: place(x.center), axis: [place(x.axis[0]), place(x.axis[1])] as [Pt, Pt] } : null
  );
  const found = framed.filter((x) => x !== null).length;
  const summary = {
    target: req.target,
    source_id: source.id,
    from: round2(a),
    to: round2(b),
    frames: n,
    found_share: round2(found / n),
    in_view: inViewSpans(times, framed),
  };
  if (req.use === "read") return { ...summary, path: trackPath(times, framed) };
  const label = trackTargetOf(req.target).label.toLowerCase();
  if (found === 0) throw new TrackError(`No ${label} found in the source between ${round2(a)}s and ${round2(b)}s.`);

  // The item as it stands now: the read took a while, and the person may
  // have moved it meanwhile.
  const now = useEditor.getState();
  const liveO = o && now.overlays.find((x) => x.id === o.id);
  const liveClip = own && now.clips.find((c) => c.id === own.id);
  if (!liveO && !liveClip) throw new TrackError("The item was deleted while it was being tracked.");
  const item: TrackItem = liveO ? { kind: "overlay", overlay: liveO } : { kind: "clip", clip: liveClip! };

  // A keyed pen mask that traces the target.
  if (req.use === "mask") {
    const feather = Math.max(0, Math.min(MASK_FEATHER_MAX, req.feather ?? 0));
    const invert = req.invert === true;
    const mask = trackedMask(item, now.aspect, times, framed, { feather, invert }, tune.keyTolerance)!;
    if (liveO) now.updateOverlay(liveO.id, { mask });
    else now.updateClip(liveClip!.id, { mask });
    return { ...summary, id: req.id, mask: { kind: mask.kind, keys: mask.kf!.length, feather, invert } };
  }

  // Pose keys that carry the item with the target.
  const follow = req.follow ?? "move_scale";
  const rest = liveO ? poseAt(liveO, a - liveO.start) : clipPoseAt(liveClip!, a - liveClip!.start);
  const kf = followKeys(item, now.aspect, times, framed, rest, follow, tune.keyTolerance);
  if (liveO) now.updateOverlay(liveO.id, { kf });
  else now.updateClip(liveClip!.id, { kf });
  return { ...summary, id: req.id, follow_mode: follow, keys: kf.length };
}

/** The video clip that covers most of `span` — the footage under an element.
 * A tie goes to the clip nearest track 0, the shot itself. */
function clipUnder(clips: VideoClip[], assets: MediaAsset[], span: { start: number; end: number }): VideoClip | undefined {
  const shared = (c: VideoClip) => Math.min(span.end, c.start + clipLen(c)) - Math.max(span.start, c.start);
  const video = (c: VideoClip) => assets.find((x) => x.id === c.assetId)?.type === "video";
  return clips
    .filter((c) => !c.hidden && video(c) && shared(c) > 0)
    .sort((p, q) => shared(q) - shared(p) || Math.abs(p.track ?? 0) - Math.abs(q.track ?? 0))[0];
}

/** The stretches, in timeline seconds, where the target was found. */
function inViewSpans(times: number[], frame: (TrackSample | null)[]): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  frame.forEach((x, i) => {
    if (!x) return;
    const open = spans[spans.length - 1];
    if (open && frame[i - 1]) open.to = round2(times[i]);
    else spans.push({ from: round2(times[i]), to: round2(times[i]) });
  });
  return spans.slice(0, TRACK_SPANS_MAX);
}

/** Where the target goes, evenly sampled: its center and its outline's box,
 * in frame fractions, at timeline seconds. */
function trackPath(times: number[], frame: (TrackSample | null)[]) {
  const step = Math.max(1, Math.ceil(frame.length / TRACK_PATH_POINTS));
  const out: { t: number; x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < frame.length; i += step) {
    const x = frame[i];
    if (!x) continue;
    const xs = x.outline.map((p) => p.x);
    const ys = x.outline.map((p) => p.y);
    out.push({
      t: round2(times[i]),
      x: round3(x.center.x),
      y: round3(x.center.y),
      w: round3(Math.max(...xs) - Math.min(...xs)),
      h: round3(Math.max(...ys) - Math.min(...ys)),
    });
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
