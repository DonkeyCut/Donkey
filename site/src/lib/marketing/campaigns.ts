// The outreach campaigns the scan and the super-user surface know about. Ids are
// code, not data: adding one here is what makes it scannable and listable.

/** Free accounts that spent real credits recently, or that are holding a real
 * amount of media in the cloud. These are the people worth a
 * personal note. The id is the value written on every row
 * since the campaign began and stays as it is. */
export const CREDIT_SPENDERS_CAMPAIGN = "credit_spenders";

/** The least an account has to have spent, in credits, to make the list. A
 * third of the signup grant means several real model calls; a few cents is
 * one trial call. */
export const OUTREACH_MIN_SPENT_CREDITS = "1";

/** The least an account has to be holding in the cloud to make the list on
 * storage alone. Most of the free quota in use is a person keeping their work
 * here. */
export const OUTREACH_MIN_STORAGE_BYTES = BigInt(200 * 1024 * 1024);

/** How recently an account must have billed a model call, put media in the
 * cloud, or edited a cloud project to still count as warm. Past this it is a
 * cold list. */
export const OUTREACH_ACTIVE_WINDOW_DAYS = 30;

/** How long a contacted account rests before the scan offers it again. */
export const OUTREACH_RECONTACT_DAYS = 60;

/** How far back a declined charge or an ended subscription still counts as
 * a reason to reach out. */
export const OUTREACH_PAYMENT_WINDOW_DAYS = 60;

/** The share of the storage quota at which an account counts as full. */
export const OUTREACH_STORAGE_FULL_SHARE = 0.9;

/** Why an account is on the list. The first two are people using the product
 * well; the rest are walls they hit — the moment a note can turn into a
 * top-up, an upgrade, or a saved subscription. An account can carry several. */
export const OUTREACH_REASONS = [
  "spent",
  "storage",
  "no_credits",
  "storage_full",
  "payment_failed",
  "past_due",
  "canceling",
  "canceled",
] as const;

export type OutreachReason = (typeof OUTREACH_REASONS)[number];

export const OUTREACH_REASON_LABELS: Record<OutreachReason, string> = {
  canceled: "Canceled Pro",
  canceling: "Canceling Pro",
  no_credits: "Out of credits",
  past_due: "Payment past due",
  payment_failed: "Payment declined",
  spent: "Spending credits",
  storage: "Holding media",
  storage_full: "Storage full",
};

/** The reasons that are a wall the person ran into, shown in the warning tone. */
export const OUTREACH_WALL_REASONS: readonly OutreachReason[] = [
  "no_credits",
  "storage_full",
  "payment_failed",
  "past_due",
  "canceling",
  "canceled",
];

export const OUTREACH_STATUSES = ["todo", "sent", "replied", "ignored"] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
