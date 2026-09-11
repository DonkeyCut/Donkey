// What a video URL in an article resolves to. A YouTube or Vimeo address
// becomes its embed frame; a direct media file plays in a <video>; anything
// else is left as a link. This looks only at the host and the file extension.

export type BlogVideoSource =
  | { kind: "youtube" | "vimeo"; embedSrc: string }
  | { kind: "file"; src: string };

const FILE_EXTENSIONS = /\.(mp4|webm|mov|m4v)$/i;

export function parseVideoUrl(input: string): BlogVideoSource | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return id ? youtube(id, url) : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const watch = url.searchParams.get("v");
    if (watch) return youtube(watch, url);
    const path = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
    return path?.[1] ? youtube(path[1], url) : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const id = url.pathname.match(/(\d{6,})/)?.[1];
    if (!id) return null;
    const hash = url.searchParams.get("h") ?? url.pathname.match(/^\/\d+\/([a-z0-9]+)/)?.[1];
    return {
      kind: "vimeo",
      embedSrc: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`,
    };
  }
  if (FILE_EXTENSIONS.test(url.pathname)) return { kind: "file", src: url.toString() };
  return null;
}

function youtube(id: string, url: URL): BlogVideoSource | null {
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
  const start = url.searchParams.get("t") ?? url.searchParams.get("start");
  const seconds = start ? parseStart(start) : 0;
  return {
    kind: "youtube",
    embedSrc: `https://www.youtube-nocookie.com/embed/${id}${seconds > 0 ? `?start=${seconds}` : ""}`,
  };
}

// "90", "90s", "1m30s", "1h2m3s".
function parseStart(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}
