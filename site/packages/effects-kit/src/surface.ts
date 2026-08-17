/**
 * The drawing surface the kit paints on.
 *
 * Most of the kit takes its canvas from the host's RenderEnv. The pieces that
 * make their own — the cutout matting, the grain tiles — allocate it here, so
 * the same code paints in a tab and in a render worker, which puts a server
 * canvas on `OffscreenCanvas`.
 */
export function kitCanvas(w: number, h: number): HTMLCanvasElement {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement;
  throw new Error("No canvas surface is available here.");
}
