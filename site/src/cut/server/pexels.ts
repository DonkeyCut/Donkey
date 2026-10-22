// A Pexels video page names its video but the page itself answers a server's
// fetch with a challenge, so its file is found on the CDN instead: an older
// video keeps its renditions at a predictable path, named by size and frame
// rate. A newer one names its files by a second id only the page shows, so
// its CDN link comes off the page and imports as it is.

const PAGE_RE = /^https?:\/\/(?:www\.)?pexels\.com\/(?:[a-z]{2}-[a-z]{2}\/)?video\/([a-z0-9-]*?)-?(\d+)\/?(?:[?#].*)?$/i;

const CDN = "https://videos.pexels.com/video-files";

const FILE_RE = /^https?:\/\/videos\.pexels\.com\/video-files\/(\d+)\/[^/?#]+\.(?:mp4|mov|webm)(?:[?#].*)?$/i;

/** The renditions worth importing, best first: 1080p either way up, then the
 * larger and smaller sizes a video shot before 1080p or above it may hold
 * instead. */
const SIZES = [
  "hd_1920_1080",
  "hd_1080_1920",
  "uhd_2560_1440",
  "uhd_1440_2560",
  "hd_1280_720",
  "hd_720_1280",
  "uhd_3840_2160",
  "uhd_2160_3840",
  "sd_960_540",
  "sd_540_960",
  "sd_640_360",
  "sd_360_640",
];

/** The rates a rendition's name carries; one video's sizes can differ. */
const RATES = [24, 25, 30, 50, 60];

/** The video a Pexels link points at: its id and a title — the words of a
 * page's slug — and, for a link to one of its files on the CDN, that file.
 * Null for any other link. */
export function pexelsVideo(url: string): { id: string; title: string; file?: string } | null {
  const f = FILE_RE.exec(url.trim());
  if (f) return { id: f[1], title: `Pexels ${f[1]}`, file: url.trim() };
  const m = PAGE_RE.exec(url.trim());
  if (!m) return null;
  const words = m[1].replace(/-/g, " ").trim();
  return { id: m[2], title: words ? words[0].toUpperCase() + words.slice(1) : `Pexels ${m[2]}` };
}

/** Whether a file is there, by a HEAD request. */
async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The best rendition of a Pexels video on the CDN, or null when it holds
 * none. Each size's rates are asked at once and the first size with a file
 * wins. */
export async function pexelsFileUrl(id: string, exists: (url: string) => Promise<boolean> = headOk): Promise<string | null> {
  for (const size of SIZES) {
    const urls = RATES.map((r) => `${CDN}/${id}/${id}-${size}_${r}fps.mp4`);
    const found = await Promise.all(urls.map(exists));
    const hit = urls.find((_, i) => found[i]);
    if (hit) return hit;
  }
  return null;
}
