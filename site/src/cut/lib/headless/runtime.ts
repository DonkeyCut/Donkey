import { installNodeMedia } from "./nodeMedia";
import { installHeadlessFonts } from "./nodeFonts";
import { installSkiaRaster } from "./skiaRaster";

/**
 * Everything a process without a page needs before it runs Cut's own code.
 *
 * The editor's library is written against browser primitives — canvases,
 * WebCodecs, Web Audio, loaded fonts. Those four are swapped underneath here
 * and the library then runs as written: the same silence scan,
 * the same watch sampler, the same overlay rasterizer, the same mixdown. What
 * a job can do is then what the editor can do, by construction.
 *
 * Everything here degrades on its own. A process missing a native module
 * loses that capability and keeps the rest.
 */
export interface HeadlessRuntime {
  raster: boolean;
  media: boolean;
  fonts: number;
}

let installed: Promise<HeadlessRuntime> | null = null;
let current: HeadlessRuntime | null = null;

export function installHeadlessRuntime(): Promise<HeadlessRuntime> {
  installed ??= (async () => {
    // Raster first: the frame sink draws into canvases the seam hands out.
    const raster = await installSkiaRaster();
    const [media, fonts] = await Promise.all([installNodeMedia(), installHeadlessFonts()]);
    const rt = { raster, media, fonts };
    current = rt;
    return rt;
  })();
  return installed;
}

/** What this process actually got, or null before the install finishes. Code
 * that has to answer synchronously — a tool dispatch — reads it to tell a
 * capability it has from one it has to refuse. */
export const headlessRuntime = (): HeadlessRuntime | null => current;

/** One line for a startup log. */
export const describeRuntime = (r: HeadlessRuntime): string =>
  `raster: ${r.raster ? "skia" : "unavailable"}, media: ${r.media ? "nodeav" : "unavailable"}, fonts: ${r.fonts}`;
