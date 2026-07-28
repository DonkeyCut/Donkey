// The download filename carried by a media token.
//
// Lives here because both sides need the identical rule: the hosted API signs
// the sanitized name (mediaCdn.ts) and the edge Worker sanitizes what arrives
// before checking the signature (worker/cf/media.ts, whose bundler pulls this
// in). Two copies that drift by one character would 403 every download.

/** A download filename with the characters that would break the signature's
 * framing or the header it lands in taken out: quotes, and the newlines that
 * both separate signature fields and terminate a header. */
export const mediaDownloadName = (name: string): string => name.replace(/["\r\n]/g, "");

/** `Content-Disposition` for an attachment under `name`.
 *
 * A header value is a ByteString, so a name with non-ASCII in it cannot go in
 * `filename=` at all — workerd refuses the code points, and a browser that did
 * receive them would guess an encoding. RFC 6266 answers this with both forms:
 * `filename=` carries an ASCII-folded name for anything old, and `filename*=`
 * carries the real one percent-encoded as UTF-8, which every current browser
 * prefers. */
export function contentDisposition(name: string): string {
  const safe = mediaDownloadName(name);
  const ascii = safe.replace(/[^\x20-\x7E]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
