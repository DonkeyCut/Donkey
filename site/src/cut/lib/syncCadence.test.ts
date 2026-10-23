import { expect, test } from "bun:test";
import { CHAT_RUNTIME } from "./chatRuntime";
import { nextSyncMs, SYNC_IDLE_MAX_MS } from "./syncCadence";

test("a still project widens the wait up to the idle ceiling", () => {
  let wait: number = CHAT_RUNTIME.syncIntervalMs;
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    wait = nextSyncMs(wait, "still");
    waits.push(wait);
  }
  expect(waits).toEqual([10_000, 20_000, SYNC_IDLE_MAX_MS, SYNC_IDLE_MAX_MS, SYNC_IDLE_MAX_MS]);
});

test("a change snaps the wait back to the sync interval", () => {
  expect(nextSyncMs(SYNC_IDLE_MAX_MS, "moved")).toBe(CHAT_RUNTIME.syncIntervalMs);
});
