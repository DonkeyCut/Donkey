import type { Locale } from "@/i18n/locales";

// One formatter per locale and precision, built on first use.
const NUMBERS = new Map<string, Intl.NumberFormat>();

function decimals(value: number, digits: number, locale: Locale): string {
  const key = `${locale}:${digits}`;
  let format = NUMBERS.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits });
    NUMBERS.set(key, format);
  }
  return format.format(value);
}

/** A byte count in the units a person reads at a glance: KB under a megabyte,
 * MB up to a gigabyte, GB above it. One implementation, so the cloud shelf, the
 * Outreach list, and an outreach email all say the same number. The number is
 * the reader's ("1,5 GB" in German); the units stay. */
export function formatBytes(n: number, locale: Locale): string {
  if (n <= 0) return `${decimals(0, 0, locale)} MB`;
  const mb = n / (1024 * 1024);
  if (mb < 1) return `${decimals(Math.max(1, Math.round(n / 1024)), 0, locale)} KB`;
  if (mb >= 1024) {
    return `${decimals(mb / 1024, 1, locale)} GB`;
  }
  return `${mb < 10 ? decimals(mb, 1, locale) : decimals(Math.round(mb), 0, locale)} MB`;
}
