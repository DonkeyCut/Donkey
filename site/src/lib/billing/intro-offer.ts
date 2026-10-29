// The intro offer, as the introOffer setting states it: a percent off the
// first months of Pro for an account that has never held a plan, open for a
// window that starts the first time the account sees it. Pure, so the
// checkout, the offer read and the tests share one rule.

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

/** Whether the account is one the offer is for, seen or not. */
export function offersIntro(setting: IntroOfferSetting, facts: { heldPro: boolean }): boolean {
  return setting.percentOff > 0 && !facts.heldPro;
}

/** The offer open to an account right now, or null. An account that has not
 * seen the offer yet has none open; its window starts at `seenAt`. */
export function introOfferAt(
  setting: IntroOfferSetting,
  facts: { seenAt: Date | null; heldPro: boolean },
  now: Date,
): IntroOffer | null {
  if (!offersIntro(setting, facts) || !facts.seenAt) {
    return null;
  }

  const endsAt = new Date(facts.seenAt.getTime() + setting.windowHours * HOUR_MS);
  if (now.getTime() >= endsAt.getTime()) {
    return null;
  }
  return { percentOff: setting.percentOff, months: setting.months, endsAt };
}

/** The offer as a surface may show it before it is opened: the open window
 * when the account has seen it, or a window not yet started (endsAt null),
 * which runs `windowHours` from the moment a surface first shows it. Null
 * when no offer is or will be open. */
export function introOfferPreview(
  setting: IntroOfferSetting,
  facts: { seenAt: Date | null; heldPro: boolean },
  now: Date,
): (Omit<IntroOffer, "endsAt"> & { endsAt: Date | null; windowHours: number }) | null {
  if (!offersIntro(setting, facts)) {
    return null;
  }
  const terms = { percentOff: setting.percentOff, months: setting.months, windowHours: setting.windowHours };
  if (!facts.seenAt) {
    return { ...terms, endsAt: null };
  }
  const open = introOfferAt(setting, facts, now);
  return open ? { ...terms, endsAt: open.endsAt } : null;
}

/** The Stripe coupon id for an offer's terms. One coupon per pair of terms,
 * so changing the setting needs no step in the Stripe dashboard. */
export function introCouponId(offer: Pick<IntroOffer, "percentOff" | "months">): string {
  return `donkey-intro-${offer.percentOff}-${offer.months}m`;
}

/** The discounted price in the currency's minor unit, rounded the way
 * Stripe rounds it: 2000 cents → 1000, ¥2,800 → ¥1,400. */
export function introPriceMinor(priceMinor: number, percentOff: number): number {
  return Math.round((priceMinor * (100 - percentOff)) / 100);
}
