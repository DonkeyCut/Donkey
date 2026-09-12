import { OFFER_PLACEHOLDERS, type OfferVars } from "@/lib/credits/offerTerms";

// What a subject or body may name, and where each value comes from. Saved
// templates and hand-typed notes go through the same fill, so a placeholder
// means the same thing either way.

/** Whether a placeholder names the offer, so a note without one can say so. */
export function isOfferPlaceholder(name: string): boolean {
  return (OFFER_PLACEHOLDERS as readonly string[]).includes(name);
}

/** The values a placeholder resolves to, for one recipient. */
export type OutreachVars = {
  /** First word of the account name. */
  firstName: string;
  /** The account name as Google gave it. */
  name: string;
  email: string;
  /** USD spent on model work so far, as a plain number string. */
  spent: string;
  /** USD left on the account. */
  balance: string;
  /** Cloud media the account is holding, already in reading units ("120 MB"). */
  storage: string;
} & Partial<OfferVars>;

export const OUTREACH_PLACEHOLDERS = [
  "firstName",
  "name",
  "email",
  "spent",
  "balance",
  "storage",
  ...OFFER_PLACEHOLDERS,
] as const satisfies readonly (keyof OutreachVars)[];

/** What a promotion may name: the account itself, nothing that costs a query
 * per recipient, and the offer when it carries one. */
export type PromotionVars = {
  firstName: string;
  name: string;
  email: string;
} & Partial<OfferVars>;

export const PROMOTION_PLACEHOLDERS = [
  "firstName",
  "name",
  "email",
  ...OFFER_PLACEHOLDERS,
] as const satisfies readonly (keyof PromotionVars)[];

const PLACEHOLDER = /\{\{\s*([a-zA-Z]+)\s*\}\}/g;

export class UnknownPlaceholderError extends Error {
  public constructor(public readonly placeholder: string) {
    super(`Unknown placeholder {{${placeholder}}}.`);
    this.name = "UnknownPlaceholderError";
  }
}

/** First word of an account name, the way a note addresses someone. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function fill(text: string, vars: Record<string, unknown>, allowed: readonly string[]): string {
  return text.replace(PLACEHOLDER, (_match, key: string) => {
    if (!allowed.includes(key)) {
      throw new UnknownPlaceholderError(key);
    }
    const value = vars[key];
    if (typeof value !== "string") {
      throw new UnknownPlaceholderError(key);
    }
    return value;
  });
}

/** Fills a subject or body for one recipient. An unknown placeholder throws
 * rather than mailing the braces out, so a typo is caught before the send. */
export function fillOutreachText(text: string, vars: OutreachVars): string {
  return fill(text, vars, OUTREACH_PLACEHOLDERS);
}

/** The promotion fill: the same rule over the smaller set. */
export function fillPromotionText(text: string, vars: PromotionVars): string {
  return fill(text, vars, PROMOTION_PLACEHOLDERS);
}
