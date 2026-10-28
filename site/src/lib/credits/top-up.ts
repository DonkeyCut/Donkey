// Client-safe credit constants and pure helpers (no server-only imports),
// shared by the server and the settings UI. Keep this file free of prisma /
// Stripe imports.

import type { Locale } from "@/i18n/locales";

// Stripe metadata "kind" tags the retired credit purchases charged under; a
// payment that settles late is routed to its grant by them.
export const creditTopUpKind = "credit_topup";
export const creditAutoReloadKind = "credit_topup_autoreload";

// Ceiling on a single credit grant a setting names (whole dollars), enforced
// by the registry's schema. Kept low as a typo guard — grants above this are
// rejected.
export const maxCreditGrantDollars = 100;

// How long a grant lives, capped at the same ceiling everywhere. null stands
// for a grant that never expires.
export const maxCreditGrantExpiryDays = 3650;

/** The moment a grant made now stops being spendable, or undefined for never. */
export function creditGrantExpiry(expiresAfterDays: number | null, now = new Date()): Date | undefined {
  if (expiresAfterDays === null) return undefined;
  return new Date(now.getTime() + expiresAfterDays * 24 * 60 * 60 * 1000);
}

/** The expiry as people read it: "September 14, 2026". */
export function formatCreditExpiry(expiresAt: Date, locale: Locale): string {
  return expiresAt.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}
