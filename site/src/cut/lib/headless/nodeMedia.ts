import { VideoSampleSink, type InputVideoTrack, type VideoSample, type WrappedCanvas } from "mediabunny";
import type { toAvFrame as ToAvFrame } from "@mediabunny/server";
import { setFrameSinkFactory, type FrameCanvasSink, type FrameSize } from "../mediaRead";
import { createRasterCanvas } from "../raster";

type NodeAv = typeof import("node-av");
let nodeAvModule: Promise<NodeAv> | null = null;
const nodeAv = (): Promise<NodeAv> => (nodeAvModule ??= import("node-av"));

/** Tight RGBA of `sample`, converted with the matrix and range the sample
 * carries. The server package's own RGBA copy runs the legacy scaler, which
 * converts every file as BT.601 whatever its tags say, so a 2020-tagged
 * frame came out with the wrong chroma; a filter graph reads the frame's
 * color fields and converts by them. */
async function rgbaOf(sample: VideoSample, toAvFrame: typeof ToAvFrame): Promise<Uint8Array> {
  const av = await nodeAv();
  const src = new av.Frame();
  src.alloc();
  const dst = new av.Frame();
  dst.alloc();
  const graph = new av.FilterGraph();
  graph.alloc();
  try {
    await toAvFrame(sample, src);
    const args =
      `video_size=${src.width}x${src.height}:pix_fmt=${src.format}:time_base=1/1000000` +
      `:pixel_aspect=1/1:colorspace=${src.colorSpace}:range=${src.colorRange}`;
    const bufferSrc = graph.createFilter(av.Filter.getByName("buffer")!, "src", args);
    const bufferSink = graph.createFilter(av.Filter.getByName("buffersink")!, "sink");
    if (!bufferSrc || !bufferSink) throw new Error("Could not build the frame converter.");
    const outputs = av.FilterInOut.createList([{ name: "in", filterCtx: bufferSrc, padIdx: 0 }]);
    const inputs = av.FilterInOut.createList([{ name: "out", filterCtx: bufferSink, padIdx: 0 }]);
    av.FFmpegError.throwIfError(graph.parsePtr("[in]format=rgba[out]", inputs, outputs), "FilterGraph.parsePtr");
    av.FFmpegError.throwIfError(await graph.config(), "FilterGraph.config");
    av.FFmpegError.throwIfError(await bufferSrc.buffersrcAddFrame(src), "buffersrcAddFrame");
    await bufferSrc.buffersrcAddFrame(null);
    av.FFmpegError.throwIfError(await bufferSink.buffersinkGetFrame(dst), "buffersinkGetFrame");
    const plane = dst.data?.[0];
    if (!plane) throw new Error("The frame converter returned no pixels.");
    const row = dst.width * 4;
    const stride = dst.linesize[0];
    const out = new Uint8Array(row * dst.height);
    if (stride === row) {
      out.set(plane.subarray(0, out.length));
    } else {
      for (let y = 0; y < dst.height; y++) out.set(plane.subarray(y * stride, y * stride + row), y * row);
    }
    return out;
  } finally {
    graph.free();
    src.free();
    dst.free();
  }
}

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
export class NodeFrameSink implements FrameCanvasSink {
  private readonly samples: VideoSampleSink;

  constructor(
    private readonly imageData: new (data: Uint8ClampedArray, w: number, h: number) => ImageData,
    track: InputVideoTrack,
    private readonly size: FrameSize | undefined,
    private readonly toAvFrame: typeof ToAvFrame
  ) {
    this.samples = new VideoSampleSink(track);
  }

  private async wrap(sample: VideoSample): Promise<WrappedCanvas> {
    const { width, height, fit } = this.size ?? {};
    // Always a transform, even at native size: it is what bakes the
    // container's rotation into the pixels.
    let out: VideoSample;
    try {
      out = await sample.transform({
        ...(width !== undefined ? { width: Math.round(width) } : {}),
        ...(height !== undefined ? { height: Math.round(height) } : {}),
        ...(width !== undefined && height !== undefined ? { fit: fit ?? "fill" } : fit ? { fit } : {}),
      });
    } finally {
      sample.close();
    }
    try {
      const pixels = await rgbaOf(out, this.toAvFrame);
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
    setFrameSinkFactory((track, size) => new NodeFrameSink(imageData, track, size, server.toAvFrame));
    return true;
  } catch {
    return false;
  }
}
