import { describe, expect, test } from "bun:test";
import { sweepPicks, sweepQuestions, sweepState, type SweepCandidate } from "./sweepSelect";

const items: SweepCandidate[] = [
  { id: "clip-a", label: '"intro.mp4", starts 0s, 4s long' },
  { id: "clip-b", label: '"beach.mp4", starts 4s, 6s long, muted' },
  { id: "clip-c", label: '"outro.mp4", starts 10s, 2s long' },
];

const noul = (n: number) => ({ type: "noul" as const, noul: n });

describe("sweepQuestions", () => {
  test("one yes/no per candidate", () => {
    const qs = sweepQuestions("the muted ones", items);
    expect(Object.keys(qs)).toEqual(["s0", "s1", "s2"]);
    expect(qs.s0.type).toBe("noul");
  });
});

describe("sweepState", () => {
  test("carries the ask, the chunk's own items, and how many there are", () => {
    const state = sweepState("the muted ones", items, ["s1"]) as {
      asked_for: string;
      items: { key: string; is: string }[];
      total: number;
    };
    expect(state.asked_for).toBe("the muted ones");
    expect(state.items).toEqual([{ key: "s1", is: '"beach.mp4", starts 4s, 6s long, muted' }]);
    expect(state.total).toBe(3);
  });

  test("ids stay off the wire — the keys carry them back", () => {
    expect(JSON.stringify(sweepState("x", items, ["s0", "s1", "s2"]))).not.toContain("clip-a");
  });
});

describe("sweepPicks", () => {
  test("every candidate above the floor, with its fit", () => {
    const picks = sweepPicks({ s0: noul(0.9), s1: noul(0.2), s2: noul(0.6) }, items, 0.5);
    expect(picks.map((p) => p.id)).toEqual(["clip-a", "clip-c"]);
    expect(picks[0].fit).toBe(0.9);
  });

  test("a chunk that failed leaves its items out instead of guessing", () => {
    expect(sweepPicks({ s0: noul(0.9) }, items, 0.5).map((p) => p.id)).toEqual(["clip-a"]);
    expect(sweepPicks(null, items, 0.5)).toEqual([]);
  });

  test("nothing matching is an empty list, not everything", () => {
    expect(sweepPicks({ s0: noul(0.1), s1: noul(0.1), s2: noul(0.1) }, items, 0.5)).toEqual([]);
  });
});
