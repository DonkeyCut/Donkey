import { describe, expect, test } from "bun:test";
import { BT2408_HLG_WHITE, pqEncode } from "@donkeycut/effects-kit";
import { extendedSrgbEncode, hdrPreviewState, hlgSignalToDisplayLinear, setHdrPreviewState, subscribeHdrPreviewState } from "./hdrPresent";

describe("the HDR present pass", () => {
  test("HLG reference white lands at 1.0, black at 0, the nominal peak near five", () => {
    const w = BT2408_HLG_WHITE;
    const white = hlgSignalToDisplayLinear(w, w, w);
    for (const v of white) expect(Math.abs(v - 1)).toBeLessThan(2e-3);
    for (const v of hlgSignalToDisplayLinear(0, 0, 0)) expect(v).toBe(0);
    const peak = hlgSignalToDisplayLinear(1, 1, 1);
    for (const v of peak) expect(Math.abs(v - 1000 / 203)).toBeLessThan(2e-2);
    // Neutral stays neutral through the primaries change.
    for (const s of [0.2, 0.5, 0.9]) {
      const [r, g, b] = hlgSignalToDisplayLinear(s, s, s);
      expect(Math.abs(r - g)).toBeLessThan(1e-6);
      expect(Math.abs(g - b)).toBeLessThan(1e-6);
    }
    // A Rec.2020 red goes outside Rec.709: negative green and blue.
    const [, g, b] = hlgSignalToDisplayLinear(w, 0, 0);
    expect(g).toBeLessThan(0);
    expect(b).toBeLessThan(0);
  });

  test("extended sRGB holds the headroom and the negative side", () => {
    expect(extendedSrgbEncode(0)).toBe(0);
    expect(Math.abs(extendedSrgbEncode(1) - 1)).toBeLessThan(1e-9);
    expect(extendedSrgbEncode(4)).toBeGreaterThan(1.5);
    expect(extendedSrgbEncode(-0.5)).toBe(-extendedSrgbEncode(0.5));
    expect(extendedSrgbEncode(0.5)).toBeCloseTo(0.7354, 3);
    // PQ has no part in the present pass: the preview composites in HLG.
    expect(pqEncode(203)).toBeLessThan(BT2408_HLG_WHITE);
  });

  test("the stage state is a store its label subscribes to", () => {
    let fired = 0;
    const off = subscribeHdrPreviewState(() => fired++);
    setHdrPreviewState("sdr");
    expect(hdrPreviewState()).toBe("sdr");
    setHdrPreviewState("sdr");
    expect(fired).toBe(1);
    setHdrPreviewState("off");
    off();
    setHdrPreviewState("hdr");
    expect(fired).toBe(2);
    setHdrPreviewState("off");
  });
});
