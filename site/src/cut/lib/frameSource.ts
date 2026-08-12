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

import type { CanvasSink, Input, WrappedCanvas } from "mediabunny";
import { frameSink, openMedia, videoTrackOf } from "./mediaRead";
import type { MediaAsset } from "./types";

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
/** Two source times closer than this are the same frame. */
const SAME = 1e-4;
/** Frames a source must go unwanted before the pool will close it. About a
 * second of playback — long enough that crossing a cut and coming back finds
 * the decoder still open. */
const EVICT_GRACE = 90;
/** A failed open tries again this much later, growing per attempt, and gives
 * up after this many. A network blip heals on its own; a file that is truly
 * unreadable stops costing anything after a few seconds. */
const RETRY_MS = 1000;
const RETRIES = 3;

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
   */
  at(t: number): T | null {
    let best: T | null = null;
    let earliest: T | null = null;
    for (const i of this.items) {
      if (!earliest || i.timestamp < earliest.timestamp) earliest = i;
      if (i.timestamp <= t + SAME && (!best || i.timestamp > best.timestamp)) best = i;
    }
    return best ?? earliest;
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

  /** Drop frames outside a window a reader has moved away from. */
  keep(from: number, to: number): void {
    this.items = this.items.filter((i) => i.timestamp >= from - SAME && i.timestamp <= to + SAME);
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
  private sink: CanvasSink | null = null;
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
  private streaming = false;
  /** The time a paused reader last asked for, and whether a read is in flight.
   * Latest wins: a fast drag decodes where it stopped, never every point it
   * crossed. */
  private wanted: number | null = null;
  private reading = false;

  /** The engine's tick number when this was last asked for anything, for the
   * pool's eviction order. */
  touched = 0;

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
    return this.ring.size + (this.still ? 1 : 0);
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
   * show. Null only when nothing has been decoded yet.
   */
  frameAt(t: number): SourceFrame | null {
    if (this.still) return this.still;
    const c = this.ring.at(t);
    return c ? frameOfCanvas(c) : null;
  }

  /** Whether the ring holds the exact frame covering `t`. */
  hasExact(t: number): boolean {
    return this.still !== null || this.ring.covers(t);
  }

  /**
   * Say where this clip is being read, and let the source decide how to keep up.
   *
   * `playing` walks forward from `t` and stays `DECODE_AHEAD_S` ahead of it;
   * paused, a single frame is fetched for `t` and the newest ask wins.
   */
  want(t: number, playing: boolean): void {
    if (this.closed || this.unreadable) return;
    if (this.asset.type === "image") {
      void this.openStill();
      return;
    }
    void this.open();
    if (playing) {
      this.wanted = null;
      this.pumpStream(t);
    } else {
      if (this.hasExact(t)) return;
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

  /** Frames outside [from, to] are of no further use — a clip whose window
   * moved on, or a scrub that jumped. */
  trim(from: number, to: number): void {
    this.ring.keep(from, to);
  }

  close(): void {
    this.closed = true;
    this.stopStream();
    this.ring.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = 0;
    // A still's bitmap holds real memory the GC can't see the size of.
    if (this.still && this.still.image instanceof ImageBitmap) this.still.image.close();
    this.still = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }

  /**
   * An open failed. That is usually a moment — a network blip, a signed URL a
   * few seconds past its window — so the source tells the link keeper (which
   * re-mints an expired URL; the pool then swaps this source out under the new
   * one) and books itself another try. Only a file that keeps failing stays
   * marked unreadable, and only after it has had its chances.
   */
  private fail(): void {
    this.unreadable = true;
    this.opening = null;
    void import("./mediaLinks").then((m) => m.reportMediaUrlError(this.asset.url));
    if (this.closed || this.attempts >= RETRIES || typeof window === "undefined") return;
    this.attempts++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = 0;
      if (this.closed) return;
      this.unreadable = false;
      // Nothing asks a failed source for frames, so nothing would notice it is
      // willing again without a nudge.
      this.onFrame();
    }, RETRY_MS * this.attempts);
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
        // Height alone: the sink keeps the source's aspect and applies the
        // file's rotation, so a phone clip arrives upright at preview size and
        // no caller has to know it was ever sideways.
        this.sink = frameSink(track, { height: this.height }, POOL);
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
    this.streaming = false;
    void s?.return(undefined).catch(() => {});
  }

  /**
   * Keep the forward walk running and roughly `DECODE_AHEAD_S` ahead of `t`.
   *
   * A walk already covering `t` is left alone — restarting it would throw away
   * the buffer it has built and re-decode from the nearest keyframe, which is
   * the hitch this design exists to remove. It restarts only for a real jump:
   * a scrub, or a clip re-entered from somewhere else.
   */
  private pumpStream(t: number): void {
    // Whether the walk covers `t` is a question about the walk — where it
    // started and the last frame it has landed. A walk whose first frame is
    // still decoding is already the right walk: that first step is a keyframe
    // seek, longer than a display frame, and judging it by frames landed would
    // tear it down on every tick and it would never land anything. It gets a
    // second of slack for the reader to advance while that first frame comes.
    if (this.stream) {
      // The walk serves `t` if the frame is already held, or if `t` sits just
      // past the tail — where the next pulls will land. Its span behind the
      // tail proves nothing: frames there have been aging out of the ring the
      // whole time, so a reader that went back to the walk's beginning would
      // find a record of coverage and no frames.
      const landed = this.streamTail > this.streamFrom + SAME;
      const ahead = landed
        ? t >= this.streamTail - SAME && t <= this.streamTail + DECODE_AHEAD_S
        : t >= this.streamFrom - SAME && t <= this.streamFrom + DECODE_AHEAD_S + 1;
      if (ahead || this.ring.covers(t)) {
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
    if (this.closed || !this.sink || this.stream) return;
    // The read may have been overtaken while the file was opening.
    if (Math.abs(this.streamFrom - from) > SAME) return;
    this.stream = this.sink.canvases(Math.max(0, from));
    void this.drain(from);
  }

  /** Pull frames until the ring reaches `DECODE_AHEAD_S` past `t`. */
  private async drain(t: number): Promise<void> {
    if (this.streaming || !this.stream) return;
    this.streaming = true;
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
        const { value, done } = await stream.next();
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
      this.streaming = false;
    }
  }

  /** Fetch the single frame a paused reader is waiting on. */
  private async pumpSeek(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      await this.open();
      for (;;) {
        const t = this.wanted;
        if (t === null || this.closed || !this.sink) break;
        this.wanted = null;
        const c = await this.sink.getCanvas(Math.max(0, t));
        if (this.closed) break;
        if (c) {
          this.ring.push(c);
          this.onFrame();
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

  /**
   * Close the decoders nothing has asked for lately.
   *
   * "Lately" is doing real work here. Evicting everything untouched by the
   * current frame reads as tidy and behaves terribly: a cut with more clips
   * than the budget closes and reopens decoders every single frame, and the
   * reopening — a fresh read of the file, a fresh decoder — is far more
   * expensive than the memory it was saving. A source is only a candidate once
   * nothing has wanted it for a while, which is long enough that a clip being
   * crossed back and forth over is never the one closed.
   */
  evict(): void {
    if (this.sources.size <= this.budget) return;
    const idle = [...this.sources.entries()]
      .filter(([, s]) => this.tick - s.touched >= EVICT_GRACE)
      .sort((a, b) => a[1].touched - b[1].touched);
    let over = this.sources.size - this.budget;
    for (const [id, src] of idle) {
      if (over-- <= 0) break;
      src.close();
      this.sources.delete(id);
    }
  }

  closeAll(): void {
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
