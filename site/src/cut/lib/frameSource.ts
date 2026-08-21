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
import { createRasterCanvas } from "./raster";
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
/** How far past a walk's last landed frame the playhead may read before the
 * walk is re-anchored there. A walk running behind still lands frames — the
 * picture advances, a beat late — so it keeps walking while the lag stays
 * watchable, and hops forward to the playhead once the frames it lands are
 * history. */
const LAG_HOP_S = 2;
/** How far the playhead may travel past a walk's start while its first frame
 * is still decoding. That first step is a keyframe seek — every frame from the
 * keyframe to the start decodes before one lands — and a restart pays the
 * whole seek again from scratch, so a slow decoder gets room to finish it. */
const FIRST_FRAME_S = 4;
/** Two source times closer than this are the same frame. */
const SAME = 1e-4;
/** Frames the backward-skim cache keeps of one span: the span is decoded once
 * and this many frames of it are copied out, evenly spread, so the positions a
 * backward drag crosses answer from memory at this granularity. */
const BACK_FRAMES = 16;
/** The most source time one backward-skim fill covers. The window ends at the
 * ask and reaches this far below it, clamped to the keyframe the span decodes
 * from, so a sparsely-keyframed file — a screen recording with keyframes many
 * seconds apart — fills the stretch the drag is entering and pays for that
 * stretch alone. */
const BACK_SPAN_S = 2.5;
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

/** Copy a decoded frame off the sink's pool onto its own canvas, so it stays
 * valid however many frames decode after it. Null when no drawing context is
 * available — a frame that could not be drawn must never enter a cache that
 * answers "we have this one". */
const copyOf = (c: WrappedCanvas): WrappedCanvas | null => {
  const canvas = createRasterCanvas(c.canvas.width, c.canvas.height);
  const ctx = (canvas as HTMLCanvasElement).getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(c.canvas, 0, 0);
  return { canvas, timestamp: c.timestamp, duration: c.duration };
};

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
  private streamFrom = 0;
  private streamTail = 0;
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

  /** The backward-skim cache: strided copies of the keyframe span a drag is
   * moving backward through, decoded once and answered from memory. The main
   * ring cannot serve this — its canvases belong to the sink's pool and its
   * lookahead points the wrong way — so backward motion gets its own frames,
   * read through its own sink so the pull never recycles a canvas the ring
   * still shows. */
  private back: { from: number; to: number; ring: FrameRing<WrappedCanvas> } | null = null;
  private backRun: Promise<void> | null = null;
  private backSink: FrameCanvasSink | null = null;
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

  /** The URL this source is reading. The pool compares it against the store's
   * current one, so a re-minted signed URL replaces the source under it. */
  get url(): string {
    return this.asset.url;
  }

  constructor(
    private readonly asset: MediaAsset,
    private readonly height: number,
    /** Called whenever a frame lands. A paused editor draws the nearest frame
     * it has and stops; without a nudge, the exact frame would decode into a
     * ring nothing looks at again. */
    private readonly onFrame: () => void = () => {}
  ) {}

  /** Decoded frames held right now, for the pool's budget and the perf trace. */
  get held(): number {
    return this.ring.size + (this.back?.ring.size ?? 0) + (this.still ? 1 : 0);
  }

  /** Let go of the backward-skim cache and its copies. */
  dropBack(): void {
    this.back = null;
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
      touched: this.touched,
      suspended: this.asleep,
      keptMb: +(this.keptPixels * 4e-6).toFixed(1),
      nextPendingMs: this.nextStartedAt ? Math.round(performance.now() - this.nextStartedAt) : 0,
    };
  }

  get ready(): boolean {
    return this.still !== null || this.ring.size > 0;
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
    const c = FrameRing.nearer(t, this.ring.at(t, from, to), this.back?.ring.at(t, from, to) ?? null);
    return c ? frameOfCanvas(c) : null;
  }

  /** Whether a frame covering `t` exactly is already held. */
  hasExact(t: number): boolean {
    return this.still !== null || this.ring.covers(t) || (this.back?.ring.covers(t) ?? false);
  }

  /**
   * Say where this clip is being read, and let the source decide how to keep up.
   *
   * `playing` walks forward from `t` and stays `DECODE_AHEAD_S` ahead of it;
   * paused, a single frame is fetched for `t` and the newest ask wins.
   */
  want(t: number, playing: boolean): void {
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
      // Playback reads forward; the backward cache's copies are dead weight.
      this.back = null;
      this.pumpStream(t);
    } else {
      const prev = this.lastAsk;
      this.lastAsk = t;
      // Reading far from the cache's span means the gesture it served has
      // moved on; the copies are dead weight until a drag backs through
      // somewhere again, and that drag fills its own span.
      if (this.back && (t > this.back.to + BACK_SPAN_S || t < this.back.from - BACK_SPAN_S))
        this.back = null;
      if (this.hasExact(t)) return;
      // Moving backward reads against the decode direction, where the walk
      // and its lookahead cannot help. Fill the backward cache for the span
      // being backed through, so the positions still to come answer from it.
      if (prev !== null && t < prev - SAME && !this.backCovers(t)) this.backfill(t, prev);
      // A drag creeping along is a forward walk, not a series of jumps. Asking
      // the file for each position separately means decoding from the nearest
      // keyframe every time — the same cost the `<video>` element charged. If
      // the wanted frame is inside the walk or just ahead of the last frame
      // that arrived, keep walking and each step costs one frame. The last
      // arrival is the only ring fact consulted: anything older may be a
      // leftover from some other gesture entirely.
      const walkEdge = Math.max(this.streamFrom, this.streamTail);
      const nearWalk = this.stream !== null && t >= walkEdge - SAME && t < walkEdge + 0.5;
      const nearLast =
        this.ring.size > 0 && t >= this.ring.newest - SAME && t < this.ring.newest + 0.5;
      if (nearWalk || nearLast) {
        this.pumpStream(t);
        return;
      }
      // A real jump: drop the walk and fetch the one frame. Newest ask wins, so
      // a fast drag decodes where it stopped rather than everywhere it crossed.
      this.stopStream();
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
    this.ring.clear();
    this.back = null;
    this.wanted = null;
    this.lastAsk = null;
  }

  close(): void {
    this.closed = true;
    this.stopStream();
    this.ring.clear();
    this.back = null;
    this.backSink = null;
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
        this.input = input;
        this.track = track;
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
    this.nextStartedAt = 0;
    void s?.return(undefined).catch(() => {});
  }

  /**
   * Keep the forward walk running and roughly `DECODE_AHEAD_S` ahead of `t`.
   *
   * A walk already covering `t` is left alone — restarting it would throw away
   * the buffer it has built and re-decode from the nearest keyframe, which is
   * the hitch this design exists to remove. It ends only for a real jump — a
   * scrub, a clip re-entered from somewhere else — or once the playhead has
   * outrun it past its allowance, where a fresh walk anchored at the playhead
   * is the faster way back to a current picture.
   */
  private pumpStream(t: number): void {
    // Whether the walk serves `t` is a question about the walk — where it
    // started and the last frame it has landed. On a machine whose decoder
    // trails real time the tail falls behind the playhead while frames keep
    // landing: the picture advances, a beat late. A restart there pays a
    // keyframe seek that lands nothing for even longer, and a walk held to a
    // tight deadline gets restarted before any such seek can finish — the
    // picture freezes solid while the playhead runs on the audio clock. So a
    // lagging walk keeps its claim until the frames it lands are history
    // (`LAG_HOP_S`), and a walk still decoding toward its first frame — mid
    // keyframe-seek, with nothing landed yet to show for it — gets the longer
    // `FIRST_FRAME_S`, since a restart would begin that same seek again.
    if (this.stream) {
      // The walk serves `t` if the frame is already held, or if `t` reads at
      // or past the walk's edge — the tail once frames have landed, its start
      // until then — within the allowance. Its span behind the tail proves
      // nothing: frames there have been aging out of the ring the whole time,
      // so a reader that went back to the walk's beginning would find a
      // record of coverage and no frames.
      const landed = this.streamTail > this.streamFrom + SAME;
      const edge = landed ? this.streamTail : this.streamFrom;
      const slack = landed ? LAG_HOP_S : FIRST_FRAME_S;
      if ((t >= edge - SAME && t <= edge + slack) || this.ring.covers(t)) {
        void this.drain(t);
        return;
      }
      this.stopStream();
    } else if (this.streamDone && (this.ring.covers(t) || t >= this.streamTail - SAME)) {
      // The walk ended at the file's last frame. Inside its span the frame is
      // already held, and past its tail there is nothing left to decode — the
      // newest frame held is the answer. Restarting here would re-decode the
      // whole tail from its keyframe once per tick, forever.
      return;
    }
    this.streamFrom = t;
    this.streamTail = t;
    this.streamDone = false;
    void this.startStream(t);
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
    if (this.back && this.back.ring.between(kt, t) > 0) return;
    const c = await this.sink.getCanvas(kt).catch(() => null);
    if (!c || this.closed) return;
    this.ring.push(c);
    this.onFrame();
  }

  /** Whether the backward cache spans `t` — filled or still filling. */
  private backCovers(t: number): boolean {
    return this.back !== null && t >= this.back.from - SAME && t <= this.back.to + SAME;
  }

  /**
   * Decode the span a drag is backing through, once, into the backward cache.
   *
   * The window ends at the position the drag came from, reaches at most
   * `BACK_SPAN_S` below the ask, and is clamped to the keyframe the decode
   * starts from, so it always contains the ask: on a densely-keyframed file
   * that is the whole keyframe interval, and on a sparse one — a screen
   * recording with keyframes many seconds apart — it is the stretch the drag
   * is entering, with the next window down filled when the drag reaches it.
   * `BACK_FRAMES` evenly-spread timestamps are fetched in one decode pass and
   * copied out. The cache is swapped in before the pull so a fast drag reads
   * the early copies while the later ones still decode, and the pull stands
   * down the moment playback takes the source over.
   *
   * The pull runs on its own sink. The main sink cycles a fixed canvas pool
   * that the ring holds references into; a span of frames pulled through it
   * would redraw every canvas the compositor is showing.
   */
  private backfill(t: number, upTo: number): void {
    if (this.backRun || this.closed) return;
    this.backRun = (async () => {
      try {
        await this.open();
        if (this.closed || !this.track) return;
        const kt = await keyframeTimeAt(this.track, Math.max(0, t)).catch(() => null);
        if (kt === null || this.closed || this.backCovers(t)) return;
        if (!this.backSink)
          this.backSink = frameSink(
            this.track,
            { height: this.height },
            { poolSize: 6, lowLatency: true }
          );
        const from = Math.max(kt, t - BACK_SPAN_S, 0);
        const to = Math.min(Math.max(upTo, t + SAME), from + BACK_SPAN_S);
        const step = (to - from) / BACK_FRAMES;
        const asks: number[] = [];
        for (let ts = from; ts <= to + SAME; ts += step) asks.push(ts);
        const ring = new FrameRing<WrappedCanvas>(asks.length);
        this.back = { from, to, ring };
        const stream = this.backSink.canvasesAtTimestamps(asks);
        try {
          let last = -1;
          for (;;) {
            const { value, done } = await stream.next();
            // `lastAsk` clearing means playback owns the source now; the
            // cache was dropped and this pull is decoding for nobody.
            if (done || this.closed || this.lastAsk === null) break;
            if (!value || value.timestamp === last) continue;
            last = value.timestamp;
            const copy = copyOf(value);
            if (copy) {
              ring.push(copy);
              this.onFrame();
            }
          }
        } finally {
          void stream.return(undefined).catch(() => {});
        }
      } catch {
        this.back = null;
      } finally {
        this.backRun = null;
      }
    })();
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
          this.nextStartedAt = performance.now();
          const { value, done } = await stream.next();
          this.nextStartedAt = 0;
          // A restart or a close while awaiting: this walk is no longer the one.
          if (this.stream !== stream) break;
          if (done || !value) {
            this.stream = null;
            this.streamDone = true;
            break;
          }
          this.streamTail = value.timestamp;
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
        // The backward cache is already showing a frame for this span, so the
        // exact decode can wait a beat. A drag still moving supersedes the ask
        // during the wait, and the whole backward pass costs one decoder
        // session — the cache fill — while the exact frame still lands a beat
        // after the pointer rests.
        if (this.backCovers(t)) {
          await new Promise((r) => setTimeout(r, 40));
          if (this.closed) break;
          if (this.wanted !== null) continue;
          // Playback may have started its walk during the wait; that walk
          // owns the stream and must not be torn down under it.
          if (this.stream) break;
        }
        this.stopStream();
        // Let the replaced walk's drain finish letting go, so the new walk is
        // never pulled by a loop still holding the old one.
        await this.drainRun;
        if (this.closed) break;
        // Playback took over while this ask waited; its walk owns the stream.
        if (this.stream) break;
        this.streamDone = false;
        this.streamFrom = t;
        this.streamTail = t;
        this.stream = this.sink.canvases(Math.max(0, t));
        await this.drain(t);
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

  constructor(
    private budget = 10,
    private readonly onFrame: () => void = () => {}
  ) {}

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
    // and it moves — a signed link re-mints, a shot re-renders onto its asset.
    // A source is only current while it reads the store's current URL.
    if (src && src.url !== asset.url) {
      src.close();
      this.sources.delete(id);
      src = undefined;
    }
    if (!src) {
      poolLog(`pool open ${id}`);
      src = new ClipFrameSource(asset, height, this.onFrame);
      this.sources.set(id, src);
    }
    src.touched = this.tick;
    return src;
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
    // A backward-skim cache on a source nothing reads any more is copies held
    // for a gesture that ended; the source itself may be worth keeping warm,
    // its cache is not.
    for (const s of this.sources.values())
      if (this.tick - s.touched >= EVICT_GRACE) s.dropBack();
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

    // Then the memory. The warm shelf is filled most-recently-read first until
    // the canvas budget runs out, and what does not fit closes for real. Only
    // stood-down sources are on the shelf, so nothing holding a decoder — and
    // nothing the picture is being drawn from — is ever closed here.
    let pixels = 0;
    let warm = 0;
    for (const [id, src] of [...this.sources.entries()].sort((a, b) => b[1].touched - a[1].touched)) {
      if (!src.suspended) continue;
      pixels += src.keptPixels;
      warm++;
      if (pixels <= WARM_PIXELS && warm <= WARM_KEEP_MAX) continue;
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
