import { describe, expect, test } from "bun:test";

import type { ExperimentMetric } from "./experiment";
import { computeResults, DEFAULT_THRESHOLDS, MIN_EXPOSED_PER_VARIANT, type VariantCount } from "./results";

const purchase: ExperimentMetric = { key: "purchase", name: "Purchase", source: "purchase", event: null };

const run = (counts: VariantCount[], metrics: ExperimentMetric[] = [purchase]) =>
  computeResults({
    computedAt: new Date("2026-09-04T00:00:00Z"),
    control: "control",
    metrics: metrics.map((metric) => ({ metric, counts })),
    notes: [],
  });

describe("results", () => {
  test("no metric leaves nothing to read", () => {
    const r = run([], []);
    expect(r.verdict.state).toBe("insufficient");
    expect(r.metrics).toEqual([]);
  });

  test("too few exposures is too early", () => {
    const r = run([
      { key: "control", exposed: 20, converted: 2 },
      { key: "treatment", exposed: 20, converted: 6 },
    ]);
    expect(r.verdict.state).toBe("insufficient");
    expect(r.verdict.neededPerArm).toBeGreaterThanOrEqual(MIN_EXPOSED_PER_VARIANT);
  });

  test("a clear win ships", () => {
    const r = run([
      { key: "control", exposed: 1000, converted: 40 },
      { key: "treatment", exposed: 1000, converted: 80 },
    ]);
    expect(r.verdict.state).toBe("ship");
    expect(r.verdict.variant).toBe("treatment");
    expect(r.metrics[0].comparisons[0].pValue!).toBeLessThan(0.05);
  });

  test("a clear loss stops early, before a full sample", () => {
    const r = run([
      { key: "control", exposed: 60, converted: 12 },
      { key: "treatment", exposed: 60, converted: 1 },
    ]);
    expect(r.verdict.state).toBe("stop");
    expect(r.verdict.variant).toBe("treatment");
  });

  test("a wash with a full sample keeps running", () => {
    const r = run([
      { key: "control", exposed: 500, converted: 25 },
      { key: "treatment", exposed: 500, converted: 27 },
    ]);
    expect(r.verdict.state).toBe("keep_running");
    expect(r.verdict.neededPerArm).not.toBeNull();
  });

  test("the best of several winners is named; one loser among winners does not stop", () => {
    const r = run([
      { key: "control", exposed: 1000, converted: 40 },
      { key: "a", exposed: 1000, converted: 70 },
      { key: "b", exposed: 1000, converted: 90 },
      { key: "c", exposed: 1000, converted: 5 },
    ]);
    expect(r.verdict.state).toBe("ship");
    expect(r.verdict.variant).toBe("b");
  });

  test("the first metric decides; the rest are reported", () => {
    const exportMetric: ExperimentMetric = { key: "export", name: "Export", source: "event", event: "export_completed" };
    const r = computeResults({
      computedAt: new Date(),
      control: "control",
      metrics: [
        {
          metric: purchase,
          counts: [
            { key: "control", exposed: 500, converted: 25 },
            { key: "treatment", exposed: 500, converted: 27 },
          ],
        },
        {
          metric: exportMetric,
          counts: [
            { key: "control", exposed: 500, converted: 100 },
            { key: "treatment", exposed: 500, converted: 200 },
          ],
        },
      ],
      notes: ["a note"],
    });
    expect(r.verdict.state).toBe("keep_running");
    expect(r.metrics.map((m) => m.key)).toEqual(["purchase", "export"]);
    expect(r.notes).toEqual(["a note"]);
  });
});

describe("thresholds", () => {
  const close = [
    { key: "control", exposed: 400, converted: 40 },
    { key: "treatment", exposed: 400, converted: 52 },
  ];

  test("a looser p-value ships what the default keeps running", () => {
    expect(run(close).verdict.state).toBe("keep_running");
    const loose = computeResults({
      computedAt: new Date(),
      control: "control",
      metrics: [{ metric: purchase, counts: close }],
      notes: [],
      thresholds: { ...DEFAULT_THRESHOLDS, shipPValue: 0.2 },
    });
    expect(loose.verdict.state).toBe("ship");
  });

  test("raising the minimum sample makes a shipped result too early", () => {
    const strict = computeResults({
      computedAt: new Date(),
      control: "control",
      metrics: [
        {
          metric: purchase,
          counts: [
            { key: "control", exposed: 1000, converted: 40 },
            { key: "treatment", exposed: 1000, converted: 80 },
          ],
        },
      ],
      notes: [],
      thresholds: { ...DEFAULT_THRESHOLDS, minExposedPerVariant: 5000 },
    });
    expect(strict.verdict.state).toBe("insufficient");
  });
});
