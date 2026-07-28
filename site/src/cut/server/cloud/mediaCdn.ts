// Cloud media through Cloudflare's edge.
//
// Every byte the browser reads out of a cloud project comes through the media
// Worker (worker/cf/media.ts): a private R2 binding addressed by a signed token
// this module mints. The Worker sets CORS headers itself, which is what Cut
// needs — the preview, the filmstrips and the AI pipeline all read pixels or
// bytes back, so they load with crossOrigin="anonymous" (lib/mediaCors.ts), and
// a response without those headers fails to load rather than degrading.
//
// Tokens are minted on window boundaries rather than at the instant of the
// request, so every mint inside a window yields the identical URL. That is what
// lets a project re-mint its whole batch without disturbing playback: the store
// compares URLs to decide what changed, and a decoder keyed on a URL that
// rotated would be torn down and rebuilt mid-edit.
//
// An object rewritten in place — a preview proxy, a share card, a media filename
// freed by a delete and handed out again — carries a `version` that joins the
// edge cache key, so new bytes are a new cache entry instead of a wait for the
// old one to lapse.
//
// The hostname is code (lib/hosts.ts); the secret is the only part that lives in
// the environment, and the Worker must hold the identical value.
import { createHmac } from "node:crypto";
import { CUT_MEDIA_ORIGIN } from "@/cut/lib/hosts";
import { mediaDownloadName } from "./mediaName";

/** Tokens are minted on boundaries of this window, so every mint inside one
 * produces the same URL. */
const TOKEN_WINDOW_SECONDS = 60 * 60;

/** How long past its window a token keeps working. This is the floor on any
 * token's life and the revocation window — unsharing takes effect within this
 * plus the window the token was minted in. It also has to clear docCache's
 * link-reuse floor (lib/docCache.ts), or a stored batch could never be reused
 * and every cloud project would open on origin URLs. */
const TOKEN_GRACE_SECONDS = 60 * 60;

/** A deployment without the signing secret cannot serve cloud media at all.
 * Carried as its own type so routes answer with a server error in their own
 * words instead of echoing this message — which names an environment variable —
 * to whoever asked, including anonymous share viewers. */
export class MediaNotConfiguredError extends Error {
  constructor() {
    super("CUT_MEDIA_SIGNING_SECRET is not set — cloud media cannot be served");
  }
}

function signingSecret(): string {
  const secret = process.env.CUT_MEDIA_SIGNING_SECRET;
  if (!secret) throw new MediaNotConfiguredError();
  return secret;
}

/** The expiry every token minted in the current window carries. `minLifetime`
 * raises it for a URL that outlives the page that minted it — a crawler holding
 * a share card — and still lands on a window boundary, so those URLs stay stable
 * and cacheable too. */
function tokenExpiry(minLifetimeSeconds = TOKEN_GRACE_SECONDS, at = Date.now()): number {
  const windowMs = TOKEN_WINDOW_SECONDS * 1000;
  const windowEnd = Math.ceil(at / windowMs) * windowMs;
  return Math.floor(windowEnd / 1000) + Math.max(TOKEN_GRACE_SECONDS, minLifetimeSeconds);
}

/** Seconds the tokens minted right now stay good for, so a client re-mints
 * ahead of expiry rather than after a 403. */
export const mediaUrlLifetime = (): number => tokenExpiry() - Math.floor(Date.now() / 1000);

/** The signature over one object, its expiry, and the download name and version
 * it carries — both empty when absent, so the framing is one rule. Signing them
 * is what keeps either from being edited into a URL after the fact. Both sides
 * derive this the same way; the Worker holds the same secret and never calls
 * back here. */
export function mediaSignature(
  secret: string,
  key: string,
  expires: number,
  downloadName = "",
  version = ""
): string {
  return createHmac("sha256", secret)
    .update(`${key}\n${expires}\n${downloadName}\n${version}`)
    .digest("base64url");
}

/** The browser-facing URL for one R2 object.
 *
 * `downloadName` makes it an attachment download under that filename.
 * `version` must change whenever the object's bytes do, for any key written
 * more than once. `minLifetimeSeconds` widens the token for a URL that outlives
 * its page; everything a live page reads leaves it alone, since the token's life
 * is the revocation window. */
export function mediaObjectUrl(
  key: string,
  opts?: { downloadName?: string; version?: string; minLifetimeSeconds?: number }
): string {
  const expires = tokenExpiry(opts?.minLifetimeSeconds);
  const name = opts?.downloadName ? mediaDownloadName(opts.downloadName) : "";
  const version = opts?.version ?? "";
  const sig = mediaSignature(signingSecret(), key, expires, name, version);
  // The key's slashes are path separators on the edge host, so each segment is
  // encoded on its own.
  const path = key.split("/").map(encodeURIComponent).join("/");
  const query = new URLSearchParams({ e: String(expires), s: sig });
  if (version) query.set("v", version);
  if (name) query.set("d", name);
  return `${CUT_MEDIA_ORIGIN}/${path}?${query.toString()}`;
}
