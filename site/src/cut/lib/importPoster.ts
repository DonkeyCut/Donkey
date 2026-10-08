import { frameSink, openMedia, videoTrackOf } from "@/cut/lib/mediaRead";
import { rasterCanvasToBlob } from "@/cut/lib/raster";

// Visible import cards share one decoder slot, separate from the upload queue.
let tail: Promise<unknown> = Promise.resolve();

/** A decoded frame of an arriving clip, with its display size and length. */
export type ImportPosterFrame = { blob: Blob; width: number; height: number; duration: number };

/** A frame from the file, with the clip's display size so its tile can take the finished asset's shape. */
export function importPoster(
  file: Blob | string,
  size: number,
  signal: AbortSignal,
): Promise<ImportPosterFrame> {
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
      // The frame keeps the clip's own aspect at the tile's area.
      const width = track.displayWidth;
      const height = track.displayHeight;
      const aspect = width && height ? width / height : 1;
      const frame = await frameSink(
        track,
        { width: Math.round(size * Math.sqrt(aspect)), height: Math.round(size / Math.sqrt(aspect)), fit: "cover" },
        { poolSize: 1 },
      ).getCanvas(0);
      signal.throwIfAborted();
      if (!frame) throw new Error("No readable video frame.");
      try {
        // The length rides along so the viewer's transport reads it from the start.
        const [blob, duration] = await Promise.all([
          rasterCanvasToBlob(frame.canvas, "image/jpeg"),
          track.computeDuration(),
        ]);
        return { blob, width, height, duration };
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
