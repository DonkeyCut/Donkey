import type { Locale } from "@/i18n/locales";
import { creditStringToMicros, zeroCreditMicros } from "@/lib/credits/amounts";

// Balances and prices live in USD micros; people read them as credits, at a
// fixed 1,000 credits per dollar (1 credit = 1,000 micros = $0.001). The rate
// is a unit definition: changing it reprices every number already shown.
export const creditsPerDollar = 1000;
const creditMicrosPerDisplayCredit = BigInt(1000);

// Which way a fraction of a credit goes. A balance rounds down so it never
// claims more than the account has; a charge rounds up so a cheap call still
// reads as one credit.
export type CreditRounding = "down" | "up";

// The credit unit in each language, by plural category: "1 credit",
// "500 credits". A count is a number with this unit, so the helpers below stay
// synchronous and serve the page, the route handlers and the engine alike.
const CREDIT_UNIT: Record<Locale, Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }> = {
  en: { one: "# credit", other: "# credits" },
  es: { one: "# crédito", other: "# créditos" },
  "pt-BR": { one: "# crédito", other: "# créditos" },
  fr: { one: "# crédit", other: "# crédits" },
  de: { one: "# Credit", other: "# Credits" },
  ja: { other: "#クレジット" },
  ko: { other: "#크레딧" },
  "zh-CN": { other: "#积分" },
};

// One formatter per locale, built on first use: eight at most.
const COUNTS = new Map<Locale, Intl.NumberFormat>();
const PLURALS = new Map<Locale, Intl.PluralRules>();
const TENTHS = new Map<Locale, Intl.NumberFormat>();

function cached<T>(map: Map<Locale, T>, locale: Locale, make: () => T): T {
  const hit = map.get(locale);
  if (hit) {
    return hit;
  }
  const made = make();
  map.set(locale, made);
  return made;
}

/** Whole credits in a dollar amount: "0.4999" down → 499, "0.0001" up → 1. */
export function creditsFromDollars(dollars: string | number, rounding: CreditRounding): number {
  const micros = creditStringToMicros(typeof dollars === "number" ? dollars.toFixed(6) : dollars);
  const whole = micros / creditMicrosPerDisplayCredit;
  const rest = micros % creditMicrosPerDisplayCredit;

  // BigInt division truncates toward zero; step one credit outward when a
  // remainder points the other way from the rounding.
  if (rest === zeroCreditMicros) {
    return Number(whole);
  }
  if (rounding === "down" && micros < zeroCreditMicros) {
    return Number(whole) - 1;
  }
  if (rounding === "up" && micros > zeroCreditMicros) {
    return Number(whole) + 1;
  }
  return Number(whole);
}

/** Dollars a whole number of credits costs: 5,000 → 5. */
export function dollarsForCredits(credits: number): number {
  return credits / creditsPerDollar;
}

/** A bare credit count: "12,480" in English, "12.480" in German. */
export function formatCreditCount(credits: number, locale: Locale): string {
  return cached(COUNTS, locale, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })).format(credits);
}

/** A credit count with its unit: "1 credit", "12,480 credits". */
export function creditCountLabel(credits: number, locale: Locale): string {
  const category = cached(PLURALS, locale, () => new Intl.PluralRules(locale)).select(credits);
  const unit = CREDIT_UNIT[locale];
  return (unit[category] ?? unit.other).replace("#", formatCreditCount(credits, locale));
}

/** A balance in a sentence: "500 credits". null/undefined → an em dash. */
export function formatCredits(dollars: string | number | null | undefined, locale: Locale): string {
  if (dollars === null || dollars === undefined) {
    return "—";
  }
  return creditCountLabel(creditsFromDollars(dollars, "down"), locale);
}

/** What a call cost: rounds up, so any non-zero charge reads as at least 1. */
export function formatCreditCharge(dollars: string | number, locale: Locale): string {
  return creditCountLabel(creditsFromDollars(dollars, "up"), locale);
}

/** The top bar's reading: "500", "12.4k", "1.2M", rounded down at each step. */
export function compactCredits(dollars: string | number, locale: Locale): string {
  const credits = creditsFromDollars(dollars, "down");
  const size = Math.abs(credits);

  // Below ten thousand every credit shows; past it one decimal of the
  // thousand or million is enough to plan a session around.
  if (size < 10_000) {
    return formatCreditCount(credits, locale);
  }
  const [divisor, suffix] = size < 1_000_000 ? [1_000, "k"] : [1_000_000, "M"];
  const tenths = Math.trunc((credits / divisor) * 10) / 10;
  const tenthsFormat = cached(TENTHS, locale, () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }));
  return `${tenthsFormat.format(tenths)}${suffix}`;
}
