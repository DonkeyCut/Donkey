// The page's connection, as the browser reports it. A headless process has no
// browser connection state and reads as online: its network failures surface
// as the errors they are.

/** True while the browser says it has no connection. */
export function isOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}

/** Run `work` each time the browser gets its connection back. */
export function onReconnect(work: () => void): void {
  globalThis.addEventListener?.("online", work);
}

/** A request the connection dropped: no answer came back at all. */
export class ConnectionLostError extends Error {}

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
