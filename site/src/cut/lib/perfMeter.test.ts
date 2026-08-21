import { describe, expect, test } from "bun:test";
import {
  flushMeter,
  meterAudioClock,
  meterFrame,
  meterPerf,
  meterState,
  metering,
  stopMeter,
  type PerfSample,
} from "./perfTrace";

describe("preview diagnostics meter", () => {
  test("a play's frames become one summary", () => {
    const out: PerfSample[] = [];
    meterPerf((s) => out.push(s));
    expect(metering()).toBe(true);
    // Three hundred frames: thirty of them a third of a second behind, ten of
    // those with no decoded picture at all.
    for (let i = 0; i < 300; i++) meterFrame(i < 30 ? 0.3 : 0, i < 10);
    meterState({
      sources: 12,
      held: 40,
      warmMb: 354,
      clips: 20,
      decodeHeight: 540,
      canvasHeight: 900,
    });
    meterAudioClock(0.16, 0.16);
    flushMeter();

    expect(out).toHaveLength(1);
    const s = out[0];
    expect(s.frames).toBe(300);
    expect(s.lateShare).toBe(0.1);
    expect(s.staleShare).toBe(0.033);
    expect(s.hitchShare).toBe(0.1);
    expect(s.lagMaxS).toBe(0.3);
    expect(s.audioLeadS).toBe(0.16);
    expect(s.audioLatencyS).toBe(0.16);
    expect(s.sources).toBe(12);
    expect(s.warmMb).toBe(354);
    expect(s.clips).toBe(20);
    expect(s.decodeHeight).toBe(540);
    stopMeter();
    expect(metering()).toBe(false);
  });

  test("a few frames are noise, and are not sent", () => {
    const out: PerfSample[] = [];
    meterPerf((s) => out.push(s));
    for (let i = 0; i < 20; i++) meterFrame(0.5, false);
    flushMeter();
    expect(out).toHaveLength(0);
    stopMeter();
  });

  test("counting costs nothing until it is armed", () => {
    expect(metering()).toBe(false);
    meterFrame(1, true);
    meterAudioClock(1, 1);
    flushMeter();
    expect(metering()).toBe(false);
  });
});
