import { describe, expect, test } from "bun:test";
import { retimeOf } from "@donkeycut/effects-kit";
import { fitSpan, retimeFits } from "./retimeFit";

const ramp = (n: number) => Float32Array.from({ length: n }, (_, i) => i / n);

describe("fitSpan", () => {
  test("a plain span comes back as it went in", () => {
    const rt = retimeOf({ in: 0, out: 1, speed: 1 });
    expect(retimeFits(rt)).toBe(false);
    const out = fitSpan([ramp(100)], 100, rt, 0);
    expect(Array.from(out.channels[0])).toEqual(Array.from(ramp(100)));
    expect(out.head).toBe(0);
  });

  test("a reversed span at 1× is the samples turned around", () => {
    const rt = retimeOf({ in: 0, out: 1, speed: 1, reverse: true });
    expect(retimeFits(rt)).toBe(true);
    const out = fitSpan([ramp(100)], 100, rt, 0);
    expect(out.channels[0].length).toBe(100);
    expect(out.channels[0][0]).toBeCloseTo(0.99, 6);
    expect(out.channels[0][99]).toBe(0);
    // Turned around, the first sample is the far end of what was read.
    expect(out.head).toBeCloseTo(1, 6);
  });

  test("a reversed span at 2× is half as long and runs downhill", () => {
    const rt = retimeOf({ in: 0, out: 1, speed: 2, reverse: true });
    const out = fitSpan([ramp(1000)], 1000, rt, 0);
    expect(Math.abs(out.channels[0].length - 500)).toBeLessThan(40);
    const head = out.channels[0].slice(0, 50).reduce((a, b) => a + b, 0) / 50;
    const tail = out.channels[0].slice(-50).reduce((a, b) => a + b, 0) / 50;
    expect(head).toBeGreaterThan(tail);
  });

  test("a reversed curve lands on the map's length", () => {
    const rt = retimeOf({
      in: 0,
      out: 2,
      speedCurve: [
        [0, 0.5],
        [2, 2],
      ],
      reverse: true,
    });
    const out = fitSpan([ramp(2000), ramp(2000)], 1000, rt, 0);
    expect(out.channels.length).toBe(2);
    expect(out.channels[0].length).toBe(Math.round(rt.len * 1000));
  });

  test("a reversed span read short of its far end starts later", () => {
    const rt = retimeOf({ in: 0, out: 2, speed: 1, reverse: true });
    // Asked for source [0, 2], the file gave [0, 1]. Turned around, the sound
    // in hand opens at source second 1, which the clip reaches a second in —
    // so it is laid a second after the span's own head.
    const out = fitSpan([ramp(100)], 100, rt, 0, 2);
    expect(out.head).toBeCloseTo(1, 6);
    expect(out.shift).toBeCloseTo(1, 6);
  });

  test("a whole read is laid where the span says", () => {
    const rt = retimeOf({ in: 0, out: 1, speed: 1, reverse: true });
    expect(fitSpan([ramp(100)], 100, rt, 0, 1).shift).toBeCloseTo(0, 6);
    const fwd = retimeOf({ in: 0, out: 1, speed: 1 });
    expect(fitSpan([ramp(100)], 100, fwd, 0, 1).shift).toBeCloseTo(0, 6);
  });

  test("a rate a hair off 1 is still a fit", () => {
    const rt = retimeOf({ in: 0, out: 1, speed: 1.0005 });
    expect(retimeFits(rt)).toBe(true);
    const out = fitSpan([ramp(1000)], 1000, rt, 0);
    expect(Math.abs(out.channels[0].length - 1000 / 1.0005)).toBeLessThan(40);
  });
});
