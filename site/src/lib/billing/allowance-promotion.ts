// The Pro allowance promotion, as the proAllowancePromotion setting states it:
// a multiplier on the allowance a billing period starts with, on for every
// period that starts on or before a last UTC day. Pure, so the grant, the Pro
// card and the tests read one rule.

export type AllowancePromotion = {
  multiplier: number;
  // YYYY-MM-DD, or null for no end.
  lastDay: string | null;
};

const DAY_MS = 86_400_000;

/** Whether a period starting at `at` gets the multiplier. */
export function promotionCovers(promotion: AllowancePromotion, at: Date): boolean {
  if (promotion.multiplier <= 1) return false;
  if (promotion.lastDay === null) return true;
  const closes = Date.parse(`${promotion.lastDay}T00:00:00Z`) + DAY_MS;
  return Number.isFinite(closes) && at.getTime() < closes;
}

/** The allowance a period starting at `periodStart` is granted. */
export function promotedAllowanceMicros(
  baseMicros: bigint,
  promotion: AllowancePromotion,
  periodStart: Date,
): bigint {
  return promotionCovers(promotion, periodStart) ? baseMicros * BigInt(promotion.multiplier) : baseMicros;
}
