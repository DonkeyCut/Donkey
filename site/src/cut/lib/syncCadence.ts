import { CHAT_RUNTIME } from "./chatRuntime";

// How an open editor paces its re-reads of a project and its chats. Each
// re-read of a cloud project is a hosted request, so an idle tab widens toward
// the ceiling; a change, the window coming back, or this tab's own chat snaps
// it back to the sync interval.
export const SYNC_IDLE_MAX_MS = 30_000;

// What the last re-read found: the project changed, or nothing did.
export type SyncPulse = "moved" | "still";

/** The wait before the next re-read: 10s, 20s, then 30s while still; the sync
 * interval once anything moves. */
export function nextSyncMs(lastMs: number, pulse: SyncPulse): number {
  if (pulse === "moved") {
    return CHAT_RUNTIME.syncIntervalMs;
  }
  return Math.min(lastMs * 2, SYNC_IDLE_MAX_MS);
}
