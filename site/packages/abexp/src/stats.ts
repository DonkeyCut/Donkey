// The arithmetic behind an experiment's read: a two-proportion test for the
// classical p-value, a Beta-Binomial posterior for the chance a variant beats
// the control, and the sample a run needs. Pure, no dependencies.

/** Standard normal CDF, Abramowitz & Stegun 7.1.26 (error under 2e-7). */
export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Lanczos approximation of ln Γ(x) for x > 0. */
export function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const logBeta = (a: number, b: number) => logGamma(a) + logGamma(b) - logGamma(a + b);

export type ProportionTest = {
  rateA: number;
  rateB: number;
  // B's rate minus A's, and the same as a share of A's rate.
  diff: number;
  relativeLift: number | null;
  // Two-sided; null when neither arm has a spread to test against.
  pValue: number | null;
};

/** Classical two-sided test of B's rate against A's, pooled standard error. */
export function twoProportionTest(
  convertedA: number,
  exposedA: number,
  convertedB: number,
  exposedB: number,
): ProportionTest {
  const rateA = exposedA > 0 ? convertedA / exposedA : 0;
  const rateB = exposedB > 0 ? convertedB / exposedB : 0;
  const diff = rateB - rateA;
  const relativeLift = rateA > 0 ? diff / rateA : null;
  if (exposedA === 0 || exposedB === 0) return { rateA, rateB, diff, relativeLift, pValue: null };
  const pooled = (convertedA + convertedB) / (exposedA + exposedB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / exposedA + 1 / exposedB));
  if (se === 0) return { rateA, rateB, diff, relativeLift, pValue: null };
  const z = diff / se;
  return { rateA, rateB, diff, relativeLift, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

/** P(rate B > rate A) under Beta(1, 1) priors on each arm; exact, via the
 * closed-form sum over B's successes. */
export function probabilityBeats(
  convertedA: number,
  exposedA: number,
  convertedB: number,
  exposedB: number,
): number {
  const alphaA = 1 + convertedA;
  const betaA = 1 + exposedA - convertedA;
  const alphaB = 1 + convertedB;
  const betaB = 1 + exposedB - convertedB;
  let total = 0;
  const base = logBeta(alphaA, betaA);
  for (let i = 0; i < alphaB; i++) {
    total += Math.exp(logBeta(alphaA + i, betaA + betaB) - Math.log(betaB + i) - logBeta(1 + i, betaB) - base);
  }
  return Math.min(1, Math.max(0, total));
}

// Two-sided α = 0.05 and power 0.8, the usual bar.
const Z_ALPHA = 1.959964;
const Z_BETA = 0.841621;

/** Exposures each arm needs to detect a relative lift over the control rate.
 * Null when the control rate leaves nothing to detect. */
export function sampleSizePerArm(controlRate: number, relativeLift: number): number | null {
  const p1 = controlRate;
  const p2 = p1 * (1 + relativeLift);
  if (p1 <= 0 || p2 >= 1 || p2 === p1) return null;
  const pBar = (p1 + p2) / 2;
  const numerator =
    Z_ALPHA * Math.sqrt(2 * pBar * (1 - pBar)) + Z_BETA * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / ((p2 - p1) * (p2 - p1)));
}
