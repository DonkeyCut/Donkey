// Shared media through Cloudflare's edge.
//
// A presigned R2 URL points at the S3 API endpoint, which Cloudflare does not
// cache, and its signature is a bearer credential nothing can withdraw — R2
// validates it by arithmetic, with no record that the URL was ever issued. A
// shared link is exactly where both hurt: many viewers pull the same objects,
// and unsharing has to mean something.
//
// So shared media is served from our own hostname instead, by a Worker holding
// a private R2 binding (worker/cf/media.ts). Tokens are ours, so they are
// short — unsharing takes effect within one token's life — and the Worker
// keys its cache on the object path alone, so a token that rotates every few
// minutes still collapses onto one cached copy per object.
//
// The hostname is code (lib/hosts.ts); the signing secret is the only part
// that belongs in the environment, and holding it is what turns this on. A
// deployment without it presigns R2 as before.
import { createHmac, timingSafeEqual } from "node:crypto";
import { CUT_MEDIA_ORIGIN } from "@/cut/lib/hosts";

/** Token lifetime. Short on purpose — it is the revocation window, and the
 * Worker's cache key ignores the token, so shortening it costs no cache hits.
 * The client re-mints ahead of expiry (lib/mediaLinks.ts). */
export const MEDIA_TOKEN_TTL_SECONDS = 5 * 60;

/** The signing secret, when this deployment has one. */
const signingSecret = () => process.env.CUT_MEDIA_SIGNING_SECRET || null;

/** Whether shared media rides the edge Worker on this deployment. */
export const mediaCdnEnabled = () => signingSecret() != null;

/** The signature over one object and expiry. Both sides derive it the same
 * way; the Worker holds the same secret and never calls back here. */
export function mediaSignature(secret: string, key: string, expires: number): string {
  return createHmac("sha256", secret).update(`${key}\n${expires}`).digest("base64url");
}

/** An edge URL for one R2 key, or null when this deployment has no secret. */
export function mediaCdnUrl(key: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  const expires = Math.floor(Date.now() / 1000) + MEDIA_TOKEN_TTL_SECONDS;
  const sig = mediaSignature(secret, key, expires);
  // The key's slashes are path separators on the edge host, so each segment is
  // encoded on its own.
  const path = key.split("/").map(encodeURIComponent).join("/");
  return `${CUT_MEDIA_ORIGIN}/${path}?e=${expires}&s=${sig}`;
}

/** Verify a token the way the Worker does. Kept beside the minting so the two
 * can never drift. */
export function mediaTokenValid(key: string, expires: number, sig: string): boolean {
  const secret = signingSecret();
  if (!secret) return false;
  if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
  const expected = Buffer.from(mediaSignature(secret, key, expires));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
