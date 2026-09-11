/** A pasted address, made absolute. People copy links without the scheme —
 * "youtube.com/watch?v=…" — and every import path takes http(s) only: the
 * engine, the cloud worker, and the client's own label and shape guess all
 * parse the value as a URL. A value that already carries a scheme passes
 * through untouched, so a link that is genuinely unsupported still fails. */
export function normalizeLink(value: string): string {
  const v = value.trim();
  if (!v) return v;
  if (v.startsWith("//")) return `https:${v}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return `https://${v}`;
}

/** The one link a pasted text holds, normalized, or null when the text is
 * anything else: several lines, words with spaces, a bare name with no host.
 * A format check only; what the link points at is the importer's to judge. */
export function linkFromText(text: string): string | null {
  const v = text.trim();
  if (!v || /\s/.test(v)) return null;
  const href = normalizeLink(v);
  try {
    const u = new URL(href);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.includes(".") ? href : null;
  } catch {
    return null;
  }
}
