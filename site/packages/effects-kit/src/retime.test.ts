import { describe, expect, test } from "bun:test";
import {
  flatSpeedCurve,
  mirrorRetimable,
  retimeOf,
  speedCurveOf,
  speedCurvePreset,
  SPEED_CURVE_MAX,
  SPEED_CURVE_MIN,
  type SpeedNode,
} from "./retime";

describe("retimeOf", () => {
  test("a clip with no curve reproduces (out − in) / speed exactly", () => {
    const r = retimeOf({ in: 2, out: 8, speed: 1.5 });
    expect(r.uniform).toBe(true);
    expect(r.len).toBe(6 / 1.5);
    expect(r.srcAt(1)).toBe(3.5);
    expect(r.tAt(5)).toBe(2);
    expect(r.rateAt(0)).toBe(1.5);
    expect(r.knots).toEqual([
      [0, 0],
      [6, 4],
    ]);
  });

  test("a reversed span mirrors the forward map and keeps its footprint", () => {
    const f = retimeOf({ in: 2, out: 8, speed: 1.5 });
    const r = retimeOf({ in: 2, out: 8, speed: 1.5, reverse: true });
    expect(r.reverse).toBe(true);
    expect(r.len).toBe(f.len);
    expect(r.rate).toBe(f.rate);
    expect(r.srcAt(0)).toBe(8);
    expect(r.srcAt(r.len)).toBe(2);
    expect(r.srcAt(1)).toBe(6.5);
    expect(r.tAt(6.5)).toBe(1);
    expect(r.knots).toEqual([
      [0, 4],
      [6, 0],
    ]);
    const curve: SpeedNode[] = [
      [1, 0.25],
      [3, 8],
      [5, 1],
    ];
    const cf = retimeOf({ in: 1, out: 5, speedCurve: curve });
    const cr = retimeOf({ in: 1, out: 5, speedCurve: curve, reverse: true });
    expect(cr.len).toBe(cf.len);
    for (let t = 0; t <= cf.len; t += cf.len / 53) {
      expect(cr.srcAt(t)).toBeCloseTo(cf.srcAt(cf.len - t), 9);
      expect(cr.rateAt(t)).toBeCloseTo(cf.rateAt(cf.len - t), 9);
      expect(cr.tAt(cr.srcAt(t))).toBeCloseTo(t, 3);
    }
    let prev = Infinity;
    for (const [, t] of cr.knots) {
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
  });

  test("a reversed span over turned media is the forward span over the copy", () => {
    const curve: SpeedNode[] = [
      [1, 0.25],
      [3, 8],
      [5, 1],
    ];
    const rev = retimeOf({ in: 1, out: 5, speedCurve: curve, reverse: true });
    const turned = mirrorRetimable({ in: 1, out: 5, speedCurve: curve, reverse: true }, 6);
    expect(turned.in).toBe(1);
    expect(turned.out).toBe(5);
    expect(turned.reverse).toBeUndefined();
    const fwd = retimeOf(turned);
    expect(fwd.reverse).toBe(false);
    expect(fwd.len).toBeCloseTo(rev.len, 9);
    for (let t = 0; t <= rev.len; t += rev.len / 41) {
      expect(6 - fwd.srcAt(t)).toBeCloseTo(rev.srcAt(t), 6);
    }
  });

  test("a flat curve equals the uniform map", () => {
    const u = retimeOf({ in: 1, out: 7, speed: 2 });
    const c = retimeOf({ in: 1, out: 7, speedCurve: flatSpeedCurve({ in: 1, out: 7, speed: 2 }) });
    expect(c.uniform).toBe(false);
    expect(c.len).toBeCloseTo(u.len, 6);
    for (let t = 0; t <= u.len; t += 0.25) expect(c.srcAt(t)).toBeCloseTo(u.srcAt(t), 5);
  });

  test("len equals the numerical integral of 1 / rate", () => {
    const curve: SpeedNode[] = [
      [0, 1],
      [2, 4],
      [4, 0.5],
      [6, 1],
    ];
    const r = retimeOf({ in: 0, out: 6, speedCurve: curve });
    let sum = 0;
    const n = 60000;
    for (let i = 0; i < n; i++) {
      const s = ((i + 0.5) * 6) / n;
      sum += (6 / n) / r.rateAtSrc(s);
    }
    expect(r.len).toBeCloseTo(sum, 3);
    expect(r.rate).toBeCloseTo(6 / r.len, 6);
  });

  test("srcAt and tAt round-trip within a frame", () => {
    const curve: SpeedNode[] = [
      [1, 0.25],
      [3, 8],
      [5, 1],
    ];
    const r = retimeOf({ in: 1, out: 5, speedCurve: curve });
    for (let t = 0; t <= r.len; t += r.len / 97) {
      expect(r.tAt(r.srcAt(t))).toBeCloseTo(t, 3);
    }
    for (let s = 1; s <= 5; s += 0.05) {
      expect(r.srcAt(r.tAt(s))).toBeCloseTo(s, 3);
    }
    expect(r.srcAt(0)).toBe(1);
    expect(r.srcAt(r.len)).toBeCloseTo(5, 9);
  });

  test("the map is monotone and the rate stays in range", () => {
    const curve: SpeedNode[] = [
      [0, 0.1],
      [1, 10],
      [1.2, 0.1],
      [3, 10],
    ];
    const r = retimeOf({ in: 0, out: 3, speedCurve: curve });
    let prev = -1;
    for (let t = 0; t <= r.len; t += r.len / 500) {
      const s = r.srcAt(t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
      expect(r.rateAt(t)).toBeGreaterThanOrEqual(SPEED_CURVE_MIN);
      expect(r.rateAt(t)).toBeLessThanOrEqual(SPEED_CURVE_MAX);
    }
  });

  test("extrapolates past the span at the edge rates", () => {
    const r = retimeOf({
      in: 2,
      out: 6,
      speedCurve: [
        [2, 2],
        [6, 0.5],
      ],
    });
    expect(r.srcAt(-1)).toBeCloseTo(0, 9);
    expect(r.tAt(0)).toBeCloseTo(-1, 9);
    expect(r.srcAt(r.len + 1)).toBeCloseTo(6.5, 9);
  });

  test("trimming keeps the footage's pace: nodes hold still", () => {
    const curve: SpeedNode[] = [
      [0, 1],
      [5, 4],
      [10, 1],
    ];
    const whole = retimeOf({ in: 0, out: 10, speedCurve: curve });
    const left = retimeOf({ in: 0, out: 4, speedCurve: curve });
    const right = retimeOf({ in: 4, out: 10, speedCurve: curve });
    expect(left.len + right.len).toBeCloseTo(whole.len, 4);
    expect(left.rateAtSrc(3)).toBeCloseTo(whole.rateAtSrc(3), 9);
    expect(right.srcAt(0)).toBe(4);
  });

  test("knots start at the head, end at the tail, and follow the map", () => {
    const r = retimeOf({
      in: 3,
      out: 9,
      speedCurve: [
        [3, 1],
        [6, 5],
        [9, 1],
      ],
    });
    const first = r.knots[0];
    const last = r.knots[r.knots.length - 1];
    expect(first).toEqual([0, 0]);
    expect(last[0]).toBeCloseTo(6, 9);
    expect(last[1]).toBeCloseTo(r.len, 9);
    expect(r.knots.length).toBeGreaterThan(2);
    expect(r.knots.length).toBeLessThan(200);
    for (const [s, t] of r.knots) expect(t).toBeCloseTo(r.tAt(3 + s), 2);
  });

  test("memoizes on its inputs", () => {
    const c = { in: 0, out: 4, speedCurve: [[0, 1], [4, 2]] as SpeedNode[] };
    expect(retimeOf(c)).toBe(retimeOf({ ...c, speedCurve: [...c.speedCurve] }));
    expect(retimeOf(c)).not.toBe(retimeOf({ ...c, out: 5 }));
  });
});

describe("speedCurveOf", () => {
  test("sorts, clamps, and collapses duplicate moments", () => {
    expect(
      speedCurveOf({
        speedCurve: [
          [4, 0.01],
          [1, 50],
          [1.00001, 2],
        ],
      })
    ).toEqual([
      [1.00001, 2],
      [4, SPEED_CURVE_MIN],
    ]);
    expect(speedCurveOf({ speedCurve: [] })).toBeUndefined();
    expect(speedCurveOf({})).toBeUndefined();
  });
});

describe("speedCurvePreset", () => {
  test("lays a preset over the span in source seconds", () => {
    const nodes = speedCurvePreset("whip", 10, 20)!;
    expect(nodes[0]).toEqual([10, 1]);
    expect(nodes[nodes.length - 1]).toEqual([20, 1]);
    expect(nodes.find((n) => n[1] === 6)![0]).toBe(15);
    expect(speedCurvePreset("nope", 0, 1)).toBeUndefined();
  });
});
