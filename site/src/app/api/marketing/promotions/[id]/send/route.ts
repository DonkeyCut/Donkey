import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  listPromotions,
  promotionAudienceOf,
  resolvePromotionSegment,
} from "@/lib/marketing/promotions";
import { prisma } from "@/lib/prisma";

// Resolving a segment reads facts for every account, and without a queue the
// job's first run happens inside this request, so the budget matches the
// worker's.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Starts a send: the segment is resolved into recipient rows once, here, and
// the promotion-send job mails them. The rows are the send's memory — a later
// promotion that excludes this one reads them, and a re-run of the job skips
// the ones already marked sent.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const promotion = await prisma.promotion.findUnique({ where: { id: id.data } });
  if (!promotion) return notFoundResponse();
  if (promotion.status !== "draft") {
    return invalidResponse([{ path: ["status"], message: "This promotion has already been sent." }]);
  }

  const segment = await resolvePromotionSegment({
    audience: promotionAudienceOf(promotion.audience),
    excludePromotionIds: promotion.excludePromotionIds,
  });
  if (segment.users.length === 0) {
    return invalidResponse([{ path: ["audience"], message: "Nobody is in this segment." }]);
  }

  await prisma.$transaction([
    prisma.promotionRecipient.createMany({
      data: segment.users.map((user) => ({ promotionId: promotion.id, userId: user.id })),
      skipDuplicates: true,
    }),
    prisma.promotion.update({
      data: { startedAt: new Date(), status: "sending" },
      where: { id: promotion.id },
    }),
  ]);
  const { jobId } = await enqueueJob("promotion-send", { promotionId: promotion.id }, request.donkey.userId);

  return NextResponse.json({
    jobId,
    promotions: await listPromotions(),
    recipients: segment.users.length,
  });
});
