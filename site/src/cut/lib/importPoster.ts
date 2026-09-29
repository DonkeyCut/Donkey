import { frameSink, openMedia, videoTrackOf } from "@/cut/lib/mediaRead";
import { rasterCanvasToBlob } from "@/cut/lib/raster";

// Visible import cards share one decoder slot, separate from the upload queue.
let tail: Promise<unknown> = Promise.resolve();

export function importPoster(file: Blob, size: number, signal: AbortSignal): Promise<Blob> {
  const result = tail.then(async () => {
    signal.throwIfAborted();
    const input = openMedia(file);
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      input.dispose();
    };
    signal.addEventListener("abort", dispose, { once: true });
    try {
      const track = await videoTrackOf(input);
      signal.throwIfAborted();
      if (!track) throw new Error("No readable video frame.");
      const frame = await frameSink(track, { width: size, height: size, fit: "cover" }, { poolSize: 1 }).getCanvas(0);
      signal.throwIfAborted();
      if (!frame) throw new Error("No readable video frame.");
      try {
        return await rasterCanvasToBlob(frame.canvas, "image/jpeg");
      } finally {
        frame.canvas.width = 0;
        frame.canvas.height = 0;
      }
    } finally {
      signal.removeEventListener("abort", dispose);
      dispose();
    }
  });
  tail = result.catch(() => {});
  return result;
}
