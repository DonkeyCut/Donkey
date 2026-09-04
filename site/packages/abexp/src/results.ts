import type { ExperimentMetric } from "./experiment";
import { probabilityBeats, sampleSizePerArm, twoProportionTest } from "./stats";

// An experiment's read, computed from exposure and conversion counts by the
// results job and stored on the row. The verdict answers the one question su
// asks: roll it out, stop it, or keep running — and how much longer.

// Exposures each arm needs, and conversions across the pair, before a
// positive result is believed.
export const MIN_EXPOSED_PER_VARIANT = 100;
export const MIN_CONVERSIONS = 20;
// A loss is called earlier: a variant this unlikely to beat the control, once
// a small sample is in, is stopped before it costs a full run.
export const EARLY_MIN_EXPOSED = 30;
export const EARLY_MIN_CONVERSIONS = 5;
export const SHIP_P_VALUE = 0.05;
export const STOP_PROBABILITY = 0.05;
// The lift the sample-size estimate plans for when the observed one is no
// better than that.
export const PLANNED_RELATIVE_LIFT = 0.2;

export type VariantCount = { key: string; exposed: number; converted: number };

/** The bars a verdict is called against. */
export type Thresholds = {
  minExposedPerVariant: number;
  minConversions: number;
  earlyMinExposed: number;
  earlyMinConversions: number;
  shipPValue: number;
  stopProbability: number;
  plannedRelativeLift: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  minExposedPerVariant: MIN_EXPOSED_PER_VARIANT,
  minConversions: MIN_CONVERSIONS,
  earlyMinExposed: EARLY_MIN_EXPOSED,
  earlyMinConversions: EARLY_MIN_CONVERSIONS,
  shipPValue: SHIP_P_VALUE,
  stopProbability: STOP_PROBABILITY,
  plannedRelativeLift: PLANNED_RELATIVE_LIFT,
};

export type Comparison = {
  variant: string;
  diff: number;
  relativeLift: number | null;
  pValue: number | null;
  probabilityBeatsControl: number;
};

export type MetricResult = {
  key: string;
  name: string;
  source: ExperimentMetric["source"];
  event: string | null;
  variants: (VariantCount & { rate: number })[];
  comparisons: Comparison[];
};

export type VerdictState = "insufficient" | "keep_running" | "ship" | "stop";

export type Verdict = {
  state: VerdictState;
  // The variant the verdict is about: the one to ship, or the one losing.
  variant: string | null;
  reason: string;
  // Exposures each arm needs for the primary metric, when the run is short.
  neededPerArm: number | null;
};

export type ExperimentResults = {
  computedAt: string;
  control: string;
  metrics: MetricResult[];
  verdict: Verdict;
  // What the job could not measure this time.
  notes: string[];
};

export function metricResult(metric: ExperimentMetric, control: string, counts: VariantCount[]): MetricResult {
  const base = counts.find((c) => c.key === control) ?? { key: control, exposed: 0, converted: 0 };
  return {
    key: metric.key,
    name: metric.name,
    source: metric.source,
    event: metric.event,
    variants: counts.map((c) => ({ ...c, rate: c.exposed > 0 ? c.converted / c.exposed : 0 })),
    comparisons: counts
      .filter((c) => c.key !== control)
      .map((c) => {
        const test = twoProportionTest(base.converted, base.exposed, c.converted, c.exposed);
        return {
          variant: c.key,
          diff: test.diff,
          relativeLift: test.relativeLift,
          pValue: test.pValue,
          probabilityBeatsControl: probabilityBeats(base.converted, base.exposed, c.converted, c.exposed),
        };
      }),
  };
}

const percent = (x: number) => `${(100 * x).toFixed(1)}%`;

export function verdictFor(
  primary: MetricResult | undefined,
  control: string,
  bars: Thresholds = DEFAULT_THRESHOLDS,
): Verdict {
  if (!primary) {
    return { state: "insufficient", variant: null, reason: "No metric is set.", neededPerArm: null };
  }
  const base = primary.variants.find((v) => v.key === control);
  if (!base || primary.comparisons.length === 0) {
    return { state: "insufficient", variant: null, reason: "Nothing to compare against the control.", neededPerArm: null };
  }
  const planned = Math.max(
    bars.plannedRelativeLift,
    ...primary.comparisons.map((c) => Math.abs(c.relativeLift ?? 0)),
  );
  const planSize = sampleSizePerArm(base.rate, planned);
  const neededPerArm = planSize === null ? null : Math.max(bars.minExposedPerVariant, planSize);

  const winners = primary.comparisons.filter((c) => {
    const arm = primary.variants.find((v) => v.key === c.variant)!;
    return (
      arm.exposed >= bars.minExposedPerVariant &&
      base.exposed >= bars.minExposedPerVariant &&
      arm.converted + base.converted >= bars.minConversions &&
      c.diff > 0 &&
      c.pValue !== null &&
      c.pValue < bars.shipPValue
    );
  });
  if (winners.length > 0) {
    const best = winners.reduce((a, b) => (b.diff > a.diff ? b : a));
    const arm = primary.variants.find((v) => v.key === best.variant)!;
    return {
      state: "ship",
      variant: best.variant,
      reason: `${best.variant} converts at ${percent(arm.rate)} against ${percent(base.rate)} on ${primary.name} (p = ${best.pValue!.toFixed(3)}).`,
      neededPerArm,
    };
  }

  const losers = primary.comparisons.filter((c) => {
    const arm = primary.variants.find((v) => v.key === c.variant)!;
    return (
      arm.exposed >= bars.earlyMinExposed &&
      base.exposed >= bars.earlyMinExposed &&
      arm.converted + base.converted >= bars.earlyMinConversions &&
      c.probabilityBeatsControl < bars.stopProbability
    );
  });
  if (losers.length === primary.comparisons.length) {
    const worst = losers.reduce((a, b) => (b.probabilityBeatsControl < a.probabilityBeatsControl ? b : a));
    const arm = primary.variants.find((v) => v.key === worst.variant)!;
    return {
      state: "stop",
      variant: worst.variant,
      reason: `${worst.variant} converts at ${percent(arm.rate)} against ${percent(base.rate)} on ${primary.name}; a ${percent(worst.probabilityBeatsControl)} chance it is better.`,
      neededPerArm,
    };
  }

  const short = primary.variants.filter((v) => v.exposed < bars.minExposedPerVariant);
  const conversions = primary.variants.reduce((sum, v) => sum + v.converted, 0);
  if (short.length > 0 || conversions < bars.minConversions) {
    const smallest = Math.min(...primary.variants.map((v) => v.exposed));
    return {
      state: "insufficient",
      variant: null,
      reason: `Too early to read: ${smallest} exposed in the smallest arm and ${conversions} conversions on ${primary.name}.`,
      neededPerArm,
    };
  }
  const lead = primary.comparisons.reduce((a, b) => (b.probabilityBeatsControl > a.probabilityBeatsControl ? b : a));
  return {
    state: "keep_running",
    variant: lead.variant,
    reason: `No clear result yet: ${lead.variant} has a ${percent(lead.probabilityBeatsControl)} chance of beating the control on ${primary.name}.`,
    neededPerArm,
  };
}

export function computeResults(input: {
  computedAt: Date;
  control: string;
  metrics: { metric: ExperimentMetric; counts: VariantCount[] }[];
  notes: string[];
  thresholds?: Thresholds;
}): ExperimentResults {
  const metrics = input.metrics.map((m) => metricResult(m.metric, input.control, m.counts));
  return {
    computedAt: input.computedAt.toISOString(),
    control: input.control,
    metrics,
    verdict: verdictFor(metrics[0], input.control, input.thresholds ?? DEFAULT_THRESHOLDS),
    notes: input.notes,
  };
}
