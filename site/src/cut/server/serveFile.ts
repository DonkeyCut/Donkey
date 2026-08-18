import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeFor(p: string) {
  return TYPES[path.extname(p).toLowerCase()] ?? "application/octet-stream";
}

/** `?download=1` on a media URL asks for the bytes as an attachment. The same
 * flag reads the same way on both backends: the engine sets the disposition
 * header itself, the cloud signs the name into the object URL it redirects to.
 * The name is always the stored file's own, never anything off the query. */
export function wantsDownload(req: Request): boolean {
  return new URL(req.url).searchParams.has("download");
}

interface Opts {
  /** Override the MIME type (defaults to the extension's type). */
  contentType?: string;
  /** When set, serve as a download with this filename. */
  downloadName?: string;
}

/**
 * Serve a file from disk with HTTP Range support (206/416), so <video>/<audio>
 * elements and the export download can seek efficiently. Shared by every
 * project/library/export media route.
 */
export async function serveFileRange(
  filePath: string,
  req: Request,
  opts: Opts = {}
): Promise<Response> {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return new Response("Not found.", { status: 404 });

  const size = info.size;
  const headers: Record<string, string> = {
    "Content-Type": opts.contentType ?? contentTypeFor(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  if (opts.downloadName)
    headers["Content-Disposition"] = `attachment; filename="${opts.downloadName}"`;

  const range = req.headers.get("range");
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!m[1]) {
      // suffix range: last N bytes
      start = Math.max(0, size - parseInt(m[2], 10));
      end = size - 1;
    }
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response("Range not satisfiable.", {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    headers: { ...headers, "Content-Length": String(size) },
  });
}
