// Edge caching for the public shared-viewer API.
//
// A share link is at its most useful in the window the owner has stopped
// editing: they paste it somewhere and a crowd opens the same token at once.
// So the cache lifetime tracks how long the project has been still — a doc
// saved seconds ago is served near-live, one untouched for an hour is served
// from the edge for minutes. `stale-while-revalidate` keeps every viewer off
// the origin path either way: the edge answers immediately and refreshes
// behind the request.
//
// Only public shares are cacheable. A restricted share's response depends on
// the viewer's session cookie, so it must never land in a shared cache entry.
import type { ShareRow } from "./sharedView";

/** Bounds of the adaptive window, in seconds. */
const MIN_TTL = 5;
const MAX_TTL = 300;
/** Ratio of idle time to cache lifetime: still for 20 minutes → cached a
 * minute. Linear so there is no cliff for the client's poll interval to
 * oscillate across. */
const IDLE_DIVISOR = 20;
/** The access decision itself (share meta) rides a shorter leash so revoking
 * a link takes effect within the minute. */
const META_MAX_TTL = 60;
/** How long the edge may keep serving a stale copy while it refreshes. */
const STALE_WHILE_REVALIDATE = 86400;

/** Seconds of cache lifetime earned by a doc last written at `updatedAt`. */
export function shareTtlSeconds(updatedAt: Date | null | undefined, cap = MAX_TTL): number {
  if (!updatedAt) return MIN_TTL;
  const idleSeconds = Math.max(0, (Date.now() - updatedAt.getTime()) / 1000);
  return Math.round(Math.min(cap, Math.max(MIN_TTL, idleSeconds / IDLE_DIVISOR)));
}

/** Cache headers for one shared response, plus the poll interval the viewer
 * should adopt. Restricted shares get a no-store answer and the floor
 * interval — they are session-dependent and cannot be shared between viewers.
 */
export function shareCacheHeaders(
  share: Pick<ShareRow, "access">,
  updatedAt: Date | null | undefined,
  opts: { meta?: boolean } = {}
): Record<string, string> {
  const ttl = shareTtlSeconds(updatedAt, opts.meta ? META_MAX_TTL : MAX_TTL);
  // The viewer's change poll runs on the doc's lifetime, not meta's shorter
  // one: polling faster than the doc can change only burns requests.
  const pollAfter = shareTtlSeconds(updatedAt);
  if (share.access !== "public") {
    return {
      "Cache-Control": "private, no-store",
      "x-cut-poll-after": String(pollAfter),
    };
  }
  // No Vary on Cookie: a public share resolves before any session is read, so
  // every viewer gets the same bytes. Varying would give each signed-in viewer
  // a private cache entry and undo the caching entirely.
  return {
    "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=${STALE_WHILE_REVALIDATE}`,
    "x-cut-poll-after": String(pollAfter),
  };
}

/** Headers for a redirect to a signed media URL. The signature is minted in
 * fixed windows (see r2.ts), so the redirect is reusable until the window
 * turns over; keep it well inside that window. */
export function shareRedirectHeaders(
  share: Pick<ShareRow, "access">,
  ttlSeconds: number
): Record<string, string> {
  if (share.access !== "public") return { "Cache-Control": "private, no-store" };
  return { "Cache-Control": `public, s-maxage=${ttlSeconds}` };
}
