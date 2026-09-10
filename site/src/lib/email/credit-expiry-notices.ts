import { creditMicrosToString } from "@/lib/credits/amounts";
import { metadataObject, pendingCreditExpiryGrants } from "@/lib/email/credit-expiry-due";
import { queueEmails } from "@/lib/email/outbox";
import { creditsExpiringIdempotencyKey } from "@/lib/email/send-credits-expiring";
import { prisma } from "@/lib/prisma";

// Queues one expiry notice for every account holding a given grant that
// expires inside the window and has not been told. The outbox row is keyed
// on the grant, so a run that overlaps the last one adds nothing; the send
// is recorded on the grant's metadata once it goes out. Credit on the
// account is account mail, so the marketing opt-out does not apply; the
// footer still offers it.
export async function queueDueCreditExpiryNotices(input: { now?: Date; withinDays: number }) {
  const now = input.now ?? new Date();
  const { due, pending } = await pendingCreditExpiryGrants(now, input.withinDays);
  const queued = await queueEmails(
    pending
      .filter((grant) => grant.expiresAt)
      .map((grant) => ({
        idempotencyKey: creditsExpiringIdempotencyKey(grant.id),
        kind: "credit-expiry",
        payload: { credits: creditMicrosToString(grant.remainingAmountMicros), grantId: grant.id },
        userId: grant.user.id,
      })),
  );
  return { due, pending: pending.length, queued };
}

export async function recordExpiryNoticeSent(grantId: string): Promise<void> {
  const grant = await prisma.userCreditGrant.findUnique({ select: { metadata: true }, where: { id: grantId } });
  if (!grant) return;
  await prisma.userCreditGrant.update({
    data: { metadata: { ...metadataObject(grant.metadata), expiryNoticeSentAt: new Date().toISOString() } },
    where: { id: grantId },
  });
}
