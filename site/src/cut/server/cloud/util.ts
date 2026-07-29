import path from "node:path";
import { LadderStoreNotConfiguredError } from "./ladderStore";
import { MediaNotConfiguredError } from "./mediaCdn";
import { R2NotConfiguredError } from "./r2";

export const err = (message: string, status: number) =>
  Response.json({ error: message }, { status });

export const caught = (e: unknown, fallback: string, status = 500) => {
  if (e instanceof R2NotConfiguredError) return err(e.message, 500);
  // The real reason belongs in the server's logs, not in a response an
  // anonymous share viewer reads: it names the environment variable to set.
  // 5xx also keeps the client's retry — a 4xx reads as "stop asking".
  if (e instanceof MediaNotConfiguredError) {
    console.error(e.message);
    return err("Cloud media is unavailable.", 500);
  }
  if (e instanceof LadderStoreNotConfiguredError) {
    console.error(e.message);
    return err("Streaming is unavailable.", 500);
  }
  return err(e instanceof Error ? e.message : fallback, status);
};

export const redirect = (url: string, headers: Record<string, string> = {}) =>
  new Response(null, { status: 302, headers: { Location: url, ...headers } });

/** Sanitize an upload name the way the engine's saveMedia does. */
export function safeFileName(original: string): string {
  const base = path
    .basename(original)
    .replace(/[^\w.\-() ]+/g, "_")
    .slice(-80);
  if (!base || base.startsWith(".")) throw new Error("Invalid file name.");
  return base;
}

/** A URL path segment decoded and checked: no separators, no dotfiles. */
export function decodeFileParam(raw: string): string {
  const name = decodeURIComponent(raw);
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
    throw new Error("Invalid file name.");
  }
  return name;
}

/** First variant of `base` (stem, stem-1, stem-2, …) not in `taken` — the
 * engine's uniqueName against a known name set instead of the filesystem. */
export function dedupeName(base: string, taken: ReadonlySet<string>): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length) || "media";
  let name = base;
  for (let n = 1; taken.has(name); n++) name = `${stem}-${n}${ext}`;
  return name;
}

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i;
const AUDIO_RE = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif|bmp)$/i;

export function typeOf(fileName: string): "video" | "audio" | "image" | null {
  if (VIDEO_RE.test(fileName)) return "video";
  if (AUDIO_RE.test(fileName)) return "audio";
  if (IMAGE_RE.test(fileName)) return "image";
  return null;
}
