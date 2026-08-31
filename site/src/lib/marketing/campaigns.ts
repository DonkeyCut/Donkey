// The outreach campaigns the scan and the super-user surface know about. Ids are
// code, not data: adding one here is what makes it scannable and listable.

/** Free accounts that spent real credits and came back for more, or that are
 * holding a real amount of media in the cloud. These are the people worth a
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

/** How long after signup an account's latest activity has to fall to count as
 * a return visit. One sitting on signup day — drop a file, try a call, leave —
 * is a look, and a look is no reason to write. */
export const OUTREACH_RETURN_DAYS = 1;

/** How recently an account must have billed a model call, put media in the
 * cloud, or edited a cloud project to still count as warm. Past this it is a
 * cold list. */
export const OUTREACH_ACTIVE_WINDOW_DAYS = 30;

/** How long a contacted account rests before the scan offers it again. */
export const OUTREACH_RECONTACT_DAYS = 60;

export const OUTREACH_STATUSES = ["todo", "sent", "replied", "ignored"] as const;

export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];
