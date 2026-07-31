import {
  getResend,
  isResendConfigured,
  registeredUsersSegmentId,
  type EmailUser,
} from "@/lib/email/resend";

// Projects an account into Resend: a global contact, added to the segment
// broadcasts target. Postgres stays the source of truth — this copy exists so
// announcements can be sent as Resend Broadcasts, which handle per-recipient
// unsubscribe links and suppression on their own. Idempotent: an existing
// contact is left as-is and re-adding to a segment is a no-op, so signup
// retries and the backfill script can both re-run it.
export async function syncResendContact(
  user: EmailUser,
  { unsubscribed = false }: { unsubscribed?: boolean } = {},
): Promise<void> {
  if (!isResendConfigured()) {
    console.log("[email] RESEND_API_KEY not set; skipping contact sync", {
      userId: user.id,
    });
    return;
  }

  const resend = getResend();
  const [firstName, ...rest] = user.name.trim().split(/\s+/);
  const created = await resend.contacts.create({
    email: user.email,
    firstName: firstName || undefined,
    lastName: rest.join(" ") || undefined,
    unsubscribed,
  });
  // An already-existing contact fails creation but must still reach the
  // segment; a real failure (bad key, outage) repeats on the segment call
  // below and throws there.
  if (created.error) {
    console.log("[email] contact create skipped", {
      error: created.error.name,
      userId: user.id,
    });
  }

  const segmentId = registeredUsersSegmentId();
  if (!segmentId) {
    console.warn(
      "[email] RESEND_REGISTERED_USERS_SEGMENT_ID is unset; contact not added to a segment",
      { userId: user.id },
    );
    return;
  }
  const added = await resend.contacts.segments.add({
    email: user.email,
    segmentId,
  });
  if (added.error) {
    throw new Error(
      `Resend segment add failed: ${added.error.name}: ${added.error.message}`,
    );
  }
}
