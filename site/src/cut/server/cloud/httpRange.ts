/** Byte-range parsing for media delivery. Lives here rather than beside the
 * edge handler that uses it (worker/cf/media.ts) so it sits inside the site's
 * program and can be tested; the Worker's bundler pulls it in. */

export type ParsedRange = { start: number; end: number };

/**
 * Parse a `Range` header against a known object size. Returns null when the
 * request is for the whole object, and "invalid" when the range cannot be
 * satisfied — the caller answers 416 for that, rather than quietly serving
 * something else.
 *
 * Only single ranges are handled. Multi-range requests ask for a multipart
 * response no media element sends, so they read as unsatisfiable.
 */
export function parseRange(
  header: string | null | undefined,
  size: number
): ParsedRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";
  if (size <= 0) return "invalid";
  // A suffix range ("bytes=-500") asks for the last N bytes, clamped to the
  // object when it asks for more than exists.
  if (rawStart === "") {
    const wanted = Number(rawEnd);
    if (wanted <= 0) return "invalid";
    return { start: Math.max(0, size - wanted), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "invalid";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end) return "invalid";
  return { start, end };
}
