// The page's connection, as the browser reports it. A headless process has no
// browser connection state and reads as online: its network failures surface
// as the errors they are.

import { UserError } from "./userError";

/** True while the browser says it has no connection. */
export function isOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}

/** Run `work` each time the browser gets its connection back. */
export function onReconnect(work: () => void): void {
  globalThis.addEventListener?.("online", work);
}

/** A request the connection dropped: no answer came back at all. It carries
 * the code of the failure the person reads, e.g. `upload_failed`. */
export class ConnectionLostError extends UserError {}

/** Whether `err` is fetch giving up on the network, by the TypeError every
 * browser throws for it, e.g. Chrome's "Failed to fetch", or Firefox's "Error
 * in input stream" for a body cut off mid-read. */
export function fetchDropped(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|network\s*error|load failed|connection|input stream/i.test(err.message);
}

/** Whether `err` is the connection failing rather than a server answering:
 * a dropped request, or any failure while offline. */
export function connectionLost(err: unknown): boolean {
  return err instanceof ConnectionLostError || fetchDropped(err) || isOffline();
}

// The status a server answers a client asking too often.
const TOO_MANY_REQUESTS = 429;

/** How long to hold off a throttle that names no wait: the window the site
 * firewall counts requests in (site/firewall/). */
const THROTTLE_WAIT_MS = 10_000;

/** How long `res` asks the caller to wait before asking again, or null when it
 * is no throttle. Retry-After comes as seconds or as a date, e.g. "3". */
export function throttleWait(res: Response, now = Date.now()): number | null {
  if (res.status !== TOO_MANY_REQUESTS) {
    return null;
  }

  const header = res.headers.get("retry-after");
  if (!header) {
    return THROTTLE_WAIT_MS;
  }
  const seconds = Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(wait) ? Math.max(0, wait) : THROTTLE_WAIT_MS;
}
