import { describe, expect, test } from "bun:test";
import { markPresent, markSeek, markTick, startTrace, stopTrace } from "./perfTrace";

const present = (t: number, exact = true) =>
  markPresent({ t, srcTs: t, wantSrc: t, clipId: "c", exact, stale: false });

describe("seek latency in frames", () => {
  test("the first tick after the ask is not late", () => {
    startTrace();
    markTick();
    markSeek(1);
    markTick();
    present(1);
    const trace = stopTrace()!;
    expect(trace.seeks[0].lateFrames).toBe(0);
    expect(trace.seeks[0].latencyMs).not.toBeNull();
  });

  test("a held frame on the first tick makes the answer one frame late", () => {
    startTrace();
    markSeek(2);
    markTick();
    present(2, false);
    markTick();
    present(2);
    expect(stopTrace()!.seeks[0].lateFrames).toBe(1);
  });

  test("an ask made inside the tick that answers it is not late", () => {
    startTrace();
    markTick();
    markSeek(3);
    present(3);
    expect(stopTrace()!.seeks[0].lateFrames).toBe(0);
  });

  test("a superseded ask never resolves", () => {
    startTrace();
    markSeek(4);
    markSeek(5);
    markTick();
    present(5);
    const trace = stopTrace()!;
    expect(trace.seeks[0].lateFrames).toBeNull();
    expect(trace.seeks[1].lateFrames).toBe(0);
  });
});
