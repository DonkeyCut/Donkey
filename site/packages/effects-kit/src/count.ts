/**
 * The count entrance: every number written in a title counts from zero up to
 * its written value while the entrance plays, and back down on an exit.
 *
 * A number keeps the form it was written in at every step — "12.5" counts in
 * tenths, "007" stays three digits wide, "1,000" keeps its separators — so
 * the line reads the same at the end of the count as it does at rest. Text
 * with no number in it shows unchanged.
 */

/** A run of digits, with thousands separators or a decimal part. */
const NUMBER = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

/** Float slack when a count lands on a whole step ("0.57 × 100" is 56.999…). */
const STEP_EPSILON = 1e-7;

/** One written number: its value in its smallest written step, and the form
 * it is drawn back in. */
interface Written {
  units: number;
  decimals: number;
  width: number;
  grouped: boolean;
}

/** Read a matched number. "12.5" is 125 tenths; "007" is 7, three wide. */
function readNumber(match: string): Written {
  const [whole, frac = ""] = match.split(".");
  const digits = whole.replace(/,/g, "");
  return {
    units: Number(digits + frac),
    decimals: frac.length,
    width: digits.startsWith("0") ? digits.length : 1,
    grouped: whole.includes(","),
  };
}

/** How many steps of `w` show at `p` (0..1): the final value only at 1. */
function shownUnits(w: Written, p: number): number {
  if (p >= 1) {
    return w.units;
  }
  if (p <= 0) {
    return 0;
  }
  return Math.floor(w.units * p + STEP_EPSILON);
}

/** `units` steps drawn in the form `w` was written in. */
function formatUnits(units: number, w: Written): string {
  // Split off the decimals, e.g. 125 tenths → "12" + "5", 5 tenths → "0" + "5".
  const s = String(units).padStart(w.decimals + 1, "0");
  const whole = w.decimals > 0 ? s.slice(0, -w.decimals) : s;
  const frac = w.decimals > 0 ? `.${s.slice(-w.decimals)}` : "";

  // Leading zeros and separators as written.
  const padded = whole.padStart(w.width, "0");
  const grouped = w.grouped ? padded.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : padded;
  return grouped + frac;
}

/** `text` with every number counted to `p` (0..1) of its written value:
 * "100 %" at 0.5 is "50 %". */
export function countText(text: string, p: number): string {
  return text.replace(NUMBER, (m) => {
    const w = readNumber(m);
    return formatUnits(shownUnits(w, p), w);
  });
}

/** How far the count in `text` stands at `p`, as one whole number that grows
 * with every step any number takes. Caches key a counted picture by it: two
 * moments with the same step show the same text. */
export function countStep(text: string, p: number): number {
  let step = 0;
  for (const m of text.match(NUMBER) ?? []) {
    step += shownUnits(readNumber(m), p);
  }
  return step;
}
