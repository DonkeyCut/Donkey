/**
 * The light proxy: a heavy video's preview copy, built to stream at a fast
 * cut's pace. It is capped in bitrate as well as
 * height — a quality target alone gave a dense 1080p master a proxy heavier
 * than itself — and it carries its own name, so a project still holding an
 * older full-quality proxy for such a video asks again and gets this one.
 * Its bitrate ceiling is the cutProxy setting. Shared by the page, the cloud
 * route and the worker.
 */

/** The light proxy's file name beside its master: the whole master name, so
 * clip.mov and clip.mp4 never share one. */
export const lightProxyNameFor = (fileName: string) => `${fileName}.light.mp4`;

/** Whether a proxy's file name is a light proxy's (a deduped `.light-1.mp4`
 * included). A light compat proxy is one too. */
export const isLightProxyName = (fileName: string) => /\.light(-\d+)?\.(mp4|webm)$/.test(fileName);

/**
 * The compat proxy: the master with each stream this browser cannot decode
 * written in a codec every browser does (codecSupport.ts). "video" is VP9
 * picture with Opus sound in WebM, for a browser without H.264; "audio" keeps
 * the master's picture and writes Opus sound in MP4, for a browser whose AAC
 * decoder fails. A light one is capped like a heavy video's light proxy.
 */
export type CompatCover = "audio" | "video";

/** The compat proxy's file name beside its master. */
export const compatProxyNameFor = (fileName: string, cover: CompatCover, light: boolean) =>
  `${fileName}.compat${light ? ".light" : ""}.${cover === "video" ? "webm" : "mp4"}`;

/** A request's `compat` field as a cover, or null when it names none. */
export const compatCoverIn = (value: unknown): CompatCover | null =>
  value === "audio" || value === "video" ? value : null;

/** Where the preview reads `need` from: the compat proxy when it covers that
 * stream, else null for the master. */
export function compatUrl(asset: { proxy?: { fileName: string }; proxyUrl?: string }, need: CompatCover): string | null {
  if (!asset.proxy || !asset.proxyUrl) {
    return null;
  }
  return compatCovers(asset.proxy.fileName, need) ? asset.proxyUrl : null;
}

/** What a compat proxy covers, by its name (a deduped `-1` included); null for
 * any other proxy. */
export function compatCoverOf(fileName: string): CompatCover | null {
  const m = /\.compat(\.light)?(-\d+)?\.(mp4|webm)$/.exec(fileName);
  if (!m) return null;
  return m[3] === "webm" ? "video" : "audio";
}

/** Whether the proxy named `fileName` serves a browser missing `need`: a VP9
 * proxy carries Opus sound as well. */
export function compatCovers(fileName: string, need: CompatCover): boolean {
  const cover = compatCoverOf(fileName);
  return cover === "video" || (cover !== null && cover === need);
}

/** What a failed proxy job's row records in `result.fault` when ffmpeg ran and
 * refused the master: the file's own fault, which the cloud route holds off
 * retrying. A row without it failed for a passing reason and retries freely. */
export const PROXY_SOURCE_FAULT = "source";
