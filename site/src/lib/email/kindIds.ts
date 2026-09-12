// The kinds of email the site sends, and where each stands in the queue. The
// server side of a kind (what it builds, whose quota it spends) is in
// src/lib/email/kinds.ts; this file is client-safe so the settings registry
// can offer the priorities to su.
export const EMAIL_KIND_IDS = [
  "reply-forward",
  "credit-offer",
  "outreach",
  "promotion-hand",
  "promotion-test",
  "welcome",
  "credit-expiry",
  "promotion",
] as const;

export type EmailKindId = (typeof EMAIL_KIND_IDS)[number];

// Higher goes first. A reply from a user beats everything; a campaign yields
// to every email a single account is waiting on, and a promotion sent by hand
// to one person goes with the other mail sent by hand.
export const DEFAULT_EMAIL_PRIORITIES: Record<EmailKindId, number> = {
  "reply-forward": 100,
  "credit-offer": 90,
  outreach: 80,
  "promotion-hand": 75,
  "promotion-test": 70,
  welcome: 60,
  "credit-expiry": 50,
  promotion: 10,
};
