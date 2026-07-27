import { beforeEach, describe, expect, test } from "bun:test";
import { bindCutMode, cutMode, getBackend, releaseCutMode, setCutMode, subscribeCutMode } from "./index";

// The gate (ambient) and an open project's residency (pinned) both write the
// mode, asynchronously, on the same page load. These lock the precedence: a
// cloud project stays on the cloud backend even when the gate finds an engine
// on this Mac a moment later — the failure that sent a cloud project's saves
// and media requests to loopback, where neither exists.
describe("cut mode", () => {
  beforeEach(() => {
    releaseCutMode();
    setCutMode("local");
  });

  test("the ambient mode applies when no project is open", () => {
    expect(cutMode()).toBe("local");
    setCutMode("cloud");
    expect(cutMode()).toBe("cloud");
    expect(getBackend().kind).toBe("cloud");
  });

  test("a pinned project outranks a later ambient write", () => {
    bindCutMode("cloud");
    setCutMode("local"); // the gate's probe lands after the editor bound
    expect(cutMode()).toBe("cloud");
    expect(getBackend().kind).toBe("cloud");
  });

  test("releasing hands the mode back to the ambient value", () => {
    setCutMode("cloud");
    bindCutMode("local");
    expect(cutMode()).toBe("local");
    releaseCutMode();
    expect(cutMode()).toBe("cloud");
  });

  test("subscribers hear effective changes only", () => {
    let calls = 0;
    const stop = subscribeCutMode(() => calls++);
    bindCutMode("cloud");
    expect(calls).toBe(1);
    // Ambient churn under a pin changes nothing anyone can observe.
    setCutMode("cloud");
    setCutMode("local");
    expect(calls).toBe(1);
    releaseCutMode();
    expect(calls).toBe(2);
    stop();
  });
});
