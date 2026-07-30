// What the welcome sequence is made of: the sources a new account can pick
// from when we ask where they found us, and the version of the sequence
// itself. The slides render this list and the account route accepts only these
// ids, so the question and the stored answers can't drift apart.

/** A run of the sequence: the first one an account gets, or a replay it asked
 * for from settings. Slides that congratulate read differently on a replay. */
export type OnboardingRun = "first_run" | "replay";

export const REFERRAL_SOURCES = [
  { id: "discord", label: "Discord" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube" },
  { id: "search", label: "Search" },
  { id: "friend", label: "A friend" },
  { id: "other", label: "Other" },
] as const;

export type ReferralSource = (typeof REFERRAL_SOURCES)[number]["id"];

/** Picking "other" opens a free-text field; the slide and the route cap it to
 * the same length. */
export const REFERRAL_OTHER_MAX_LENGTH = 120;

export const isKnownReferralSource = (id: string): id is ReferralSource =>
  REFERRAL_SOURCES.some((s) => s.id === id);

// The sequence an account is measured against. Raise it when the slides change
// enough that people who finished the old one should see the new one.
export const ONBOARDING_VERSION = 1;

/** USD the signup hook grants a new account. Lives here, free of server
 * imports, because the sequence's credits slide names the same number the
 * grant uses (src/lib/onboarding/signup-grants.ts).
 *
 * Sized against the priciest first thing an account can do: a generated video
 * clip bills a little over a dollar, so this covers a couple of them and the
 * chat around them. A grant that can't buy one leaves every new account
 * bouncing off an empty balance on its first real try. */
export const signupAppCredits = "3";
