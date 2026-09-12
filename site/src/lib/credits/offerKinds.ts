import type { OfferClaim } from "@/lib/credits/offerTerms";

// The kinds of credit offer, and what lands each. A leaf module, so the
// modules that make and claim offers can share the names without a cycle.

// The kind su makes by hand, claimed from its email link.
export const MANUAL_OFFER_KIND = "manual";
// The kinds an email with offer terms makes, one per claim: the link in the
// email, or a Pro subscription started inside the window. An id is the
// email's scope and the account.
export const PROMOTION_OFFER_KIND = "promotion_email";
export const PROMOTION_SUBSCRIBE_OFFER_KIND = "promotion_subscribe";
export const PROMOTION_OFFER_KINDS = [PROMOTION_OFFER_KIND, PROMOTION_SUBSCRIBE_OFFER_KIND] as const;
// The subscribe bonus the app opens on its own; landed by subscribing.
export const SUBSCRIBE_BONUS_KIND = "subscribe_bonus";

export function promotionOfferKind(claim: OfferClaim): string {
  return claim === "subscribe" ? PROMOTION_SUBSCRIBE_OFFER_KIND : PROMOTION_OFFER_KIND;
}

// The kinds a claim link lands: the ones su sends by hand and the ones a
// promotion mails with a link. Every other kind lands from the act it rewards.
export const LINK_CLAIMED_KINDS = [MANUAL_OFFER_KIND, PROMOTION_OFFER_KIND] as const;

export function isLinkClaimedKind(kind: string): boolean {
  return (LINK_CLAIMED_KINDS as readonly string[]).includes(kind);
}

// The kinds a subscription lands.
export const SUBSCRIBE_CLAIMED_KINDS = [SUBSCRIBE_BONUS_KIND, PROMOTION_SUBSCRIBE_OFFER_KIND] as const;

export function isSubscribeClaimedKind(kind: string): boolean {
  return (SUBSCRIBE_CLAIMED_KINDS as readonly string[]).includes(kind);
}
