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
  EncodedPacketSink,
  Input,
  UrlSource,
  type InputAudioTrack,
  type InputVideoTrack,
  type Rotation,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from "mediabunny";
import { resolveRegisteredBlob } from "./backend/browser/registry";

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

/** Open a file for reading. The caller owns it and must `dispose()` it. A URL
 * the browser store minted resolves to its backing File and reads as a blob —
 * ranged fetches of blob URLs are unreliable across browsers. */
export function openMedia(src: string | Blob): Input {
  const blob = typeof src === "string" ? resolveRegisteredBlob(src) ?? src : src;
  return new Input({
    formats: ALL_FORMATS,
    source: typeof blob === "string" ? new UrlSource(blob) : new BlobSource(blob),
  });
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

/** The primary video track, or null when the file has no readable one — either
 * no video at all, or video in a codec this browser can't decode. Callers that
 * need to tell those apart ask `hasUndecodableVideo`. */
export async function videoTrackOf(input: Input): Promise<InputVideoTrack | null> {
  const track = await input.getPrimaryVideoTrack();
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
  const track = await input.getPrimaryVideoTrack();
  return !!track && !(await track.canDecode());
}

/** The primary audio track, or null — same decodability rule as video. */
export async function audioTrackOf(input: Input): Promise<InputAudioTrack | null> {
  const track = await input.getPrimaryAudioTrack();
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
