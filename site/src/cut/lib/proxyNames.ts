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
 * included). */
export const isLightProxyName = (fileName: string) => /\.light(-\d+)?\.mp4$/.test(fileName);

/** What a failed proxy job's row records in `result.fault` when ffmpeg ran and
 * refused the master: the file's own fault, which the cloud route holds off
 * retrying. A row without it failed for a passing reason and retries freely. */
export const PROXY_SOURCE_FAULT = "source";
