import { z } from "zod";

import { queueEmails, scheduleDrain } from "@/lib/email/outbox";
import { defineJob, JobFailure } from "@/lib/jobs/registry";
import { activityRank, lastActiveByUser } from "@/lib/marketing/lastActive";
import { promotionAudienceOf, promotionIdempotencyKey, resolvePromotionSegment } from "@/lib/marketing/promotions";
import { prisma } from "@/lib/prisma";

// Turns a promotion's segment into outbox rows, a page of accounts at a
// time: the audience is resolved for the page, the page is ranked by when
// each person last used the product, and its rows are queued. The promotion
// is queuing throughout, so the drainer can send rows as they land without
// finishing it early; once the whole list is read it moves to sending, and
// the drainer finishes it when the last row goes. A run that runs out of
// time queues its continuation from the last account read; a promotion
// paused meanwhile stops where it is and a later send resumes it, the rows
// already queued left as they are. Under the worker's 300 s maxDuration,
// with room for the continuation's own writes.
const BUDGET_MS = 200_000;

export const promotionQueueJob = defineJob(
  z.object({ promotionId: z.string().min(1), cursor: z.string().min(1).optional() }).strict(),
  async ({ promotionId, cursor }) => {
    const promotion = await prisma.promotion.findUnique({ where: { id: promotionId } });
    if (!promotion) throw new JobFailure("The promotion no longer exists.");
    if (promotion.status !== "queuing") return { queued: 0, stopped: true };

    const now = new Date();
    let queued = 0;
    const result = await resolvePromotionSegment(
      { audience: promotionAudienceOf(promotion.audience), excludePromotionIds: promotion.excludePromotionIds },
      {
        cursor,
        deadline: Date.now() + BUDGET_MS,
        now,
        onPage: async (users) => {
          const standing = await prisma.promotion.findUnique({ select: { status: true }, where: { id: promotionId } });
          if (standing?.status !== "queuing") return false;
          if (users.length === 0) return;
          const lastActiveBy = await lastActiveByUser(users.map((u) => u.id));
          queued += await queueEmails(
            users.map((user) => ({
              idempotencyKey: promotionIdempotencyKey(promotionId, user.id),
              kind: "promotion",
              payload: { promotionId },
              promotionId,
              rank: activityRank(now, lastActiveBy.get(user.id)),
              userId: user.id,
            })),
          );
        },
      },
    );

    if (result.cursor !== null) {
      const standing = await prisma.promotion.findUnique({ select: { status: true }, where: { id: promotionId } });
      if (standing?.status !== "queuing") return { queued, stopped: true };
      const { enqueueJob } = await import("@/lib/jobs/queue");
      await enqueueJob("promotion-queue", { promotionId, cursor: result.cursor }, "system");
      return { queued, continued: true };
    }

    // The whole list was read. Nothing outstanding — nobody was in the
    // segment, or the drainer kept up — finishes it here; otherwise it is
    // sending, and the drainer finishes it when the last row goes.
    const owed = await prisma.emailSend.count({ where: { promotionId, state: { in: ["queued", "sending"] } } });
    const moved = await prisma.promotion.updateMany({
      data: owed === 0 ? { finishedAt: new Date(), status: "sent" } : { status: "sending" },
      where: { id: promotionId, status: "queuing" },
    });
    if (moved.count === 0) return { queued, stopped: true };
    if (owed > 0) await scheduleDrain(0);
    return { queued };
  },
);
