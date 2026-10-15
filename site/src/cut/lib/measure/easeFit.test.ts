import { expect, test } from "bun:test";
import { easeAt, type EaseId } from "@donkeycut/effects-kit";
import { fitMoves } from "./easeFit";

const FPS = 60;

/** A value holding at `v0`, moving to `v1` along `ease` over [t0, t1], then
 * holding — sampled every frame and rounded to `px` steps like a measured box. */
function series(ease: EaseId, t0: number, t1: number, v0: number, v1: number, end: number, px = 1 / 1080) {
  const times: number[] = [];
  const values: number[] = [];
  for (let f = 0; f / FPS <= end; f++) {
    const t = f / FPS;
    const p = (t - t0) / (t1 - t0);
    times.push(t);
    values.push(Math.round((v0 + (v1 - v0) * easeAt(ease, p)) / px) * px);
  }
  return { times, values };
}

test("a grow along power3.out is named power3.out with its ends and times", () => {
  const { times, values } = series("power3.out", 0.5, 1.0, 0.1, 0.6, 2);
  const [move] = fitMoves(times, values, 1 / 1080);
  expect(move.ease).toBe("power3.out");
  expect(move.start).toBeCloseTo(0.1, 3);
  expect(move.end).toBeCloseTo(0.6, 3);
  expect(move.from).toBeCloseTo(0.5, 2);
  expect(move.to).toBeCloseTo(1.0, 1);
  expect(move.error).toBeLessThan(0.02);
});

test("a linear slide is named linear", () => {
  const { times, values } = series("linear", 0.2, 0.7, 0.9, 0.3, 1.5);
  const [move] = fitMoves(times, values, 1 / 1080);
  expect(move.ease).toBe("linear");
  expect(move.from).toBeCloseTo(0.2, 2);
  expect(move.to).toBeCloseTo(0.7, 2);
});

test("an ease-in that starts too slowly to see still starts on time", () => {
  const { times, values } = series("power2.in", 0.3, 0.8, 0, 0.5, 1.5);
  const [move] = fitMoves(times, values, 1 / 1080);
  expect(move.ease).toBe("power2.in");
  expect(move.from).toBeCloseTo(0.3, 1);
});

test("a hold is no move, and two moves come back as two", () => {
  const still = fitMoves([0, 0.1, 0.2, 0.3], [0.5, 0.5, 0.5, 0.5], 1 / 1080);
  expect(still).toEqual([]);
  const a = series("linear", 0.2, 0.5, 0.2, 0.8, 1);
  const b = series("linear", 1.2, 1.5, 0.8, 0.2, 2);
  const times = [...a.times, ...b.times.filter((t) => t > 1 + 1e-9)];
  const values = [...a.values, ...b.values.filter((_, i) => b.times[i] > 1 + 1e-9)];
  const moves = fitMoves(times, values, 1 / 1080);
  expect(moves).toHaveLength(2);
  expect(moves[0].end).toBeCloseTo(0.8, 3);
  expect(moves[1].end).toBeCloseTo(0.2, 3);
});

test("a frame where the element is gone splits the series", () => {
  const values: (number | null)[] = [0.2, 0.2, null, null, 0.2, 0.2];
  expect(fitMoves([0, 0.1, 0.2, 0.3, 0.4, 0.5], values, 1 / 1080)).toEqual([]);
});
