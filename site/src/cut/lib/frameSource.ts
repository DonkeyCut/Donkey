"use client";

/**
 * Frames for the preview, decoded straight off the file.
 *
 * The preview used to ask an `HTMLVideoElement` for a picture by writing
 * `currentTime` and waiting: a seek costs a decode from the nearest keyframe,
 * the element decides when it lands, and a cut meant handing the clock from one
 * element to another mid-flight. Everything that felt slow about scrubbing and
 * everything that stuttered at a join came from that one arrangement.
 *
 * Here a clip owns a decoder and a small ring of already-decoded frames.
 * Playing walks the file forward and fills the ring ahead of the playhead;
 * scrubbing asks for a single time and the newest request wins. Either way the
 * question the compositor asks — what does this clip look like now — is
 * answered from memory, without awaiting anything. If the exact frame has not
 * arrived, the nearest one already decoded is handed over and the real one
 * replaces it a moment later. A held frame is worth more than a stall.
 *
 * The ring is bounded by the sink's own canvas pool: `mediabunny` cycles a
 * fixed set of canvases, so keeping a reference to more of them than the pool
 * holds would hand out a canvas that has since been drawn over. The ring's
 * capacity and the pool size move together, and that is the whole memory story.
 */

import type { Input, InputVideoTrack, WrappedCanvas } from "mediabunny";
import { frameSink, keyframeTimeAt, openMedia, videoTrackOf, type FrameCanvasSink } from "./mediaRead";
import { allowance, canvasBytes, decodedFrameBytes, holdMemory } from "./memoryBudget";
import { meterPull, meterSource, meterWalk } from "./perfTrace";
import type { MediaAsset } from "./types";

/** Dev-only: pool lifecycle events, into the same log the engine writes.
 * Bounded so an ordinary dev session never accumulates it. */
function poolLog(msg: string): void {
  if (process.env.NODE_ENV === "production" || typeof window === "undefined") return;
  const w = window as unknown as { __cutEngineLog?: { at: number; msg: string }[] };
  const log = (w.__cutEngineLog ??= []);
  log.push({ at: Math.round(performance.now()), msg });
  if (log.length > 500) log.splice(0, log.length - 500);
}

/**
 * Decoded frames a source keeps around where it is being read.
 *
 * Small on purpose. Each one is a full-size canvas, and ten sources holding a
 * dozen apiece is hundreds of megabytes — enough to take the tab down. The sink
 * pre-decodes ahead internally, so the ring only has to bridge the gap between
 * two frames of the display: the frame being shown, a couple ahead of it, and
 * one spare for the blend at a dissolve.
 */
const RING = 10;
/** Canvases the sink cycles. Two more than the ring, so the frame being decoded
 * never lands on one the compositor is drawing this instant. */
const POOL = RING + 2;
/**
 * How far ahead of where it is read a playing source decodes.
 *
 * This has to stay inside what the ring can hold. Reading further ahead than
 * `RING` frames would push the frame actually on screen out of the ring to make
 * room for one nobody has asked for yet — the picture would run ahead of the
 * playhead and the decoder would burn through the file to put it there.
 */
export const DECODE_AHEAD_S = 0.3;
/**
 * How far past a walk's last landed frame the playhead may read before the
 * walk is re-anchored ahead of it.
 *
 * A walk running behind still lands frames — the picture advances, a beat
 * late — so it keeps walking while the lag stays watchable, and hops forward
 * once the frames it lands are history. The tolerance is wide because ending
 * the lag costs a keyframe seek that lands nothing at all until it finishes:
 * on the machine that trails in the first place, that seek is longer than the
 * lag it would cure, and a walk restarted every time it slips runs that seek
 * over and over while the picture sits frozen. Measured on the eval's few-slot
 * profiles, tightening this to a fifth of a second took late frames from 8% to
 * 52% and the worst lag from a tenth of a second to four tenths.
 */
const LAG_HOP_S = 2;

/**
 * The furthest a re-anchored walk will aim ahead of the playhead.
 *
 * The lead is what reaching a frame has been costing (`aheadOf`), and on a
 * reader waiting for bytes that cost is measured in seconds. Aiming that far
 * ahead skips the stretch the walk could never have caught up with, which is
 * the trade this makes on purpose — the sound is going there regardless, and a
 * picture that arrives with it beats one that arrives behind it. The cap is
 * what keeps a single slow read from throwing away half a clip.
 */
const LEAD_CAP_S = 4;
/**
 * How far short of the file's end a walk has to stop before that reads as the
 * walk failing rather than the film ending.
 *
 * A walk reports the same `done` either way: bytes that never came, a decoder
 * closed under it, a demuxer that lost the file. Taken as the end, a walk that
 * stops a second into a half-hour clip pins the picture on the frame before it
 * and nothing ever asks for another — the sound plays the rest of the cut over
 * one still. So a walk that ends well short of the file is one that failed,
 * and another goes after the film it did not reach.
 *
 * The margin is wide because the number it is measured against is loose: a
 * file's stated length runs past its last frame by however much its metadata
 * rounds or its audio outlasts its picture, and a margin under that charges
 * every sound file a second doomed walk to prove it really ended. Wide, the
 * cost is the other way: a walk that dies inside the last two seconds of a
 * clip reads as the end, and the picture holds there. Three things keep the
 * retries bounded — a walk that gets no further than a previous one has found
 * where the film really stops, a walk that died does not aim ahead again, and
 * a source that has had two die in a row waits `WALK_RETRY_MS`.
 */
const END_SLACK_S = 2;
/** A pull costing more than this came off the link rather than the decoder —
 * a decoder that cannot keep up still answers within a frame or two. */
const SLOW_PULL_MS = 60;
/** How long one slow pull speaks for. Bytes arrive in bursts, so the gap
 * between two stalls says nothing about the link having recovered. */
const SLOW_PULL_HOLD_MS = 5_000;
/** How long a source waits before sending a walk after two have died under it
 * in a row. The first goes straight away — a walk dies for a moment's reason
 * far more often than a lasting one, and the picture is moving. A reader that
 * cannot get through the file at all would otherwise send one per frame, each
 * paying a keyframe decode, taking the machine that is already short of it. */
const WALK_RETRY_MS = 250;
/**
 * What a walk in progress is still good for.
 *
 * Every rule about keeping or dropping a walk is here, away from the source's
 * mutable state, because the rules are the part that is easy to get wrong and
 * hard to see wrong: the failures they prevent take minutes of playback on a
 * slow machine to show up, and read as "the video goes choppy" rather than as
 * anything a stack trace names.
 *
 * `hold` keeps the walk and pulls it. `hop` ends it and sends the next one
 * ahead of the reader, which is the answer to a walk the playhead has outrun.
 * `restart` ends it and sends the next one exactly where the reader asked,
 * which is the answer to a reader the walk cannot serve from where it is.
 */
export type WalkClaim = "hold" | "hop" | "restart";

export function walkClaim(w: {
  /** The moment being asked for. */
  t: number;
  /** Where the reader stood when this walk was sent — at or behind `from`. */
  walkFor: number;
  /** Where the walk was anchored. */
  from: number;
  /** The last frame it landed; `walkFor` until one lands. */
  tail: number;
  /** Whether it has landed a frame yet. */
  landed: boolean;
  /** Whether the ring holds `t` already. */
  covered: boolean;
  /** Whether the ring holds any frame at or before `t`. A walk keeping its
   * lookahead leaves the frame on screen behind it, so this is true for the
   * whole of an ordinary play. It is false when the reader has come back to a
   * moment the walk left behind long ago — a montage replayed from the top,
   * a clip re-entered from an earlier point — where every frame the ring
   * holds is ahead of the reader and the walk, which only moves forward, is
   * never going to land the one it needs. */
  heldBefore: boolean;
  /** How long it has been coming, in seconds. */
  comingS: number;
  /** Whether the reader is moving with the clock. A paused one is served by
   * the backward walk and by `pumpSeek`'s seek, so a walk it cannot use is
   * left alone: ending one costs a keyframe decode that competes with the
   * fetch actually painting the picture, and on a slow machine that is a drag
   * position that never paints at all. */
  playing: boolean;
}): WalkClaim {
  // The frame is in hand. Nothing about the walk can improve on that.
  if (w.covered) return "hold";
  // The reader is somewhere the walk was never sent for, or somewhere it has
  // been and gone with nothing left of it in the ring. A walk only moves
  // forward, so it is never going to arrive there. The tail is measured with
  // the lookahead's slack so a walk merely holding its lead is left alone.
  const behind =
    w.playing &&
    (w.t < w.walkFor - SAME || (!w.heldBefore && w.t < w.tail - DECODE_AHEAD_S));
  if (!w.landed) {
    // Nothing landed means the walk is still doing the only work that can
    // produce a picture — finding the keyframe before its anchor, fetching the
    // bytes it sits in, decoding forward to it. Starting another throws all of
    // that away and asks for it again, so it is left alone while it has any
    // prospect of landing where the reader is. Past that, waiting only widens
    // the gap: the playhead runs for as long as the walk keeps coming.
    if (!behind && (w.comingS <= LAG_HOP_S || w.t <= w.from + LAG_HOP_S)) return "hold";
    return behind ? "restart" : "hop";
  }
  // Outrun: the playhead is past the last frame it landed by more than the
  // allowance, so the frames it is about to land are already history.
  const outrun = w.t > w.tail + LAG_HOP_S;
  if (!(outrun || behind)) return "hold";
  return outrun ? "hop" : "restart";
}

/**
 * How long recent walks took to land their first frame, newest last.
 *
 * A walk begins at the keyframe before the time asked for and decodes forward
 * to it, so this is the real price of reaching a clip that is not already
 * open — and it is the number that separates one machine from another far
 * better than any count of cores. With hardware decode behind it a walk lands
 * in a fraction of the time it takes to play the clip. With every stream on
 * the CPU, and a keyframe a couple of seconds back, the same walk can take
 * longer than the clip is on screen. The median over a dozen of them is what
 * the engine's log reports, and it is the first thing to read when a preview
 * is stuttering on a machine that is not this one.
 */
const WALK_COSTS: number[] = [];
const WALK_SAMPLES = 12;
/** Walks timed before the median is worth reading. */
const WALK_MIN = 4;

function noteWalkCost(ms: number): void {
  WALK_COSTS.push(ms);
  if (WALK_COSTS.length > WALK_SAMPLES) WALK_COSTS.shift();
}

/** The median time a recent walk took to land its first frame, in
 * milliseconds; zero until enough of them have been timed to mean anything. */
export function walkCostMs(): number {
  if (WALK_COSTS.length < WALK_MIN) return 0;
  const xs = [...WALK_COSTS].sort((a, b) => a - b);
  return Math.round(xs[xs.length >> 1]);
}

/** Two source times closer than this are the same frame. */
const SAME = 1e-4;
/**
 * The backward walk.
 *
 * Frames decode forward from a keyframe, so a pointer moving backward reads
 * against the only direction the decoder has: every position it crosses sits
 * behind the frames already decoded, and asking the file for each one means a
 * keyframe walk per pointer step — the cost the `<video>` element charged.
 *
 * So backward motion is served the way forward motion is, by a walk that
 * keeps landing frames where the pointer is about to be — below it. One fill
 * decodes from the keyframe to the pointer and keeps the `BACK_WINDOW` frames
 * ending at it, every one of them, at full size. The pointer then crosses
 * that window from memory, and while it does the next window down is already
 * landing, so a creep backward costs one keyframe decode per window and never
 * waits between them. The windows live on their own sink, whose pool holds
 * two of them: the one the pointer is in stays valid while the next lands.
 *
 * A drag faster than the fills outruns the windows. For that, the first fill
 * into a keyframe span also spreads `BACK_COARSE` frames over the whole span
 * at half the decode height, through a second small sink, so every position
 * in the span has a picture near it before the fine windows get there. The
 * fine frame replaces it the moment one lands.
 */
export const BACK_WINDOW = 10;
/** Canvases the backward sink cycles: two windows, each with the frame a fill
 * can open on below its window, and the frame being drawn. The fine ring holds
 * as many as the pool keeps valid, so two whole windows stay in hand. */
const BACK_POOL = (BACK_WINDOW + 1) * 2 + 2;
const BACK_COARSE = 16;
const BACK_COARSE_POOL = BACK_COARSE + 2;
/** A coarse frame stands in only while nothing sharper is within this of the
 * pointer; a fine frame a couple of frames off beats a coarse one that is
 * closer, so the picture never flickers between the two at a window's edge. */
const BACK_NEAR_S = 0.1;
/** A paused read this far from everything the backward walk holds is a
 * gesture that has moved on; its frames are dropped. */
const BACK_FAR_S = 2.5;
/** Frames a source must go unwanted before the pool will suspend it. About a
 * second of playback — long enough that crossing a cut and coming back finds
 * the decoder still open. */
const EVICT_GRACE = 90;
/**
 * Canvas backing the pool may hold in stood-down sources, past the ones the
 * decoder budget is keeping live.
 *
 * A suspended source has let go of its decoder but keeps the parsed file and
 * the sink whose canvases its frames land on, and the canvases are what this
 * budget is about. They must not churn: allocating them floods the GPU
 * process, and a montage of short clips replayed for a few minutes — every
 * pass reopening every clip's source, each open minting a sink's worth of
 * canvases — grinds the whole tab down until frames stop arriving at all. They
 * also must not pile up: a sink's pool is `POOL` full-size canvases, so
 * counting sources rather than pixels would keep as many of them at 4K as at
 * 360p and put gigabytes behind a large stage.
 *
 * So the warm shelf is capped by the memory itself, at four bytes a pixel.
 * What that buys is decided by the decode size: a small stage keeps a
 * montage's whole cast warm, a large one keeps a few — the right trade in both
 * directions, since the big frames are the expensive ones to hold and the
 * cheap ones to lose. The live sources are governed by the decoder budget
 * alone: closing one the picture is about to need would trade the churn back
 * for a black frame.
 */
const WARM_PIXELS = 96e6;
/** Stood-down sources kept regardless of the pixel budget, so a project of
 * tiny frames cannot leave hundreds of parsed files open. */
const WARM_KEEP_MAX = 32;
/**
 * Source pixels the live decoders may cover between them.
 *
 * A decoder costs the file's own frame size, whatever size the picture is
 * drawn at: the hardware decodes every frame at full resolution and holds a
 * dozen or so of them between the file and the canvas. At 4K that is hundreds
 * of megabytes a decoder, and a dozen of them is most of a laptop's memory.
 * So under the decoder count, idle decoders also stand down by the pixels
 * they cover, most recently read kept first. The budget fits the whole count
 * at 1080p and holds four at 4K.
 */
const LIVE_PIXELS = 34e6;
/**
 * Decoded frames a live decoder is holding at once.
 *
 * The patched decode pump gives a stream a head start of this many packets and
 * counts what has gone in against what has come back out, so a stream that is
 * not being read stops here, short of the platform decoder. It is
 * the multiplier that turns a source's frame size into what its decoder costs
 * — see `site/patches/mediabunny+1.55.5.patch`.
 */
const DECODER_FRAMES = 16;
/** A failed open tries again this much later, growing per attempt over the
 * first `RETRIES` tries, so a network blip heals within seconds. */
const RETRY_MS = 1000;
const RETRIES = 3;
/** Past the quick tries, a failed source keeps itself willing on this
 * cadence. An open error is the healable kind of failure — a network stall, a
 * signed URL that expired mid-session — and the heal costs one open attempt
 * per interval, paid only while something still draws the clip: the timer
 * clears the mark and nudges a redraw, and the next ask is what reopens. A
 * file with no track this browser can decode stays latched; that verdict is
 * durable and books no timer. */
const FAIL_RECHECK_MS = 10_000;

/** A clip's picture at an instant, with where it came from. */
export interface SourceFrame {
  image: CanvasImageSource;
  width: number;
  height: number;
  /** The frame's own timestamp in the source, for telling a held frame from a
   * fresh one. */
  timestamp: number;
}

const frameOfCanvas = (c: WrappedCanvas): SourceFrame => ({
  image: c.canvas,
  width: c.canvas.width,
  height: c.canvas.height,
  timestamp: c.timestamp,
});

/** What the ring stores: a frame and the stretch of source it stands for. */
export interface Timed {
  timestamp: number;
  duration: number;
}

/**
 * Decoded frames in the order they arrived, oldest dropped first.
 *
 * The order matters more than it looks. The sink hands out canvases from a
 * fixed pool and reuses the oldest once it wraps, so holding a reference past
 * the pool's length means holding a canvas something else has drawn on. Bounded
 * by arrival, the ring can only ever name canvases the pool still considers
 * ours.
 */
export class FrameRing<T extends Timed> {
  private items: T[] = [];

  constructor(private readonly cap: number) {}

  get size(): number {
    return this.items.length;
  }

  get newest(): number {
    return this.items.length ? this.items[this.items.length - 1].timestamp : -Infinity;
  }

  /** The earliest timestamp held, which is where a walk's buffer begins. */
  get oldest(): number {
    let min = Infinity;
    for (const i of this.items) min = Math.min(min, i.timestamp);
    return min;
  }

  /** The latest timestamp held. `newest` is the last one to arrive; a walk
   * landing windows downward arrives newest at the bottom. */
  get last(): number {
    let max = -Infinity;
    for (const i of this.items) max = Math.max(max, i.timestamp);
    return max;
  }

  push(item: T): void {
    this.items.push(item);
    while (this.items.length > this.cap) this.items.shift();
  }

  clear(): void {
    this.items = [];
  }

  /**
   * The frame covering `t`: the last one starting at or before it. Before the
   * first frame held, the earliest — at a clip's head that is the frame the cut
   * opens on, and showing it beats showing nothing.
   *
   * `from`/`to` bound the answer to frames whose span overlaps that window.
   * Two clips split from one file share a ring, and near the split the nearest
   * frame is often from the other clip's side of the cut — a paused playhead
   * just past a scene change would show the old scene and call it held. A clip
   * asking within its own source span can only ever be answered from it; with
   * nothing held there yet, no answer is the honest one, and the reader keeps
   * its last painted picture until the right frame lands.
   */
  at(t: number, from = -Infinity, to = Infinity): T | null {
    let pick: T | null = null;
    for (const i of this.items) {
      if (i.timestamp > to + SAME) continue;
      if (i.timestamp + Math.max(i.duration, SAME) < from - SAME) continue;
      pick = FrameRing.nearer(t, pick, i);
    }
    return pick;
  }

  /** Of two frames, the one `at` would pick for `t`: a frame at or before `t`
   * beats one after it; of two before, the later; of two after, the earlier.
   * The one selection policy, shared with callers merging answers from two
   * rings. */
  static nearer<T extends Timed>(t: number, a: T | null, b: T | null): T | null {
    if (!a || !b) return a ?? b;
    const aBefore = a.timestamp <= t + SAME;
    const bBefore = b.timestamp <= t + SAME;
    if (aBefore !== bBefore) return aBefore ? a : b;
    if (aBefore) return a.timestamp >= b.timestamp ? a : b;
    return a.timestamp <= b.timestamp ? a : b;
  }

  /** The frame nearest `t` in either direction, for a reader that is not
   * moving with the clock and only wants the closest picture it can get. */
  atNearest(t: number, from = -Infinity, to = Infinity): T | null {
    let pick: T | null = null;
    for (const i of this.items) {
      if (i.timestamp > to + SAME) continue;
      if (i.timestamp + Math.max(i.duration, SAME) < from - SAME) continue;
      if (!pick || Math.abs(i.timestamp - t) < Math.abs(pick.timestamp - t)) pick = i;
    }
    return pick;
  }

  /**
   * Whether `t` is genuinely covered, rather than answered by a held frame.
   *
   * A frame stands for its own timestamp up to the next one, which is what its
   * duration says. Asking the frame rather than the ring's extent gets the same
   * answer for a walk that has run past `t` and for a single frame fetched at
   * `t`, so a scrub and a playback agree on what "we have this one" means.
   */
  covers(t: number): boolean {
    return this.items.some(
      (i) => t >= i.timestamp - SAME && t < i.timestamp + Math.max(i.duration, SAME) + SAME
    );
  }

  /** Whether any frame held starts at or before `t`. */
  hasAtOrBefore(t: number): boolean {
    return this.items.some((i) => i.timestamp <= t + SAME);
  }

  /** How many frames held start at or after `t`. */
  aheadOf(t: number): number {
    let n = 0;
    for (const i of this.items) if (i.timestamp >= t - SAME) n++;
    return n;
  }

  /** How many frames held lie inside [from, to]. */
  between(from: number, to: number): number {
    let n = 0;
    for (const i of this.items) if (i.timestamp >= from - SAME && i.timestamp <= to + SAME) n++;
    return n;
  }

}

/** A backward walk's state — see `BACK_WINDOW`. */
interface BackWalk {
  /** The fine windows landed, newest at the bottom. Bounded by arrival to
   * what the backward sink's pool still holds. */
  fine: FrameRing<WrappedCanvas>;
  /** The coarse spread over the keyframe span, at half size. */
  coarse: FrameRing<WrappedCanvas>;
  /** The lowest fine frame landed. */
  floor: number;
  /** The moment the pointer last asked for. */
  want: number;
  /** The top of the last window sent, and how many frames it landed. */
  sentFor: number | null;
  landed: number;
  /** The keyframe the coarse frames were spread from. */
  coarseKt: number | null;
  /** The fill in flight. */
  run: Promise<void> | null;
}

/**
 * One decoder and its ring.
 *
 * A source is opened for a clip's *mapping* rather than for its asset: same
 * file, same speed, same source-time offset means the same picture at every
 * instant, so a tiled reveal playing one file across many tracks decodes once,
 * and a plain split reads straight across its own cut. Two different trims of
 * one file keep their own sources, which is what lets a same-source dissolve
 * show two distinct frames.
 */
export class ClipFrameSource {
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  private sink: FrameCanvasSink | null = null;
  private ring = new FrameRing<WrappedCanvas>(RING);
  /** A still's single frame; stills never stream. */
  private still: SourceFrame | null = null;
  private opening: Promise<void> | null = null;
  /** Bumped each time the source is sent to a new address. An open that comes
   * back to find the count moved built its stack for an address the source
   * has since left. */
  private aim = 0;
  private closed = false;
  /** Set when the file turns out to hold no picture this browser can read. */
  private unreadable = false;
  /** Failed opens so far, and the timer that will clear `unreadable` for the
   * next try. */
  private attempts = 0;
  private retryTimer = 0;

  /** The forward walk, when one is running, where it started, and the last
   * frame it landed. Steering reads only these two numbers: the ring is a
   * cache that may also hold frames left by other gestures — a jump's single
   * frame, a spent walk — and a min/max over that sparse set has holes in it
   * that read as coverage. */
  private stream: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  /**
   * A walk on its way, before it is a walk.
   *
   * Starting one awaits the file and the drain of whatever it replaced, and
   * both of those can take real time — the replaced drain is often parked on a
   * read that is waiting for bytes. Without this the walk does not exist yet
   * as far as `pumpStream` can tell, so every tick in that window starts
   * another, each one moving the anchor the one before it was checked
   * against, so every one of them bails and none of them ever runs. Measured
   * on the eval's throttled link, one play was starting nearly three hundred
   * walks and completing a handful.
   */
  private pullWait = 0;
  private slowPullAt = 0;
  private starting: Promise<void> | null = null;
  private streamFrom = 0;
  private streamTail = 0;
  /** When the current walk was started, and whether it has landed anything
   * yet, for timing what reaching a clip costs on this machine. */
  private walkAt = 0;
  private walkFirst = false;
  /** What this source's last walk took to land its first frame, in seconds.
   * The median in `walkCostMs` is across every source on this machine; one
   * file being read over a link that cannot keep up costs far more than that
   * median, and this is what says so. */
  private lastWalkS = 0;
  /** A walk was torn down for running behind and its replacement has yet to
   * start. The intent has to outlive the open, since starting a walk awaits
   * the file and the previous drain, and every tick in between would otherwise
   * re-anchor at the playhead and undo the lead. */
  private hopping = false;
  /**
   * The moment the walk was sent for — where the reader stood, which is at or
   * behind the anchor once a lead is added.
   *
   * It is the walk's lower edge. A walk serves a reader moving forward through
   * it; a reader that asks from behind it is somewhere the walk is never going
   * to reach, since a walk only moves forward. That happens for real: a
   * montage replayed from the top asks every clip for its first frame while
   * the walk from the previous pass sits at the clip's last, and a clip
   * re-entered from an earlier point does the same. Without this edge such a
   * walk is held forever and the clip shows a frame from the pass before.
   */
  private walkFor = 0;
  /** The furthest a walk has ended short of the file — see `END_SLACK_S`. */
  private shortEndAt = -1;
  /**
   * Where this file's picture actually stops, off the video track.
   *
   * The asset's own duration is the container's, which is as long as its
   * longest track — an audio track outlasting the picture moves it. This is
   * the video track's, off the file's metadata. Reading it off the last packet
   * instead would be exact, and is the wrong trade: finding that packet means
   * reading toward the end of the file, and on the link this rule exists for
   * that competes with the frames the reader is waiting for. Measured on a
   * throttled link, a montage of twelve sources doing it stalled playback
   * outright.
   */
  private fileEnd: number | null = null;
  /** When a walk last ended without reaching what it was sent for, how many
   * have done so in a row, and the moment they were sent for, for the backoff
   * in `pumpStream`. */
  private failedAt = 0;
  private failStreak = 0;
  private failedFor = -1;
  /** The walk ran off the end of the file. Its span is still the truth — there
   * are no frames past its tail to decode — so a reader inside it must not
   * keep restarting a walk that can only end again. */
  private streamDone = false;
  /** The drain in flight, when one is. A seek that replaces the stream awaits
   * this so the old drain has truly let go before the new walk is pulled. */
  private drainRun: Promise<void> | null = null;
  /** The time a paused reader last asked for, and whether a read is in flight.
   * Latest wins: a fast drag decodes where it stopped, never every point it
   * crossed. */
  private wanted: number | null = null;
  private reading = false;

  /** The backward walk in progress — see `BACK_WINDOW`. Null while the
   * paused reader is still, moving forward, or playing. */
  private back: BackWalk | null = null;
  /** The sinks the backward walk lands on: full size for the fine windows,
   * half for the coarse span. Kept across gestures while the source is live,
   * since their pools are the canvases and canvases must not churn. */
  private backSink: FrameCanvasSink | null = null;
  private backCoarseSink: FrameCanvasSink | null = null;
  /** The backward walk is serving the paused reader: its last ask came from
   * behind, and the forward seek stands aside. Cleared the moment the reader
   * moves up again, whether or not the walk's frames are kept. */
  private backOwns = false;
  /** The source's frame period, off the last frame that landed. Sizes the
   * backward windows; a guess until a frame has said. */
  private frameDt = 1 / 30;
  /** The last paused position asked for, which is how a backward drag is
   * recognized: the next ask lands earlier than this one. */
  private lastAsk: number | null = null;

  /** The engine's tick number when this was last asked for anything, for the
   * pool's eviction order. */
  touched = 0;

  /** When the pull awaiting the walk's next frame started, for the debug dump. */
  private nextStartedAt = 0;

  /** Stood down: no decoder, file and sink still held. See `suspend`. */
  private asleep = false;

  get suspended(): boolean {
    return this.asleep;
  }

  /**
   * Canvas backing this source can be holding: the sink's pool at the decode
   * size, which is the frame height asked for and the file's own aspect. Read
   * before the sink has opened — the pool budget has to decide what a source
   * would cost, and a decode not yet started still costs it a moment later.
   */
  get keptPixels(): number {
    if (this.asset.type === "image") return this.still ? this.height * this.height * 2 : 0;
    const aspect =
      this.asset.width && this.asset.height ? this.asset.width / this.asset.height : 16 / 9;
    const width = Math.min(Math.round(this.height * aspect), this.asset.width ?? Infinity);
    return POOL * width * this.height;
  }

  /**
   * Every canvas this source is holding.
   *
   * `keptPixels` answers what a stood-down source would still cost, which is
   * what the warm shelf is filled by. A source being read holds that same pool
   * and, while a backward gesture is on it, two more: the fine windows at the
   * decode size and the coarse span at half of it. Those are the biggest thing
   * in the tab during a scrub, so a report of what the editor holds has to
   * count them.
   */
  get canvasPixels(): number {
    const one = this.keptPixels / POOL;
    return (
      this.keptPixels +
      (this.backSink ? one * BACK_POOL : 0) +
      (this.backCoarseSink ? (one / 4) * BACK_COARSE_POOL : 0)
    );
  }

  /** Pixels in a frame of the file, which is what its decoder's held frames
   * cost whatever size the picture is drawn at. */
  get decodePixels(): number {
    if (this.asset.type === "image") return 0;
    return (this.asset.width ?? 1920) * (this.asset.height ?? 1080);
  }

  /** What this source's decoder is holding in the platform's decoder, which is
   * nothing at all once it has stood down. */
  get decoderBytes(): number {
    return this.asleep ? 0 : decodedFrameBytes(this.decodePixels) * DECODER_FRAMES;
  }

  /** The URL this source is reading. The pool compares it against the store's
   * current one, so a re-minted signed URL replaces the source under it. */
  get url(): string {
    return this.asset.url;
  }

  constructor(
    private asset: MediaAsset,
    private readonly height: number,
    /** Called whenever a frame lands. A paused editor draws the nearest frame
     * it has and stops; without a nudge, the exact frame would decode into a
     * ring nothing looks at again. */
    private readonly onFrame: () => void = () => {},
    /** Called when a backward walk starts here. Backward frames are two
     * sinks' worth of canvases, so the pool keeps them only on the sources
     * the current frame reads, and this is how the rest learn to let theirs
     * go. */
    private readonly onBack: () => void = () => {}
  ) {}

  /** Decoded frames held right now, for the pool's budget and the perf trace. */
  get held(): number {
    const b = this.back;
    return this.ring.size + (b ? b.fine.size + b.coarse.size : 0) + (this.still ? 1 : 0);
  }

  /** End the backward walk and let go of its frames. `release` also lets go
   * of the sinks they landed on — the canvases — for a source that will not
   * be backed through again soon. */
  dropBack(release = false): void {
    if (this.back) poolLog(`back drop ${this.asset.fileName}${release ? " (release)" : ""}`);
    this.back = null;
    this.backOwns = false;
    if (release) {
      this.backSink = null;
      this.backCoarseSink = null;
    }
  }

  /** What this source is doing, for the perf eval's pool dump. */
  debugState(): Record<string, unknown> {
    return {
      url: this.asset.url.slice(-24),
      ring: this.ring.size,
      oldest: this.ring.size ? +this.ring.oldest.toFixed(2) : null,
      newest: this.ring.size ? +this.ring.newest.toFixed(2) : null,
      still: !!this.still,
      opened: !!this.sink,
      opening: !!this.opening,
      unreadable: this.unreadable,
      attempts: this.attempts,
      walking: !!this.stream,
      draining: !!this.drainRun,
      streamFrom: +this.streamFrom.toFixed(2),
      streamTail: +this.streamTail.toFixed(2),
      streamDone: this.streamDone,
      reading: this.reading,
      wanted: this.wanted,
      back: this.back
        ? {
            fine: this.back.fine.size,
            coarse: this.back.coarse.size,
            floor: Number.isFinite(this.back.floor) ? +this.back.floor.toFixed(2) : null,
            want: +this.back.want.toFixed(2),
            filling: !!this.back.run,
          }
        : null,
      touched: this.touched,
      suspended: this.asleep,
      keptMb: +(this.keptPixels * 4e-6).toFixed(1),
      nextPendingMs: this.nextStartedAt ? Math.round(performance.now() - this.nextStartedAt) : 0,
    };
  }

  get ready(): boolean {
    return this.still !== null || this.ring.size > 0;
  }

  /**
   * What the walk is waiting on right now, in milliseconds.
   *
   * The smoothed cost of pulls that have finished, and the age of one still in
   * flight — whichever is worse. A pull sitting two seconds on bytes that have
   * not arrived only enters the average when it lands, so an average alone
   * reads as healthy exactly when the reader is most starved.
   */
  get pullWaitMs(): number {
    const inFlight = this.nextStartedAt ? performance.now() - this.nextStartedAt : 0;
    return Math.max(this.pullWait, inFlight);
  }

  /**
   * The walk is short of bytes rather than short of decode.
   *
   * The one place that judgement is made. A caller comparing `pullWaitMs`
   * against a threshold of its own would have to keep that number in step with
   * the one a slow pull is marked by, in another file, with nothing to catch
   * them drifting apart.
   */
  get byteBound(): boolean {
    const now = performance.now();
    if (this.slowPullAt && now - this.slowPullAt < SLOW_PULL_HOLD_MS) return true;
    return this.pullWaitMs > SLOW_PULL_MS;
  }

  get failed(): boolean {
    return this.unreadable;
  }

  /**
   * The best picture this source has for source time `t`, without waiting.
   *
   * Exact when the ring holds the frame covering `t`; otherwise the nearest
   * frame before it, which is what a decoder running slightly behind should
   * show. `from`/`to` bound the answer to the asking clip's source span — see
   * `FrameRing.at`. Null when nothing decoded yet answers inside it.
   */
  frameAt(t: number, from = -Infinity, to = Infinity): SourceFrame | null {
    if (this.still) return this.still;
    const b = this.back;
    let c = FrameRing.nearer(t, this.ring.at(t, from, to), b?.fine.at(t, from, to) ?? null);
    // A coarse frame stands in only where nothing sharp is near: the pointer
    // has outrun the fine windows, and a half-size picture close to it beats a
    // full-size one from somewhere else.
    if (b && (!c || Math.abs(c.timestamp - t) > BACK_NEAR_S)) {
      const rough = b.coarse.atNearest(t, from, to);
      if (rough && (!c || Math.abs(rough.timestamp - t) < Math.abs(c.timestamp - t))) c = rough;
    }
    return c ? frameOfCanvas(c) : null;
  }

  /** Whether a frame covering `t` exactly is already held. Coarse frames do
   * not count: they are a picture near `t`, at half size. */
  hasExact(t: number): boolean {
    return this.still !== null || this.ring.covers(t) || (this.back?.fine.covers(t) ?? false);
  }

  /**
   * Say where this clip is being read, and let the source decide how to keep up.
   *
   * `playing` walks forward from `t` and stays `DECODE_AHEAD_S` ahead of it;
   * paused, a single frame is fetched for `t` and the newest ask wins.
   * `backward` says the paused reader is moving down the timeline — the
   * engine knows this across clips, where one source's own asks cannot: a
   * pointer backing into a clip arrives at its last frame, which is above
   * everything that source was ever asked for.
   */
  want(t: number, playing: boolean, backward = false): void {
    if (this.closed || this.unreadable) return;
    // Being read is what wakes a stood-down source; the walk below is what
    // gives it a decoder again.
    this.asleep = false;
    if (this.asset.type === "image") {
      void this.openStill();
      return;
    }
    void this.open();
    if (playing) {
      this.wanted = null;
      this.lastAsk = null;
      // Playback reads forward; the backward walk's frames are dead weight,
      // and so are the canvases under them for as long as the play lasts.
      this.dropBack(true);
      this.pumpStream(t, true);
    } else {
      const prev = this.lastAsk;
      this.lastAsk = t;
      const b = this.back;
      // Reading far from everything the backward walk holds means the gesture
      // it served has moved on; the next backward step starts its own.
      if (
        b &&
        (t > Math.max(b.fine.last, b.want) + BACK_FAR_S ||
          t < Math.min(b.floor, b.want) - BACK_FAR_S)
      )
        this.dropBack();
      const backing = backward || (prev !== null && t < prev - SAME);
      if (this.hasExact(t)) {
        // The frame is in hand and the reader is still heading down: keep the
        // next window landing under it.
        if (backing) this.backAsk(t);
        return;
      }
      // Moving backward reads against the decode direction, where the forward
      // walk and its lookahead cannot help. The backward walk owns the reader
      // from here until it moves up again: a pointer resting below its last
      // ask is waiting on a window, and the forward seek below would send a
      // second decoder after the same keyframe span.
      const resting = this.backOwns && this.back !== null && t <= this.back.want + SAME;
      if (backing || resting) {
        this.stopStream();
        this.wanted = null;
        this.hopping = false;
        this.backOwns = true;
        this.backAsk(t);
        return;
      }
      this.backOwns = false;
      // A drag creeping along is a forward walk, not a series of jumps. Asking
      // the file for each position separately means decoding from the nearest
      // keyframe every time — the same cost the `<video>` element charged. If
      // the wanted frame is inside the walk or just ahead of the last frame
      // that arrived, keep walking and each step costs one frame. The last
      // arrival is the only ring fact consulted: anything older may be a
      // leftover from some other gesture entirely.
      const walkEdge = Math.max(this.streamFrom, this.streamTail);
      const nearWalk = this.stream !== null && t >= walkEdge - SAME && t < walkEdge + 0.5;
      // A walk that has ended cannot be crept along, and the frames past its
      // tail are not coming from it. Creeping is offered to it anyway, the ask
      // reaches `pumpStream`, whose finished branch has nothing to do and says
      // so by doing nothing: no walk, no fetch, no frame, and no repaint to
      // ask again on. Every later position is then unanswerable for as long as
      // the reader stays past that tail. The single-frame fetch below is what
      // answers here, and it answers whether or not the tail really was the
      // end of the film.
      const nearLast =
        !this.streamDone &&
        this.ring.size > 0 &&
        t >= this.ring.newest - SAME &&
        t < this.ring.newest + 0.5;
      if (nearWalk || nearLast) {
        this.pumpStream(t, false);
        return;
      }
      // A real jump: drop the walk and fetch the one frame. Newest ask wins, so
      // a fast drag decodes where it stopped rather than everywhere it crossed.
      this.stopStream();
      // A paused reader wants the frame under the pointer, not one the lead
      // would have aimed past it.
      this.hopping = false;
      // The jump also starts a new walk story. A finished flag left over from
      // the old walk would pin playback to the seeked frame on resume: the
      // ring covers it, so no walk would restart until the frame aged out.
      this.streamDone = false;
      this.wanted = t;
      void this.pumpSeek();
    }
  }

  /**
   * Stand down without letting go of the file.
   *
   * The walk ends — which is what releases the decoder — while the parsed
   * input and the sink stay, so waking this source later costs one keyframe
   * seek on canvases it already owns. The ring is dropped with the walk: a
   * revival starts a fresh walk on the same sink, whose pool then recycles the
   * canvases the ring's old frames live on, and a held reference would show
   * whatever the new walk drew over it.
   *
   * Standing down is a state rather than an act, so the pool can name the same
   * source every frame and only the first one does anything.
   */
  suspend(): void {
    if (this.asleep) return;
    this.asleep = true;
    this.stopStream();
    this.streamDone = false;
    this.hopping = false;
    this.ring.clear();
    this.dropBack(true);
    this.wanted = null;
    this.lastAsk = null;
  }

  close(): void {
    this.closed = true;
    this.stopStream();
    this.ring.clear();
    this.dropBack(true);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    // A still's bitmap holds real memory the GC can't see the size of.
    if (this.still && this.still.image instanceof ImageBitmap) this.still.image.close();
    this.still = null;
    this.input?.dispose();
    this.input = null;
    this.track = null;
    this.sink = null;
  }

  /**
   * Move this source onto the asset's current address, keeping every frame it
   * holds.
   *
   * An asset's URL moves while its clips are mid-play: an import lands in
   * project storage and leaves the URL it arrived on, a signed link re-mints
   * ahead of expiry. The same pictures now live at the new address, so the
   * ring keeps answering while a fresh stack — file, track, sink — opens on
   * that address behind it, exactly the way a voice plays out its scheduled
   * sound across the same move. The old stack serves reads until the new one
   * is ready: the import queue holds the source bytes for this window, and a
   * re-minted link is still inside its signing window. Once the stack swaps,
   * the next ask starts a walk from wherever the reader stands, on canvases
   * the ring's held frames no longer live on.
   */
  retarget(asset: MediaAsset): void {
    this.asset = asset;
    if (this.closed || asset.type === "image") return;
    const aim = ++this.aim;
    // Nothing open and nothing opening: the next ask opens the new address.
    if (!this.input && !this.opening) return;
    void (async () => {
      // An open in flight built its stack for the old address; it settles
      // first, so the swap below replaces a stack that has stopped moving.
      try {
        await this.opening;
      } catch {}
      if (this.closed || this.aim !== aim) return;
      const input = openMedia(this.asset.url);
      try {
        const track = await videoTrackOf(input);
        if (this.closed || this.aim !== aim) return input.dispose();
        if (!track) {
          input.dispose();
          this.fail();
          return;
        }
        const sink = frameSink(track, { height: this.height }, { poolSize: POOL, lowLatency: true });
        // The new stack installs first, so a walk starting this instant is
        // already on it; the walk still running was on the old one and ends
        // now. Its frames stay: the old sink has stopped cycling its
        // canvases, so they hold still, and they are what answers until the
        // first walk on the new stack lands. The old file is let go once the
        // old walk's drain has let go of it.
        const oldInput = this.input;
        this.input = input;
        this.track = track;
        this.sink = sink;
        this.opening = Promise.resolve();
        this.dropBack(true);
        this.stopStream();
        await this.drainRun;
        oldInput?.dispose();
        if (this.closed || this.aim !== aim) return;
        // Walk bookkeeping belongs to the stack that is gone; the new one
        // starts clean, quick retries and all.
        this.streamDone = false;
        this.shortEndAt = -1;
        this.failStreak = 0;
        this.unreadable = false;
        this.attempts = 0;
        // A paused reader is only asked again on a repaint; the nudge is what
        // sends its ask to the new stack.
        this.onFrame();
      } catch {
        input.dispose();
        // The old stack stays installed and keeps serving its ring; the
        // failure books the usual retries, and the retry's open reads the
        // current address.
        if (this.aim === aim && !this.closed) this.fail();
      }
    })();
  }

  /**
   * An open failed. That is usually a moment — a network blip, a signed URL a
   * few seconds past its window — so the source tells the link keeper (which
   * re-mints an expired URL; the pool then swaps this source out under the new
   * one) and books itself another try: quick ones first, then on a slow
   * cadence for as long as the failure holds. The cadence carries the case the
   * swap cannot: inside a signing window a re-mint returns the identical URL
   * string, so no swap ever comes, and the cadence is what bounds a
   * mid-session outage to seconds of black once reads work again.
   */
  private fail(): void {
    this.unreadable = true;
    this.opening = null;
    void import("./mediaLinks").then((m) => m.reportMediaUrlError(this.asset.url));
    if (this.closed || typeof window === "undefined") return;
    this.attempts++;
    const wait = this.attempts <= RETRIES ? RETRY_MS * this.attempts : FAIL_RECHECK_MS;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      if (this.closed) return;
      this.unreadable = false;
      // Nothing asks a failed source for frames, so nothing would notice it is
      // willing again without a nudge.
      this.onFrame();
    }, wait);
  }

  private open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      const input = openMedia(this.asset.url);
      try {
        const track = await videoTrackOf(input);
        if (!track) {
          input.dispose();
          this.unreadable = true;
          return;
        }
        if (this.closed) {
          input.dispose();
          return;
        }
        this.input?.dispose();
        this.input = input;
        this.track = track;
        // Not awaited: it reads metadata the sink is about to read anyway, and
        // the first frame should not wait behind it. Until it answers, the
        // container's duration stands in.
        void track
          .getDurationFromMetadata()
          .then((d) => {
            if (d !== null && d > 0) this.fileEnd = d;
          })
          .catch(() => {});
        // Height alone: the sink keeps the source's aspect and applies the
        // file's rotation, so a phone clip arrives upright at preview size and
        // no caller has to know it was ever sideways.
        this.sink = frameSink(track, { height: this.height }, { poolSize: POOL, lowLatency: true });
        // A clean open ends any failure streak: the next outage starts from
        // the quick retries again.
        this.attempts = 0;
      } catch {
        input.dispose();
        this.fail();
      }
    })();
    return this.opening;
  }

  private async openStill(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      try {
        const res = await fetch(this.asset.url, { mode: "cors" });
        const bitmap = await createImageBitmap(await res.blob());
        if (this.closed) return bitmap.close();
        this.still = {
          image: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          timestamp: 0,
        };
        this.attempts = 0;
        this.onFrame();
      } catch {
        this.fail();
      }
    })();
    return this.opening;
  }

  private stopStream(): void {
    const s = this.stream;
    this.stream = null;
    this.starting = null;
    this.nextStartedAt = 0;
    void s?.return(undefined).catch(() => {});
  }

  /**
   * Keep the forward walk running and roughly `DECODE_AHEAD_S` ahead of `t`.
   *
   * `walkClaim` decides what the walk in progress is still good for; this
   * carries the decision out. Restarting a walk throws away the buffer it has
   * built and re-decodes from the nearest keyframe, which is the hitch this
   * design exists to remove, so the default is to keep it. What a re-aim
   * repeats is the decode — the bytes the first attempt pulled are resident by
   * then (chunkCache.ts) — so the read is not paid twice.
   */
  private pumpStream(t: number, playing: boolean): void {
    if (this.starting || this.stream) {
      const claim = walkClaim({
        t,
        walkFor: this.walkFor,
        from: this.streamFrom,
        tail: this.streamTail,
        landed: !this.walkFirst,
        covered: this.ring.covers(t),
        heldBefore: this.ring.hasAtOrBefore(t),
        comingS: (performance.now() - this.walkAt) / 1000,
        playing,
      });
      if (claim === "hold") {
        void this.drain(t);
        return;
      }
      this.stopStream();
      this.hopping = claim === "hop";
    } else if (this.streamDone && (this.ring.covers(t) || t >= this.streamTail - SAME)) {
      // The walk reached where the film stops — the file's last frame, or the
      // place a second walk confirmed it ends (see the end of `drain`).
      // Inside its span the frame is already held, and past its tail there is
      // nothing left to decode: the newest frame held is the answer.
      // Restarting here would re-decode the whole tail from its keyframe once
      // per tick, forever.
      return;
    }
    // A walk that just died is not worth following straight away with another
    // that will die the same way; the ring keeps showing what it has until the
    // reader is answering again. A reader that has not moved since is worth no
    // further walks at all — the answer would be the same one, and each attempt
    // pushes a rough frame and repaints, so a parked playhead over a file that
    // reads back short costs frames for the rest of the session.
    if (this.failStreak > 1) {
      const moved = Math.abs(t - this.failedFor) > SAME;
      if (!moved || performance.now() - this.failedAt < WALK_RETRY_MS) return;
    }
    // A lead is for a playhead that keeps running. A paused reader wants the
    // moment under the pointer, so an intent left over from playback is spent.
    if (!playing) this.hopping = false;
    const from = this.hopping ? this.aheadOf(t) : t;
    poolLog(
      `walk ${this.asset.fileName} from ${from.toFixed(2)} at ${t.toFixed(2)}` +
        (this.hopping ? ` (hop, lead ${(from - t).toFixed(2)}s)` : "")
    );
    // From the ask, not from the moment the file and the previous drain let go
    // of it: waiting for those is most of what reaching a frame costs on a
    // reader that is short of bytes, and it is the reader that pays it.
    this.walkAt = performance.now();
    if (playing) meterWalk();
    this.walkFirst = true;
    this.streamFrom = from;
    this.walkFor = t;
    // The tail is the last frame landed, and this walk has landed none. It
    // starts at the playhead rather than at the anchor so the first pull is
    // not mistaken for a lookahead that is already deep enough.
    this.streamTail = t;
    this.streamDone = false;
    const run = this.startStream(from);
    this.starting = run;
    // Only this start's own settle clears the claim. A start that was
    // superseded settles too, and left to clear the field unconditionally it
    // would retract the claim of the walk that replaced it — which is the
    // window every tick in it starts another walk.
    void run.finally(() => {
      if (this.starting === run) this.starting = null;
    });
  }

  /** The source time the file's last frame sits at, as near as the asset
   * knows. Unknown durations answer with infinity, so nothing is ever taken
   * for the end. */
  private endOfFile(): number {
    if (this.fileEnd !== null) return this.fileEnd;
    return this.asset.duration > 0 ? this.asset.duration : Infinity;
  }

  /**
   * Where to anchor a walk that fell behind.
   *
   * Anchored at the playhead, a walk lands its first frame at a moment that is
   * already history: the seek took time and the playhead moved for all of it,
   * so the walk comes out of the re-anchor exactly as far behind as the
   * re-anchor cost — and is due to re-anchor again immediately. That is the
   * cycle behind a picture that creeps, freezes, jumps, and creeps again.
   * Aiming the cost ahead breaks it: the frame lands where the playhead has
   * reached, and the walk goes on from there in step with it.
   */
  private aheadOf(t: number): number {
    const lead = Math.min(LEAD_CAP_S, Math.max(walkCostMs() / 1000, this.lastWalkS));
    // Past the file's last frame the walk ends without landing anything, and
    // the picture would sit on whatever the ring still held.
    return Math.max(t, Math.min(t + lead, this.endOfFile() - 0.05));
  }

  private async startStream(from: number): Promise<void> {
    await this.open();
    // A drain still letting go of a replaced walk holds the pull loop; the new
    // walk starts once it has.
    await this.drainRun;
    if (this.closed || !this.sink || this.stream) return;
    // The read may have been overtaken while the file was opening.
    if (Math.abs(this.streamFrom - from) > SAME) return;
    this.stream = this.sink.canvases(Math.max(0, from));
    void this.drain(from);
  }

  /**
   * Land the keyframe covering `t`, when nothing near `t` is on hand.
   *
   * One index read finds it and one packet decodes it, so it shows within a
   * frame or two of the ask on any decoder — the coarse picture a drag skims
   * across. A frame already held between that keyframe and `t` is at least as
   * close, so the decode is skipped and the held frame keeps standing in.
   */
  private async roughFrame(t: number): Promise<void> {
    if (!this.track || !this.sink) return;
    const kt = await keyframeTimeAt(this.track, Math.max(0, t)).catch(() => null);
    if (kt === null || this.closed) return;
    if (this.ring.between(kt, t) > 0) return;
    const c = await this.sink.getCanvas(kt).catch(() => null);
    if (!c || this.closed) return;
    this.ring.push(c);
    this.onFrame();
  }

  /**
   * The paused reader asked for `t` from behind: land what it needs below.
   *
   * The walk is a chain of fills, each one window, run one at a time. Every
   * ask moves the walk's aim; each fill's end re-reads it and sends the next
   * fill where the aim says — see `backTarget`. The chain goes quiet on its
   * own once the pointer's window and the one below it are both in hand.
   */
  private backAsk(t: number): void {
    if (this.back) {
      this.back.want = t;
    } else {
      this.onBack();
      this.back = {
        fine: new FrameRing<WrappedCanvas>(BACK_POOL - 2),
        coarse: new FrameRing<WrappedCanvas>(BACK_COARSE),
        floor: Infinity,
        want: t,
        sentFor: null,
        landed: 0,
        coarseKt: null,
        run: null,
      };
    }
    this.pumpBack();
  }

  private pumpBack(): void {
    const b = this.back;
    if (!b || b.run || this.closed) return;
    const top = this.backTarget(b);
    if (top === null) return;
    const run = this.backFill(b, top);
    b.run = run;
    void run.finally(() => {
      if (b.run === run) b.run = null;
      if (this.back === b) this.pumpBack();
    });
  }

  /**
   * Where the next fill's window should end, or null when the walk is caught up.
   *
   * The pointer outside every window wants the window ending at it. Inside
   * the lowest window and still heading down, it wants the next one below,
   * landed before it gets there. A fill that landed nothing has reached the
   * front of the file, or a moment the file has no frame for, and the walk
   * stops there until the pointer asks for somewhere else.
   */
  private backTarget(b: BackWalk): number | null {
    if (b.sentFor !== null && b.landed === 0 && Math.abs(b.sentFor - b.want) <= SAME) return null;
    if (!b.fine.covers(b.want) && !this.ring.covers(b.want)) return b.want;
    if (b.sentFor !== null && b.landed === 0) return null;
    const dt = this.frameDt;
    const floor = this.backFloor(b);
    const next = floor - dt;
    if (next < 0) return null;
    if (b.want - floor < BACK_WINDOW * dt) return next;
    return null;
  }

  /**
   * The lowest frame held in one run below the pointer.
   *
   * The forward ring counts when it covers the pointer: a walk that ended
   * where the pointer now stands, a seek's lookahead, a clip entered from its
   * end whose tail was warmed — the backward walk carries on from under those
   * frames. Only a run touching the pointer counts; a stray frame further
   * down, such as a jump's rough keyframe, stands alone.
   */
  private backFloor(b: BackWalk): number {
    const floor = b.floor;
    if (!this.ring.covers(b.want)) return floor;
    const dt = this.frameDt;
    let t = b.want;
    for (let i = 0; i < RING * 4 && this.ring.covers(t - dt); i++) t -= dt;
    return Math.min(floor, t);
  }

  /**
   * One fill: the `BACK_WINDOW` frames ending at `top`, decoded from the
   * keyframe before them in one pass on the backward sink.
   *
   * The pass yields nothing before the window's first frame — the prefix is
   * decoded and discarded inside the sink — so the pool only ever cycles by a
   * window per fill, which is what keeps the window before it valid. The
   * first fill into a keyframe span also sends the coarse pass over the span,
   * on its own sink, alongside.
   */
  private async backFill(b: BackWalk, top: number): Promise<void> {
    b.sentFor = top;
    b.landed = 0;
    try {
      await this.open();
      if (this.closed || !this.track || this.back !== b) return;
      const kt = await keyframeTimeAt(this.track, Math.max(0, top)).catch(() => null);
      if (kt === null || this.closed || this.back !== b) return;
      const dt = this.frameDt;
      const start = Math.max(kt, top - (BACK_WINDOW - 1) * dt, 0);
      const sentAt = performance.now();
      if (b.coarseKt !== kt && start - kt > 2 * dt) {
        b.coarseKt = kt;
        void this.backCoarse(b, kt, start - dt);
      }
      this.backSink ??= frameSink(
        this.track,
        { height: this.height },
        { poolSize: BACK_POOL, lowLatency: true }
      );
      const stream = this.backSink.canvases(start);
      try {
        // The pass opens on the frame covering `start`, which can sit a frame
        // below it, so a window is one frame more than it is wide; the pool
        // has the room. It ends on the frame covering `top` — the one after
        // that belongs to the reader above, which has its own walk.
        for (let n = 0; n < BACK_WINDOW + 1; ) {
          const { value, done } = await stream.next();
          if (done || !value || this.closed || this.back !== b) break;
          if (value.duration > 0) this.frameDt = value.duration;
          if (value.timestamp > top + SAME) break;
          b.fine.push(value);
          b.floor = Math.min(b.floor, value.timestamp);
          b.landed++;
          n++;
          this.onFrame();
          if (value.timestamp + value.duration > top + SAME) break;
        }
      } finally {
        void stream.return(undefined).catch(() => {});
      }
      poolLog(
        `back fill ${this.asset.fileName} ${start.toFixed(2)}-${top.toFixed(2)} (kf ${kt.toFixed(2)}) ` +
          `landed ${b.landed} in ${Math.round(performance.now() - sentAt)}ms`
      );
    } catch {
      if (this.back === b) this.dropBack();
    }
  }

  /** Spread `BACK_COARSE` frames over `[from, to]` at half size, at least two
   * frames apart, so a span shorter than that many is not decoded twice for
   * nothing. Every frame that lands is a picture the pointer can fall back to
   * the moment it outruns the fine windows. */
  private async backCoarse(b: BackWalk, from: number, to: number): Promise<void> {
    if (!this.track) return;
    const dt = this.frameDt;
    const n = Math.min(BACK_COARSE, Math.floor((to - from) / (2 * dt)) + 1);
    if (n <= 0) return;
    const step = n > 1 ? (to - from) / (n - 1) : 0;
    const asks = Array.from({ length: n }, (_, i) => from + i * step);
    this.backCoarseSink ??= frameSink(
      this.track,
      { height: Math.max(180, Math.round(this.height / 2)) },
      { poolSize: BACK_COARSE_POOL, lowLatency: true }
    );
    const stream = this.backCoarseSink.canvasesAtTimestamps(asks);
    try {
      let last = -1;
      for (;;) {
        const { value, done } = await stream.next();
        if (done || this.closed || this.back !== b) break;
        if (!value || value.timestamp === last) continue;
        last = value.timestamp;
        b.coarse.push(value);
        this.onFrame();
      }
    } catch {
      // The fine windows carry the walk; a coarse pass that dies costs only
      // the fallback it would have landed.
    } finally {
      void stream.return(undefined).catch(() => {});
    }
  }

  /** Pull frames until the ring reaches `DECODE_AHEAD_S` past `t`. Returns the
   * run in flight when one is already pulling. */
  private drain(t: number): Promise<void> {
    if (this.drainRun) return this.drainRun;
    if (!this.stream) return Promise.resolve();
    // A run whose first stop condition already holds finishes synchronously:
    // its `finally` clears the field before the assignment below writes it,
    // and the settled promise would then sit in `drainRun` forever, answering
    // every later drain with "already pulling". The flag remembers that the
    // run is over so the assignment is undone, whichever order they land in.
    let ended = false;
    this.drainRun = (async () => {
      try {
        for (;;) {
          const stream: AsyncGenerator<WrappedCanvas, void, unknown> | null = this.stream;
          if (!stream || this.closed) break;
          // Stop at the lookahead, and stop early once the walk's own frames at
          // or past `t` fill the ring — pushing another would drop one that is
          // still wanted. Only the walk's frames count: leftovers from other
          // gestures merely age out of the cache as the walk pushes.
          if (this.streamTail >= t + DECODE_AHEAD_S) break;
          if (this.ring.between(Math.max(t, this.streamFrom), this.streamTail) >= RING - 1) break;
          const pullAt = performance.now();
          this.nextStartedAt = pullAt;
          const { value, done } = await stream.next();
          this.nextStartedAt = 0;
          // A pull that took longer than a frame is the walk waiting on
          // something — bytes that have not arrived, or a decoder that is
          // behind. Timed against a local, since a walk replaced mid-pull
          // clears the field this would otherwise read.
          const waited = performance.now() - pullAt;
          meterPull(waited);
          // What the walk is actually waiting on. A decoder that cannot keep
          // up answers every pull in about a frame period; a reader whose
          // bytes have not arrived sits on one for hundreds of milliseconds.
          // The engine reads this to tell the two apart before trading away
          // resolution, which helps the first and does nothing for the second.
          this.pullWait = this.pullWait * 0.9 + waited * 0.1;
          // One slow pull is the link talking, and averaging it away is how a
          // starved reader reads as a healthy one: a 200ms wait smoothed into
          // a 25ms average clears every bar it should have tripped. The worst
          // recent pull stands on its own until it ages out.
          if (waited > SLOW_PULL_MS) this.slowPullAt = performance.now();
          if (waited > SLOW_PULL_MS)
            poolLog(`pull waited ${Math.round(waited)}ms at ${this.streamTail.toFixed(2)}`);
          // A restart or a close while awaiting: this walk is no longer the one.
          if (this.stream !== stream) break;
          if (done || !value) {
            this.stream = null;
            // An end short of the file's last frame is a walk that failed
            // rather than a file that ended, and taking it for the file's end
            // holds the picture on the frame before it for the rest of the
            // clip. Another walk goes after the rest; one that gets no
            // further than a walk already did is the film stopping there.
            // A walk that stopped before the moment it was sent to never
            // reached the film it went for, so it says nothing about where
            // the file ends — the end of a file is never behind a moment
            // inside it. That one is a failure outright.
            const reached = this.streamTail >= this.streamFrom - SAME;
            const short = this.streamTail < this.endOfFile() - END_SLACK_S;
            const known = this.shortEndAt;
            if (short && reached) this.shortEndAt = Math.max(known, this.streamTail);
            this.streamDone = reached && (!short || this.streamTail <= known + SAME);
            if (this.streamDone) {
              // It reached the end of the film. Whatever went wrong before is
              // over.
              this.failStreak = 0;
            } else {
              this.failedAt = performance.now();
              this.failStreak++;
              this.failedFor = this.walkFor;
              // A walk that died is the aim disproved. Aiming ahead is a bet
              // that a walk sent past the reader will land there in time; one
              // that just died at that anchor has settled the bet, and taking
              // it again sends every replacement into the same place. Measured
              // on a file whose last second reads back empty, that was a walk
              // per tick, each leaping to the same dead spot, until the reader
              // itself arrived there.
              this.hopping = false;
            }
            break;
          }
          this.streamTail = value.timestamp;
          if (value.duration > 0) this.frameDt = value.duration;
          if (this.walkFirst) {
            this.walkFirst = false;
            this.hopping = false;
            // The streak counts walks that ended without getting there, and a
            // frame landing is not one of them getting there: a walk that
            // lands frames and then stops short has still failed. Cleared
            // here, a source whose every walk lands a frame and dies never
            // builds a streak, so nothing ever rate-limits it — measured, that
            // was a parked playhead paying a keyframe decode and a repaint
            // twenty-five times a second, for as long as it sat there.
            const ms = performance.now() - this.walkAt;
            noteWalkCost(ms);
            meterWalk(ms);
            this.lastWalkS = ms / 1000;
            // The file's own rate, read off the frame rather than probed: a
            // probe is packets, and packets are the thing this reader is
            // short of.
            if (value.duration > 0) {
              meterSource(
                this.asset.width ?? 0,
                this.asset.height ?? 0,
                1 / value.duration,
                this.track?.codec ?? ""
              );
            }
          }
          this.ring.push(value);
          this.onFrame();
        }
      } catch {
        this.stopStream();
      } finally {
        ended = true;
        this.drainRun = null;
      }
    })();
    if (ended) this.drainRun = null;
    return this.drainRun ?? Promise.resolve();
  }

  /**
   * Serve the position a paused reader is waiting on, newest ask first.
   *
   * The seek is a walk anchored at the ask. A single-frame fetch would build a
   * decoder, run it from the keyframe to the frame, flush it, and throw it
   * away — and the flush and the teardown are the slow part on some machines.
   * The walk decodes the same span once, lands the covering frame as it passes
   * it, and is still warm exactly where the user just landed, so the creep or
   * the play that usually follows starts on frames already in hand.
   */
  private async pumpSeek(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    // The moment a walk has already been sent after for, so an ask the file
    // cannot answer is asked twice and no more. Some asks never can be
    // answered: a transition holds the outgoing clip's last frame, which asks
    // its source for a moment past the final frame it has. Left to repeat,
    // that spins a keyframe decode per turn for as long as the pointer rests
    // there — the position never paints, and every turn pushes a rough frame
    // and repaints, so a parked playhead never goes quiet.
    let retriedFor = -1;
    try {
      await this.open();
      for (;;) {
        const t = this.wanted;
        if (t === null || this.closed || !this.sink) break;
        this.wanted = null;
        // A drag wants a picture under the pointer more than it wants the
        // exact frame. The keyframe covering `t` decodes in one packet on any
        // machine, so it lands first and holds the fort; the walk below
        // replaces it with the true frame once the pointer rests.
        await this.roughFrame(t);
        if (this.closed) break;
        // The pointer has already moved on; chase it rather than finishing
        // an exact decode nobody is looking at.
        if (this.wanted !== null) continue;
        // It moved on backward: the backward walk owns the reader now, and a
        // walk sent from here would decode the same keyframe span beside it.
        if (this.backOwns) break;
        this.stopStream();
        // Let the replaced walk's drain finish letting go, so the new walk is
        // never pulled by a loop still holding the old one.
        await this.drainRun;
        if (this.closed) break;
        // Playback took over while this ask waited; its walk owns the stream.
        if (this.stream || this.backOwns) break;
        this.streamDone = false;
        this.streamFrom = t;
        this.streamTail = t;
        // A seek's walk owns the walk state like any other. Left holding the
        // last walk's, the play that usually follows a seek would read a
        // pending flag and a start time belonging to something else.
        this.walkAt = performance.now();
        this.walkFirst = true;
        this.hopping = false;
        this.walkFor = t;
        this.stream = this.sink.canvases(Math.max(0, t));
        await this.drain(t);
        // The walk ended before it reached the ask. Whatever ended it — bytes
        // that never came, a decoder closed under it — the pointer is left on
        // the rough keyframe with nothing on the way, so this asks again. The
        // walk that finds where the film really stops sets `streamDone`, and
        // that is what ends this.
        if (
          this.wanted === null &&
          !this.stream &&
          !this.streamDone &&
          !this.hasExact(t) &&
          Math.abs(retriedFor - t) > SAME
        ) {
          retriedFor = t;
          this.wanted = t;
          continue;
        }
        // Another position was asked for while this one decoded; that one is
        // where the pointer actually is now.
        if (this.wanted === null) break;
      }
    } catch {
      this.wanted = null;
    } finally {
      this.reading = false;
    }
  }
}

/**
 * The live decoders.
 *
 * A decoder is not free: an open read against the file, a demuxer, and one of
 * the small number of hardware decode slots a tab is given. Past that limit
 * decoding falls back to software, and since sound stays real-time while frames
 * arrive late, the picture drifts behind the audio. So the pool is capped, and
 * the sources this frame is built from are never the ones evicted.
 */
export class FrameSourcePool {
  private sources = new Map<string, ClipFrameSource>();
  private tick = 0;

  private readonly release: () => void;

  constructor(
    private budget = 10,
    private readonly onFrame: () => void = () => {}
  ) {
    const stopDecoders = holdMemory("decoders", () => this.decoderBytes);
    const stopCanvases = holdMemory("canvases", () => this.canvasBytes);
    this.release = () => {
      stopDecoders();
      stopCanvases();
    };
  }

  /** Advance the clock the eviction order is measured on. */
  beginFrame(): void {
    this.tick++;
  }

  /**
   * The source for one clip mapping, opening it if this is the first ask.
   * `key` must identify a mapping — same file, speed and source-time offset —
   * so clips showing identical pictures share one decoder.
   */
  get(key: string, asset: MediaAsset, height: number): ClipFrameSource {
    const id = `${key}|${height}`;
    let src = this.sources.get(id);
    // The mapping names which pictures; the URL is where they are read from,
    // and it moves — an import lands in project storage, a signed link
    // re-mints. The source follows the move in place, holding every frame it
    // has decoded, so a clip mid-play rides across the swap on its ring while
    // the new address opens behind it.
    if (src && src.url !== asset.url) src.retarget(asset);
    if (!src) {
      poolLog(`pool open ${id}`);
      const own = new ClipFrameSource(asset, height, this.onFrame, () => this.backOwner(own));
      src = own;
      this.sources.set(id, src);
    }
    src.touched = this.tick;
    return src;
  }

  /** Only the sources this frame reads hold backward frames: their sinks are
   * two pools of canvases, and a montage backed through would otherwise keep
   * one per clip. This frame's are the pointer's clip and the neighbour the
   * engine warms below it. */
  private backOwner(owner: ClipFrameSource): void {
    for (const s of this.sources.values())
      if (s !== owner && s.touched < this.tick) s.dropBack(true);
  }

  /** Decoded frames held across every source, for the budget and the trace. */
  get held(): number {
    let n = 0;
    for (const s of this.sources.values()) n += s.held;
    return n;
  }

  get size(): number {
    return this.sources.size;
  }

  /** Sources holding a decoder — what the budget is a budget of. The rest are
   * stood down: a file and its canvases, waiting to be read again. */
  get active(): number {
    let n = 0;
    for (const s of this.sources.values()) if (!s.suspended) n++;
    return n;
  }

  /** Canvas backing the warm shelf is holding — the stood-down sources, which
   * is the part `WARM_PIXELS` governs. For the perf trace. */
  get warmPixels(): number {
    let n = 0;
    for (const s of this.sources.values()) if (s.suspended) n += s.keptPixels;
    return n;
  }

  /** What the live decoders are holding in the platform's decoder. */
  get decoderBytes(): number {
    let n = 0;
    for (const s of this.sources.values()) n += s.decoderBytes;
    return n;
  }

  /**
   * Canvas backing behind every source, live and stood down.
   *
   * The warm shelf's own budget counts only the stood-down ones, because those
   * are the only ones it may close. This counts all of them, because all of
   * them are memory the machine has to find — a scrub holding two backward
   * windows open is the largest the number ever gets, and a report that left
   * it out would say the editor was idle at its busiest moment.
   */
  get canvasBytes(): number {
    let n = 0;
    for (const s of this.sources.values()) n += s.canvasPixels;
    return canvasBytes(n);
  }

  /** Every open source and what it is doing, for the perf eval's pool dump. */
  debugState(): Record<string, unknown>[] {
    return [...this.sources.entries()].map(([id, s]) => ({ id, tick: this.tick, ...s.debugState() }));
  }

  /**
   * Stand down the decoders nothing has asked for lately.
   *
   * "Lately" is doing real work here. Evicting everything untouched by the
   * current frame reads as tidy and behaves terribly: a cut with more clips
   * than the budget closes and reopens decoders every single frame, and the
   * reopening — a fresh read of the file, a fresh decoder — is far more
   * expensive than the memory it was saving. A source is only a candidate once
   * nothing has wanted it for a while, which is long enough that a clip being
   * crossed back and forth over is never the one closed.
   *
   * Standing down is suspension, not closure: the decoder goes, the sink and
   * its canvases stay for the next visit — see `KEEP_PIXELS`, which is where
   * sources actually close.
   */
  evict(): void {
    // Backward frames on a source nothing reads any more were landed for a
    // gesture that ended; the source itself may be worth keeping warm, the
    // canvases under those frames are not.
    for (const s of this.sources.values())
      if (this.tick - s.touched >= EVICT_GRACE) s.dropBack(true);
    const idle = [...this.sources.entries()]
      .filter(([, s]) => this.tick - s.touched >= EVICT_GRACE)
      .sort((a, b) => a[1].touched - b[1].touched);

    // Past the decoder budget, the least recently read decoders stand down.
    // The budget counts the sources actually holding one, so a stood-down
    // source is not what pushes the next one out.
    let live = this.active;
    for (const [id, src] of idle) {
      if (live <= this.budget) break;
      if (src.suspended) continue;
      poolLog(`pool suspend ${id}`);
      src.suspend();
      live--;
    }

    // Then by what those decoders hold: the live ones are kept most recently
    // read first until the budget runs out, and the idle ones past it stand
    // down. The budget is the smaller of what the preview was tuned to want
    // and this machine's share, so a laptop sheds decoders a desktop keeps.
    const decoderCap = allowance("decoders", decodedFrameBytes(LIVE_PIXELS) * DECODER_FRAMES);
    let liveBytes = 0;
    for (const [id, src] of [...this.sources.entries()].sort((a, b) => b[1].touched - a[1].touched)) {
      if (src.suspended) continue;
      liveBytes += src.decoderBytes;
      if (liveBytes <= decoderCap || this.tick - src.touched < EVICT_GRACE) continue;
      poolLog(`pool suspend ${id} (memory)`);
      src.suspend();
    }

    // Then the memory. The warm shelf is filled most-recently-read first until
    // the canvas budget runs out, and what does not fit closes for real. Only
    // stood-down sources are on the shelf, so nothing holding a decoder — and
    // nothing the picture is being drawn from — is ever closed here.
    const warmCap = allowance("canvases", canvasBytes(WARM_PIXELS));
    let held = 0;
    let warm = 0;
    for (const [id, src] of [...this.sources.entries()].sort((a, b) => b[1].touched - a[1].touched)) {
      if (!src.suspended) continue;
      held += canvasBytes(src.keptPixels);
      warm++;
      if (held <= warmCap && warm <= WARM_KEEP_MAX) continue;
      poolLog(`pool close ${id}`);
      src.close();
      this.sources.delete(id);
    }
  }

  closeAll(): void {
    poolLog(`pool closeAll (${this.sources.size})`);
    for (const s of this.sources.values()) s.close();
    this.sources.clear();
  }

  /** Close every source and stop reporting what this pool holds. */
  dispose(): void {
    this.closeAll();
    this.release();
  }
}

/**
 * The decode identity of a clip: the frames it shows are a function of its
 * file, its speed, and where its source time stands at timeline zero. Two clips
 * agreeing on all three show the same picture at every instant.
 */
export function mappingKey(
  assetId: string,
  speed: number,
  inPoint: number,
  start: number
): string {
  return `${assetId}|${speed}|${(inPoint - start * speed).toFixed(3)}`;
}
