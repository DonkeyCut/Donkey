import { z } from "zod";

import { ResendNotConfiguredError } from "@/lib/email/resend";
import { isMarketingUnsubscribed } from "@/lib/email/unsubscribe";
import { defineJob, JobFailure } from "@/lib/jobs/registry";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { MAX_SEND_ATTEMPTS } from "@/lib/marketing/promotionInput";
import { promotionCopyOf, sendPromotionEmail } from "@/lib/marketing/promotions";
import { prisma } from "@/lib/prisma";

// Sends a promotion to the recipient rows its send resolved. One email at a
// time, paced under the provider's rate limit, each keyed on the recipient so
// a re-run mails nobody twice. The opt-out is read again right before each
// send, so someone who unsubscribed after the segment was resolved is
// skipped. A failed send is tried again later in the run, up to MAX_SEND_ATTEMPTS,
// with a pause after each failure so a provider blip does not burn the list.
// A run stops inside the worker's time budget and queues its own
// continuation; the last run marks the promotion sent.

const TAKE = 50;
const PACE_MS = 550;
const FAILURE_PAUSE_MS = 5_000;
// Under the worker's 300 s maxDuration, with room for the pause and the
// continuation's own writes.
const BUDGET_MS = 200_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const payloadSchema = z.object({ promotionId: z.string().min(1) }).strict();

export const promotionSendJob = defineJob(payloadSchema, async ({ promotionId }) => {
  const promotion = await prisma.promotion.findUnique({ where: { id: promotionId } });
  if (!promotion) throw new JobFailure("The promotion no longer exists.");
  if (promotion.status !== "sending") return { promotionId, skipped: promotion.status };
  const copy = promotionCopyOf(promotion);

  const startedAt = Date.now();
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const continueLater = async () => {
    const { enqueueJob } = await import("@/lib/jobs/queue");
    await enqueueJob("promotion-send", { promotionId }, promotion.actorUserId ?? "system");
    return { continued: true, failed, promotionId, sent, skipped };
  };

  for (;;) {
    // Rows still owed a send: never sent, not given up on. A row that failed
    // earlier in this run comes back at the end of the order.
    const pending = await prisma.promotionRecipient.findMany({
      orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
      select: { attempts: true, id: true, user: { select: { email: true, id: true, name: true } } },
      take: TAKE,
      where: { attempts: { lt: MAX_SEND_ATTEMPTS }, promotionId, sentAt: null },
    });
    if (pending.length === 0) break;
    for (const recipient of pending) {
      if (Date.now() - startedAt > BUDGET_MS) return continueLater();

      if (await isMarketingUnsubscribed(recipient.user.id)) {
        await prisma.promotionRecipient.update({
          data: { attempts: MAX_SEND_ATTEMPTS, error: "Unsubscribed before the send." },
          where: { id: recipient.id },
        });
        skipped++;
        continue;
      }
      try {
        await sendPromotionEmail({
          copy,
          idempotencyKey: `promotion:${promotionId}:${recipient.user.id}`,
          user: recipient.user,
        });
        await prisma.promotionRecipient.update({
          data: { error: null, sentAt: new Date() },
          where: { id: recipient.id },
        });
        sent++;
        await sleep(PACE_MS);
      } catch (error) {
        // Permanent for the whole send: the draft comes back so the operator
        // can fix it, and the unsent rows go with it.
        if (error instanceof ResendNotConfiguredError || error instanceof UnknownPlaceholderError) {
          await prisma.promotionRecipient.deleteMany({ where: { promotionId, sentAt: null } });
          await prisma.promotion.update({ data: { status: "draft" }, where: { id: promotionId } });
          throw new JobFailure(error.message);
        }
        await prisma.promotionRecipient.update({
          data: {
            attempts: { increment: 1 },
            error: error instanceof Error ? error.message : String(error),
          },
          where: { id: recipient.id },
        });
        if (recipient.attempts + 1 >= MAX_SEND_ATTEMPTS) failed++;
        await sleep(FAILURE_PAUSE_MS);
      }
    }
  }
  await prisma.promotion.update({ data: { finishedAt: new Date(), status: "sent" }, where: { id: promotionId } });
  return { failed, promotionId, sent, skipped };
});
