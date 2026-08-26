// The outreach campaigns the scan and the super-user surface know about. Ids are
// code, not data: adding one here is what makes it scannable and listable.

/** Free accounts that have spent credits — the people worth a personal note. */
export const CREDIT_SPENDERS_CAMPAIGN = "credit_spenders";

/** How recently an account must have billed a model call to still count as
 * warm. Past this it is a cold list, not outreach. */
export const OUTREACH_ACTIVE_WINDOW_DAYS = 30;

/** How long a contacted account rests before the scan offers it again. */
export const OUTREACH_RECONTACT_DAYS = 60;

export const OUTREACH_STATUSES = ["todo", "sent", "replied", "ignored"] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
