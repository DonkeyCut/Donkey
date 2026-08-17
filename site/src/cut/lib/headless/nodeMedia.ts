import { VideoSampleSink, type InputVideoTrack, type VideoSample, type WrappedCanvas } from "mediabunny";
import { setFrameSinkFactory, type FrameCanvasSink, type FrameSize } from "../mediaRead";
import { createRasterCanvas } from "../raster";

/**
 * The media runtime a headless process needs to read what the page reads.
 *
 * Cut's media layer is mediabunny: containers parsed directly, frames off
 * WebCodecs, audio through Web Audio. Node has neither, so three things get
 * installed here and the rest of the code runs unchanged — the same silence
 * scan, the same watch sampler, the same transcription mixdown:
 *
 *   decoders   NodeAV, registered into mediabunny as its codec backend
 *   audio      AudioBuffer and OfflineAudioContext, from node-web-audio-api
 *   frames     a skia-backed frame sink (below)
 *
 * The frame sink is the one piece that cannot be a polyfill. mediabunny's
 * CanvasSink draws through `VideoFrame`, which Node has no equivalent of, so
 * the sink here goes the other way: decode to a sample, transform it to the
 * requested size (NodeAV does the scaling and rotation), and copy the RGBA
 * out into a server canvas. Geometry matches CanvasSink's — one dimension
 * preserves aspect, rotation from the container is applied — so a frame read
 * headless is framed exactly like the same frame read in a tab.
 */

/** A sink over one video track that hands back server canvases. */
class NodeFrameSink implements FrameCanvasSink {
  private readonly samples: VideoSampleSink;

  constructor(
    private readonly imageData: new (data: Uint8ClampedArray, w: number, h: number) => ImageData,
    track: InputVideoTrack,
    private readonly size?: FrameSize
  ) {
    this.samples = new VideoSampleSink(track);
  }

  private async wrap(sample: VideoSample): Promise<WrappedCanvas> {
    const { width, height, fit } = this.size ?? {};
    // Always a transform, even at native size: it is what bakes the
    // container's rotation into the pixels.
    const out = await sample.transform({
      ...(width !== undefined ? { width: Math.round(width) } : {}),
      ...(height !== undefined ? { height: Math.round(height) } : {}),
      ...(width !== undefined && height !== undefined ? { fit: fit ?? "fill" } : fit ? { fit } : {}),
    });
    sample.close();
    try {
      const pixels = new Uint8Array(out.allocationSize({ format: "RGBA" }));
      await out.copyTo(pixels, { format: "RGBA" });
      const image = new this.imageData(
        new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength),
        out.codedWidth,
        out.codedHeight
      );
      const canvas = createRasterCanvas(out.displayWidth, out.displayHeight);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
      if (!ctx) throw new Error("Could not read a video frame.");
      if (out.codedWidth === out.displayWidth && out.codedHeight === out.displayHeight) {
        ctx.putImageData(image, 0, 0);
      } else {
        // Anamorphic footage: the coded pixels are square-stretched to the
        // display size the rest of Cut measures in.
        const coded = createRasterCanvas(out.codedWidth, out.codedHeight);
        (coded.getContext("2d") as CanvasRenderingContext2D).putImageData(image, 0, 0);
        ctx.drawImage(
          coded as CanvasImageSource,
          0,
          0,
          out.displayWidth,
          out.displayHeight
        );
      }
      return {
        canvas: canvas as HTMLCanvasElement,
        timestamp: out.timestamp,
        duration: out.duration,
      };
    } finally {
      out.close();
    }
  }

  async getCanvas(timestamp: number): Promise<WrappedCanvas | null> {
    const sample = await this.samples.getSample(timestamp);
    return sample ? this.wrap(sample) : null;
  }

  async *canvases(start?: number, end?: number): AsyncGenerator<WrappedCanvas, void, unknown> {
    for await (const sample of this.samples.samples(start, end)) yield await this.wrap(sample);
  }

  async *canvasesAtTimestamps(
    timestamps: Iterable<number> | AsyncIterable<number>
  ): AsyncGenerator<WrappedCanvas | null, void, unknown> {
    for await (const sample of this.samples.samplesAtTimestamps(timestamps))
      yield sample ? await this.wrap(sample) : null;
  }
}

/** Install the Node decoders, the Web Audio globals, and the server frame
 * sink. False when the native modules are missing — the process then runs
 * whatever needs no decoding. */
export async function installNodeMedia(): Promise<boolean> {
  try {
    const [server, skia, audio] = await Promise.all([
      import("@mediabunny/server"),
      import("skia-canvas"),
      import("node-web-audio-api"),
    ]);
    server.registerMediabunnyServer();

    const scope = globalThis as Record<string, unknown>;
    scope.AudioBuffer ??= audio.AudioBuffer;
    scope.OfflineAudioContext ??= audio.OfflineAudioContext;

    const imageData = skia.ImageData as unknown as new (
      data: Uint8ClampedArray,
      w: number,
      h: number
    ) => ImageData;
    setFrameSinkFactory((track, size) => new NodeFrameSink(imageData, track, size));
    return true;
  } catch {
    return false;
  }
}
