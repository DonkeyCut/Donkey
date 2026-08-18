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
