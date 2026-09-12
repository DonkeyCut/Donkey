import { z } from "zod";

// The terms of a credit offer an email carries, as su writes them: how much,
// what lands it, how long the person has to take it up, and how long the
// credit lives once it lands. A promotion to a segment and an outreach note
// to one person share these terms, the placeholders that name the offer in
// the words, and the form that edits them. Client-safe: zod only.

// What lands the credit: the claim link in the email, or a Pro subscription
// started inside the claim window.
export const OFFER_CLAIMS = ["link", "subscribe"] as const;
export type OfferClaim = (typeof OFFER_CLAIMS)[number];

export const OFFER_CLAIM_NAMES: Record<OfferClaim, string> = {
  link: "The claim link",
  subscribe: "Subscribing to Pro",
};

// The button label an email starts with for each claim.
export const OFFER_BUTTON_LABELS: Record<OfferClaim, string> = {
  link: "Claim my AI credits",
  subscribe: "Subscribe to Pro",
};

export const creditOfferTermsSchema = z
  .object({
    dollars: z.number().int().min(1).max(10000),
    claimWindowDays: z.number().int().min(1).max(365),
    expiresAfterDays: z.number().int().min(1).max(3650),
    claim: z.enum(OFFER_CLAIMS).default("link"),
  })
  .strict();

export type CreditOfferTerms = z.infer<typeof creditOfferTermsSchema>;

// The terms as a draft holds them: the same fields, with a number still to be
// typed allowed at 0. A send parses the strict terms.
export const creditOfferDraftSchema = z
  .object({
    dollars: z.number().int().min(0).max(10000),
    claimWindowDays: z.number().int().min(0).max(365),
    expiresAfterDays: z.number().int().min(0).max(3650),
    claim: z.enum(OFFER_CLAIMS).default("link"),
  })
  .strict();

/** Stored terms, or null for none. Throws on a row that no longer parses. */
export function creditOfferTermsOf(value: unknown): CreditOfferTerms | null {
  return value == null ? null : creditOfferTermsSchema.parse(value);
}

/** Stored draft terms, or null for none: what a saved draft reads back as. */
export function creditOfferDraftOf(value: unknown): CreditOfferTerms | null {
  return value == null ? null : creditOfferDraftSchema.parse(value);
}

/** Stored terms when they parse, else null: what a form loads from a template. */
export function creditOfferTermsIfValid(value: unknown): CreditOfferTerms | null {
  if (value == null) return null;
  const parsed = creditOfferTermsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What the words of an email with an offer may name: the recipient's own
 * claim link, and their last day to claim as people read it. */
export type OfferVars = { claimUrl: string; claimBy: string };

export const OFFER_PLACEHOLDERS = ["claimUrl", "claimBy"] as const satisfies readonly (keyof OfferVars)[];

export const CLAIM_URL_PLACEHOLDER = "{{claimUrl}}";
