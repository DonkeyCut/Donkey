import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_RUNTIME_MS, DRAIN_MS, LONGEST_RUN_MS, MAX_RUNTIME_MS } from "./jobLimits";

describe("job limits", () => {
  // A replica's idle timer renews only on a wake, and a running job sends
  // none, so the timer has to outlast every job and the drain behind it. At
  // fifteen minutes it stopped every longer export partway and requeued it.
  test("a replica outlasts the longest job and its drain", () => {
    for (const ms of [DEFAULT_MAX_RUNTIME_MS, ...Object.values(MAX_RUNTIME_MS)]) {
      expect(LONGEST_RUN_MS).toBeGreaterThanOrEqual(ms + DRAIN_MS);
    }
  });
});
