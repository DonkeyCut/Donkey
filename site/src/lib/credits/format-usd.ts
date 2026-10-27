import type { Locale } from "@/i18n/locales";

// Money in a sentence: whole dollars carry no cents ("$25"), anything else
// its two ("$2.57"), written the reader's way ("25 $" in German).
export function formatUsdPlain(value: string, locale: Locale): string {
  const parsed = Number.parseFloat(value);
  const amount = Number.isFinite(parsed) ? parsed : 0;
  const whole = Number.isInteger(amount);
  return amount.toLocaleString(locale, {
    currency: "USD",
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
    style: "currency",
  });
}
