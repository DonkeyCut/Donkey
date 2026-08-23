"use client";

/**
 * Reading media in the browser.
 *
 * Containers are parsed directly and frames come off WebCodecs, rather than
 * being coaxed out of `<video>`/`<audio>` elements. That difference is what
 * this module exists for: an element answers questions about media by playing
 * it, so every read used to cost a seek, a `seeked` event, and a timeout to
 * cover the seek that never lands — and the answers were approximate anyway
 * (`HTMLAudioElement.duration` overestimates MP3s, MediaRecorder WebM reports
 * `Infinity`, and rotation is invisible). Reading the container gives exact
 * answers for the cost of the bytes those answers live in.
 *
 * Everything here takes a URL or a `Blob`. A URL is read over ranged requests,
 * which both backends already serve: the engine's file route answers 206, and
 * the cloud's edge parses ranges. Requests go through `fetch`, whose default
 * cross-origin mode sends an `Origin` and no credentials — the same request
 * `crossOrigin="anonymous"` makes, so reads here share the cache entry the
 * decoders use rather than racing them (see mediaCors.ts).
 *
 * Callers that read once open and dispose around the read. The one caller that
 * reads the same file over and over — filmstrip edge frames on a trim drag —
 * keeps its own pool of readers, because the decode cache inside a sink is the
 * whole point of holding one open.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  BlobSource,
  CanvasSink,
  CustomSource,
  EncodedPacketSink,
  Input,
  UnsupportedInputFormatError,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
  type Rotation,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from "mediabunny";
import { confirmEngine, engineConnected, isEngineUrl } from "./api";
import { resolveRegisteredBlob } from "./backend/browser/registry";
import { chunkSourceOptions } from "./chunkCache";

/** What a file turns out to be, read from its container. */
export interface MediaProbe {
  /** Sample-exact, from the packets — not the container's rounded metadata. */
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** Display dimensions: rotation and pixel aspect already applied. */
  width?: number;
  height?: number;
  rotation?: Rotation;
}

/** Frames read back at a target size. Height alone preserves aspect. */
export interface FrameSize {
  width?: number;
  height?: number;
  fit?: "fill" | "contain" | "cover";
}

export class UnreadableMediaError extends Error {
  /** The container parsed and the file carries video — this browser just has
   * no decoder for it. Callers that can convert branch on this rather than on
   * the message. */
  readonly undecodable: boolean;

  constructor(message = "Cut can't read this media file.", undecodable = false) {
    super(message);
    this.name = "UnreadableMediaError";
    this.undecodable = undecodable;
  }
}

/** Ranged requests kept in the air for one URL.
 *
 * Widening only pays where a round trip is the cost. The local engine serves
 * files off this Mac's disk over HTTP/1.1, where a browser allows six
 * connections per origin in total — a handful of clips each asking for eight
 * would put the frame being drawn behind readahead for clips nobody is
 * looking at. So the local engine and any other plain-HTTP origin keep the
 * library's pair, and so does a link that says it is slow or metered. The
 * width is for multiplexed cloud media over a real network. */
function urlParallelism(url: string): number {
  if (!/^https:/i.test(url)) return 2;
  const conn =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || /(^|-)2g$|^3g$/.test(conn?.effectiveType ?? "")) return 2;
  return 8;
}

/** Backoff, in seconds, for a URL read whose request failed outright. The
 * list ends, so a URL that is genuinely gone still fails — the preview's
 * outage recovery (frameSource.ts) re-opens on its own cadence, and a read
 * that hung on retries forever would never let it.
 *
 * The library's own policy reads a rejected cross-origin fetch as a CORS
 * refusal and gives up without a single retry. Every URL Cut opens is
 * cross-origin — signed cloud media on its own host, the engine on 127.0.0.1 —
 * and each answers this page's requests by configuration, so a rejection is
 * the connection dropping, not the browser refusing. Left to the default, one
 * flaky minute turned into hard read failures with no retry behind them. */
const URL_RETRY_DELAYS_S = [0.5, 1.5, 4, 10];
/** A refused connection to this Mac is an answer rather than weather: the
 * engine's port is listening or it is not. Two quick tries ride out the
 * seconds an app update takes to put a new engine on the port, and nothing
 * waits longer than that for a machine that is right here. */
const LOCAL_RETRY_DELAYS_S = [0.5, 1.5];

const urlRetryDelay = (
  previousAttempts: number,
  _error: unknown,
  src: string | URL | Request
): number | null => {
  // Headless has nothing to hand a giving-up read back to: the engine and the
  // render worker open a file once, and a read that quits fails the job. They
  // keep waiting, on a widening backoff, until the job's own cancellation
  // ends it.
  if (headless()) return Math.min(2 ** (previousAttempts - 2), 16);
  const url = typeof src === "string" ? src : src instanceof URL ? src.href : src.url;
  if (isEngineUrl(url)) {
    // Nothing to wait for once the app is gone; the refusal stands until the
    // gate connects an engine again.
    return engineConnected() ? LOCAL_RETRY_DELAYS_S[previousAttempts - 1] ?? null : null;
  }
  return URL_RETRY_DELAYS_S[previousAttempts - 1] ?? null;
};

/** A read this module issued that never reached the file. The name is what
 * error tracking matches on (instrumentation-client.ts) and what keeps a
 * caller's own report of it worded as weather (report.ts). */
class MediaFetchError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "MediaFetchError";
  }
}

const aborted = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "AbortError";

/**
 * Wrap a source's own reads: a read of this Mac's media is refused outright
 * once the app that serves it is gone, and any other failure comes back named.
 *
 * A closed app is a fact the page already holds — the ConnectGate has its
 * connect modal up and no engine origin resolved — so a source that keeps
 * asking is asking a port nothing is listening on. The first failure is what
 * establishes it: it asks the engine's health endpoint, and an app that quit
 * mid-session drops the connection there, which turns every later read into
 * this refusal instead of another request.
 */
function trackedFetch(url: string): typeof fetch {
  const engine = !headless() && isEngineUrl(url);
  return (input, init) => {
    if (engine && !engineConnected()) {
      return Promise.reject(new MediaFetchError("The Donkey app isn't running."));
    }
    return fetch(input, init).catch((err: unknown) => {
      if (aborted(err)) throw err;
      if (engine) void confirmEngine();
      throw new MediaFetchError("Cut couldn't read this media over the network.", err);
    });
  };
}

/** Open a file for reading. The caller owns it and must `dispose()` it. A URL
 * the browser store minted resolves to its backing File and reads as a blob —
 * ranged fetches of blob URLs are unreliable across browsers. Signed cloud
 * media reads through the chunk cache (chunkCache.ts), so bytes touched once
 * are on disk for the next read of the same object. */
export function openMedia(src: string | Blob): Input {
  const blob = typeof src === "string" ? resolveRegisteredBlob(src) ?? src : src;
  let source;
  if (typeof blob === "string") {
    const chunked = chunkSourceOptions(blob);
    source = chunked
      ? new CustomSource({ ...chunked, prefetchProfile: "network", maxCacheSize: 64 * 2 ** 20 })
      : new UrlSource(blob, {
          parallelism: urlParallelism(blob),
          getRetryDelay: urlRetryDelay,
          fetchFn: trackedFetch(blob),
        });
  } else {
    source = new BlobSource(blob);
  }
  return new Input({ formats: ALL_FORMATS, source });
}

/** Run `fn` against an open input and dispose it however that ends. */
export async function withMedia<T>(src: string | Blob, fn: (input: Input) => Promise<T>): Promise<T> {
  const input = openMedia(src);
  try {
    return await fn(input);
  } finally {
    input.dispose();
  }
}

// A headless runtime (the turn runner) has no page, and there the
// decodability gate is not a gate: nothing plays in that process, rendering
// goes through ffmpeg, and the probe only reads container metadata — which
// parses fine. Tracks pass headless; every browser keeps the strict check,
// including one without WebCodecs, where canDecode answers false and the
// undecodable-import guard still refuses footage the page can't play.
const headless = () => typeof document === "undefined";

/** A file the container parser doesn't recognize reads back as this module's
 * own error. mediabunny's own text names no file and reads like a bug report,
 * and it reaches the user wherever a read runs — a caption run, an export, a
 * chat tool. */
async function tracked<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if (err instanceof UnsupportedInputFormatError) throw new UnreadableMediaError();
    throw err;
  }
}

/** The primary video track, or null when the file has no readable one — either
 * no video at all, or video in a codec this browser can't decode. Callers that
 * need to tell those apart ask `hasUndecodableVideo`. */
export async function videoTrackOf(input: Input): Promise<InputVideoTrack | null> {
  const track = await tracked(input.getPrimaryVideoTrack());
  if (!track) return null;
  return headless() || (await track.canDecode()) ? track : null;
}

/** True when the file carries video this browser cannot decode.
 *
 * The difference matters at import: a file with no video track is audio, and
 * calling it audio is right. A camera file in 10-bit HEVC also yields no
 * readable video track, and calling *that* audio drops the user's footage onto
 * the timeline as a waveform with no explanation. */
export async function hasUndecodableVideo(input: Input): Promise<boolean> {
  if (headless()) return false;
  const track = await tracked(input.getPrimaryVideoTrack());
  return !!track && !(await track.canDecode());
}

/** The primary audio track, or null — same decodability rule as video. */
export async function audioTrackOf(input: Input): Promise<InputAudioTrack | null> {
  const track = await tracked(input.getPrimaryAudioTrack());
  if (!track) return null;
  return headless() || (await track.canDecode()) ? track : null;
}

/** Read what a file is: how long, whether it carries picture or sound, and at
 * what size. Throws `UnreadableMediaError` for a container Cut can't parse, so
 * a bad drop fails at the door with something to say instead of becoming an
 * asset that plays black. */
export async function probeMediaFile(src: string | Blob): Promise<MediaProbe> {
  return withMedia(src, async (input) => {
    if (!(await input.canRead())) throw new UnreadableMediaError();
    const [video, audio] = await Promise.all([videoTrackOf(input), audioTrackOf(input)]);
    // Footage this browser can't decode is refused outright. Treating it as
    // audio would be a quieter failure, not a smaller one: the clip would look
    // imported and simply have no picture.
    if (!video && (await hasUndecodableVideo(input))) {
      throw new UnreadableMediaError(
        "This video is in a format Cut can't decode in this browser.",
        true
      );
    }
    if (!video && !audio) throw new UnreadableMediaError();
    const duration = await input.computeDuration();
    if (!video) return { duration, hasVideo: false, hasAudio: true };
    const [width, height, rotation] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.getRotation(),
    ]);
    return { duration, hasVideo: true, hasAudio: !!audio, width, height, rotation };
  });
}

/** What every frame reader in Cut asks of a video track: one frame at a
 * time, a span in order, or a set of moments in one pass. mediabunny's
 * CanvasSink is this in a browser; a headless process installs its own,
 * because CanvasSink draws through `VideoFrame`, which Node has no. */
export interface FrameCanvasSink {
  getCanvas(timestamp: number): Promise<WrappedCanvas | null>;
  canvases(start?: number, end?: number): AsyncGenerator<WrappedCanvas, void, unknown>;
  canvasesAtTimestamps(
    timestamps: Iterable<number> | AsyncIterable<number>
  ): AsyncGenerator<WrappedCanvas | null, void, unknown>;
}

export interface FrameSinkOptions {
  poolSize?: number;
  /** Ask the decoder to emit each frame as soon as it is decoded. Interactive
   * readers — the preview, a trim drag — set this: Windows hardware decoders
   * otherwise hold output until their input queue runs deep, and frames arrive
   * in bursts with stalls between them. Batch readers leave it off and keep
   * the deeper pipeline's throughput. */
  lowLatency?: boolean;
}

export type FrameSinkFactory = (
  track: InputVideoTrack,
  size?: FrameSize,
  opts?: FrameSinkOptions
) => FrameCanvasSink;

const canvasSinkFactory: FrameSinkFactory = (track, size, opts) =>
  new CanvasSink(track, {
    ...size,
    ...(opts?.poolSize ? { poolSize: opts.poolSize } : {}),
    ...(opts?.lowLatency ? { decoderOptions: { optimizeForLatency: true } } : {}),
  });

let sinkFactory: FrameSinkFactory = canvasSinkFactory;

/** Install a replacement frame reader, e.g. the skia-backed one a headless
 * process uses. Affects every later `frameSink` call. */
export function setFrameSinkFactory(f: FrameSinkFactory): void {
  sinkFactory = f;
}

/** A sink that draws this track's frames at `size`. Rotation from the file's
 * metadata is applied by default, so a phone clip comes back upright and no
 * consumer has to know it was ever sideways. A requested size is capped at the
 * track's own: a sampler asking 480 wide of a 360-wide file pays for the extra
 * pixels and learns nothing from them. */
export function frameSink(
  track: InputVideoTrack,
  size?: FrameSize,
  opts?: FrameSinkOptions
): FrameCanvasSink {
  return sinkFactory(track, capToTrack(track, size), opts);
}

function capToTrack(track: InputVideoTrack, size?: FrameSize): FrameSize | undefined {
  if (!size) return size;
  // A backing that resolves its metadata asynchronously — HLS, a segmented
  // input — refuses the synchronous read. The sink is sync, so those sources
  // decode at the size asked for.
  let tw: number;
  let th: number;
  try {
    tw = track.displayWidth;
    th = track.displayHeight;
  } catch {
    return size;
  }
  return {
    ...size,
    ...(size.width !== undefined ? { width: Math.min(size.width, tw) } : {}),
    ...(size.height !== undefined ? { height: Math.min(size.height, th) } : {}),
  };
}

/**
 * Frames at the given times, in one decode pass.
 *
 * Sorted timestamps decode each packet at most once, which is what makes a
 * filmstrip or a contact sheet a single sweep of the file instead of N seeks
 * into it. Yields null for a time the track has no frame for.
 */
export async function* framesAt(
  src: string | Blob,
  times: number[],
  size?: FrameSize
): AsyncGenerator<WrappedCanvas | null> {
  const input = openMedia(src);
  try {
    const track = await videoTrackOf(input);
    if (!track) throw new UnreadableMediaError("This file has no readable video.");
    yield* frameSink(track, size).canvasesAtTimestamps(times);
  } finally {
    input.dispose();
  }
}

/** When the keyframe at or before `t` starts. Read from the file's index —
 * nothing decodes — so a scrub can find the one frame that answers in a
 * single-packet decode. Null when the track has no keyframe there. */
export async function keyframeTimeAt(track: InputVideoTrack, t: number): Promise<number | null> {
  const packet = await new EncodedPacketSink(track).getKeyPacket(t, { verifyKeyPackets: true });
  return packet ? packet.timestamp : null;
}

/** A single frame at `time`, at native size unless one is given. */
export async function frameAt(
  src: string | Blob,
  time: number,
  size?: FrameSize
): Promise<WrappedCanvas | null> {
  return withMedia(src, async (input) => {
    const track = await videoTrackOf(input);
    if (!track) throw new UnreadableMediaError("This file has no readable video.");
    return frameSink(track, size).getCanvas(Math.max(0, time));
  });
}

/**
 * The file's audio, a buffer at a time, over `[from, to)`.
 *
 * Streaming is the point: a waveform or a silence scan reads a chunk, folds it
 * into a running result, and drops it, so the peak memory is one buffer rather
 * than a whole decoded file. Yields nothing when the file has no audio.
 */
export async function* audioChunks(
  src: string | Blob,
  from?: number,
  to?: number
): AsyncGenerator<WrappedAudioBuffer> {
  const input = openMedia(src);
  try {
    const track = await audioTrackOf(input);
    if (!track) return;
    yield* new AudioBufferSink(track).buffers(from, to);
  } finally {
    input.dispose();
  }
}

/**
 * One buffer holding `[from, to)` at the source's own rate and channel count,
 * or null when the file has no audio.
 *
 * For callers that need random access to a span — resampling it, rendering it
 * out — where streaming would only mean assembling this by hand. The span is
 * what's decoded, so asking for thirty seconds of an hour-long file costs
 * thirty seconds.
 */
export async function decodeAudioSpan(
  src: string | Blob,
  from = 0,
  to?: number
): Promise<AudioBuffer | null> {
  const chunks: WrappedAudioBuffer[] = [];
  for await (const chunk of audioChunks(src, from, to)) chunks.push(chunk);
  if (chunks.length === 0) return null;

  const sampleRate = chunks[0].buffer.sampleRate;
  const numberOfChannels = Math.max(...chunks.map((c) => c.buffer.numberOfChannels));
  const last = chunks[chunks.length - 1];
  // The buffer begins exactly at `from`, which is what callers assume when they
  // play it from 0. Decoding lands on packet boundaries, so the first chunk
  // usually starts a little earlier; that head is trimmed below rather than
  // being allowed to shift the whole span early.
  const start = from;
  const end = Math.min(to ?? Infinity, last.timestamp + last.duration);
  const length = Math.max(1, Math.round((end - start) * sampleRate));
  const out = new AudioBuffer({ length, numberOfChannels, sampleRate });

  for (const { buffer, timestamp } of chunks) {
    // A chunk can start before the requested span, since decoding lands on
    // packet boundaries. The negative offset trims its head rather than
    // shifting everything after it late.
    const offset = Math.round((timestamp - start) * sampleRate);
    const head = Math.max(0, -offset);
    const at = Math.max(0, offset);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const samples = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
      const count = Math.min(samples.length - head, length - at);
      if (count > 0) out.copyToChannel(samples.subarray(head, head + count), ch, at);
    }
  }
  return out;
}

/**
 * Normalized 0..1 waveform peaks across the whole file, `buckets` wide.
 *
 * Folded chunk by chunk, so the cost is the decode rather than the decode plus
 * a copy of the file in memory — an hour of audio used to mean holding an hour
 * of float samples to draw a strip a few hundred pixels wide.
 */
export async function audioPeaks(src: string | Blob, buckets: number): Promise<number[]> {
  // Peaks are a real decode; a headless runtime skips them and the waveform
  // enriches the next time a browser holds the asset.
  if (typeof AudioDecoder === "undefined") return [];
  const input = openMedia(src);
  try {
    const track = await audioTrackOf(input);
    if (!track) return [];
    // Read the length first so each chunk can be folded into its bucket and
    // dropped; without it the buckets aren't known until the last sample, and
    // the whole file has to be held to place any of it.
    const duration = await input.computeDuration();
    if (!(duration > 0)) return [];

    const peaks = new Array<number>(buckets).fill(0);
    for await (const { buffer, timestamp } of new AudioBufferSink(track).buffers()) {
      const data = buffer.getChannelData(0);
      const rate = buffer.sampleRate;
      // Every 8th sample, matching what the whole-file pass measured.
      for (let i = 0; i < data.length; i += 8) {
        const v = Math.abs(data[i]);
        const at = (timestamp + i / rate) / duration;
        const bucket = Math.min(buckets - 1, Math.max(0, Math.floor(at * buckets)));
        if (v > peaks[bucket]) peaks[bucket] = v;
      }
    }
    return peaks;
  } finally {
    input.dispose();
  }
}
