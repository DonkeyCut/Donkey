import { describe, expect, test } from "bun:test";
import { replicasToStart } from "./wakeSize";

// A replica bills its provisioned memory for every second it is up, so the
// number a wake starts is the number the queue can use: one per waiting job,
// reaching past the replicas that running jobs hold, never past the pool.
describe("replicasToStart", () => {
  test("a wake with no body starts one replica", () => {
    expect(replicasToStart(null)).toBe(1);
    expect(replicasToStart({})).toBe(1);
  });

  test("one replica per queued job", () => {
    expect(replicasToStart({ queued: 1, running: 0 })).toBe(1);
    expect(replicasToStart({ queued: 3, running: 0 })).toBe(3);
  });

  test("running jobs hold replicas, so the count reaches past them", () => {
    expect(replicasToStart({ queued: 1, running: 2 })).toBe(3);
  });

  test("never more than the pool", () => {
    expect(replicasToStart({ queued: 9, running: 4 })).toBe(4);
  });

  test("an empty queue still starts one replica", () => {
    expect(replicasToStart({ queued: 0, running: 0 })).toBe(1);
  });

  test("junk counts read as zero", () => {
    expect(replicasToStart({ queued: "4", running: -2 })).toBe(1);
    expect(replicasToStart({ queued: Number.NaN, running: 2.7 })).toBe(2);
  });
});
