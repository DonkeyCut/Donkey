// The intro offer, as the introOffer setting states it: a percent off the
// first months of Pro for an account that subscribes within a window after
// signup and has never held Pro. Pure, so the checkout, the offer read and
// the tests share one rule.

export type IntroOfferSetting = {
  percentOff: number;
  months: number;
  windowHours: number;
};

export type IntroOffer = {
  percentOff: number;
  months: number;
  endsAt: Date;
};

const HOUR_MS = 3_600_000;

// Subscription rows a checkout leaves behind when payment never went
// through; they never held Pro.
const NEVER_PAID_STATUSES = new Set(["incomplete", "incomplete_expired"]);

/** Whether a stored subscription status means the account once held Pro. */
export function heldPro(status: string | null): boolean {
  return status !== null && !NEVER_PAID_STATUSES.has(status);
}

/** The offer open to an account right now, or null. */
export function introOfferAt(
  setting: IntroOfferSetting,
  facts: { createdAt: Date; heldPro: boolean },
  now: Date,
): IntroOffer | null {
  if (setting.percentOff <= 0 || facts.heldPro) {
    return null;
  }

  const endsAt = new Date(facts.createdAt.getTime() + setting.windowHours * HOUR_MS);
  if (now.getTime() >= endsAt.getTime()) {
    return null;
  }
  return { percentOff: setting.percentOff, months: setting.months, endsAt };
}

/** The Stripe coupon id for an offer's terms. One coupon per pair of terms,
 * so changing the setting needs no step in the Stripe dashboard. */
export function introCouponId(offer: Pick<IntroOffer, "percentOff" | "months">): string {
  return `donkey-intro-${offer.percentOff}-${offer.months}m`;
}

/** The discounted price, in cents, rounded the way Stripe rounds it. */
export function introPriceCents(priceCents: number, percentOff: number): number {
  return Math.round((priceCents * (100 - percentOff)) / 100);
}
