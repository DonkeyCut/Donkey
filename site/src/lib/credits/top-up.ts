// Client-safe credit top-up constants and pure helpers (no server-only imports),
// shared by the purchase logic, the auto-reload validation, and the settings UI
// so the presets and bounds can never drift between the buttons and the server
// checks. Keep this file free of prisma / Stripe imports.

// Presets drive the quick-buy buttons; the custom field accepts any whole-dollar
// amount in [min, max]. Amounts are whole dollars so they map cleanly to Stripe
// unit_amount cents and the grant ledger.
export const creditTopUpPresetsDollars = [5, 25, 50, 100] as const;
export const creditTopUpMinDollars = 5;
export const creditTopUpMaxDollars = 2_000;

// The default pay-as-you-go amount: the value we pre-fill / fall back to when no
// other amount is chosen (auto-reload default, the "buy once to save a card"
// nudge, and the super user grant default all key off this so they stay in sync).
export const creditTopUpDefaultDollars = 25;

// Stripe metadata "kind" tags that route a completed payment to a credit grant.
export const creditTopUpKind = "credit_topup";
export const creditAutoReloadKind = "credit_topup_autoreload";

// Ceiling on a single super-user credit grant (whole dollars), enforced both by
// the grant API's schema and the settings form so the two never drift. Kept low
// as a typo guard — grants above this are rejected.
export const maxCreditGrantDollars = 100;

export function dollarsToStripeCents(amountDollars: number): number {
  return Math.round(amountDollars * 100);
}

// How long a grant lives. The su grant form offers these picks beside a custom
// day count; the grant API and the signup-credits setting cap the count at the
// same ceiling. null stands for a grant that never expires.
export const creditGrantExpiryPresets = [
  { label: "1 day", days: 1 },
  { label: "1 week", days: 7 },
  { label: "1 month", days: 30 },
  { label: "1 year", days: 365 },
] as const;
export const maxCreditGrantExpiryDays = 3650;

/** The moment a grant made now stops being spendable, or undefined for never. */
export function creditGrantExpiry(expiresAfterDays: number | null, now = new Date()): Date | undefined {
  if (expiresAfterDays === null) return undefined;
  return new Date(now.getTime() + expiresAfterDays * 24 * 60 * 60 * 1000);
}

/** The expiry as people read it: "September 14, 2026". */
export function formatCreditExpiry(expiresAt: Date): string {
  return expiresAt.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}
