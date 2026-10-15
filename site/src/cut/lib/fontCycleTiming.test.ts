import { describe, expect, test } from "bun:test";
import { beatSwitches, switchProblem, tidySwitches, timedFontCycle, validBeatStep } from "./fontCycleTiming";

const beats = [0, 0.5, 1, 1.5, 2, 2.5, 3];

describe("font cycle timing", () => {
  test("every beat inside the run, closed by the run's end", () => {
    expect(beatSwitches(beats, 1, 0.4, 2.2)).toEqual([0.5, 1, 1.5, 2, 2.2]);
  });

  test("every other beat counts from the run's first", () => {
    expect(beatSwitches(beats, 2, 0.4, 2.2)).toEqual([0.5, 1.5, 2.2]);
  });

  test("half beats split each gap", () => {
    expect(beatSwitches(beats, 0.5, 0.9, 2)).toEqual([1, 1.25, 1.5, 1.75, 2]);
  });

  test("no beat inside the run gives nothing", () => {
    expect(beatSwitches(beats, 1, 3.1, 4)).toEqual([]);
  });

  test("a switch under a frame after the one before merges, the end kept", () => {
    expect(tidySwitches([1, 0.5, 1.005, 2], 3)).toEqual([0.5, 1, 2]);
    expect(tidySwitches([0.5, 1, 1.005], 3)).toEqual([0.5, 1.005]);
  });

  test("problems: too few, too many, too long", () => {
    expect(switchProblem([1])).toEqual({ kind: "few" });
    expect(switchProblem(Array.from({ length: 60 }, (_, i) => i * 0.1))?.kind).toBe("many");
    expect(switchProblem([0, 11])).toEqual({ kind: "long", seconds: 11 });
    expect(switchProblem([0, 1, 2])).toBeNull();
  });

  test("faces repeat in order over the gaps", () => {
    const cycle = timedFontCycle([{ font: "A" }, { font: "B" }], [0.5, 1, 2, 2.5], 15);
    expect(cycle).toEqual({
      faces: [
        { font: "A", hold: 0.5 },
        { font: "B", hold: 1 },
        { font: "A", hold: 0.5 },
      ],
      at: 0.5,
      seconds: 2,
      rate: 15,
    });
  });

  test("beat steps are whole beats or even splits", () => {
    expect([0.25, 0.5, 1, 2, 4].every(validBeatStep)).toBe(true);
    expect([0, -1, 0.3, 1.5].some(validBeatStep)).toBe(false);
  });
});
