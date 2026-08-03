/**
 * Lottie sticker playback: a deterministic frame-seek wrapper over
 * lottie-web's canvas renderer. Preview and export both drive it with
 * goToAndStop, so the same timeline second always draws the same frame.
 * lottie-web loads lazily — hosts that never touch a Lottie sticker never
 * ship or parse it.
 */

export interface LottieHandle {
  width: number;
  height: number;
  /** One play-through, seconds. */
  duration: number;
  /** Draw the frame at `tSec` (wrapped into the duration) and return the
   * backing canvas, sized to the animation's own pixels. */
  seek(tSec: number): HTMLCanvasElement;
  destroy(): void;
}

interface LottieData {
  w?: number;
  h?: number;
  ip?: number;
  op?: number;
  fr?: number;
  layers?: unknown[];
  v?: string;
}

/** Whether parsed JSON looks like a Lottie animation document. */
export function isLottieData(data: unknown): data is LottieData {
  const d = data as LottieData | null;
  return (
    !!d &&
    typeof d === "object" &&
    Array.isArray(d.layers) &&
    typeof d.w === "number" &&
    typeof d.h === "number" &&
    typeof d.fr === "number" &&
    typeof d.op === "number"
  );
}

/** Instantiate a seekable player for a Lottie JSON document. Each handle owns
 * its own backing canvas, so two elements can sit on different frames. */
export async function createLottieHandle(data: unknown): Promise<LottieHandle | null> {
  if (!isLottieData(data) || typeof document === "undefined") return null;
  const lottie = (await import("lottie-web")).default;
  const width = Math.max(2, Math.round(data.w!));
  const height = Math.max(2, Math.round(data.h!));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const anim = lottie.loadAnimation<"canvas">({
    // Unused when a context is provided, but the config type requires it.
    container: document.createElement("div"),
    renderer: "canvas",
    loop: false,
    autoplay: false,
    // A fresh copy per instance: lottie mutates the document as it plays.
    animationData: JSON.parse(JSON.stringify(data)),
    rendererSettings: { context: ctx, clearCanvas: true },
  });
  const fr = data.fr!;
  const frames = Math.max(1, data.op! - (data.ip ?? 0));
  const duration = frames / fr;
  return {
    width,
    height,
    duration,
    seek(tSec: number) {
      const wrapped = ((tSec % duration) + duration) % duration;
      // goToAndStop takes a frame index when isFrame is true and renders it
      // synchronously into the provided context.
      anim.goToAndStop(Math.min(frames - 0.001, wrapped * fr), true);
      return canvas;
    },
    destroy() {
      anim.destroy();
    },
  };
}
