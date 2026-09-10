import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { queueEmails } from "@/lib/email/outbox";
import { byMostRecentlyActive, lastActiveByUser } from "@/lib/marketing/lastActive";
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

// Starts a send: the segment is resolved into outbox rows once, here, and the
// outbox drainer mails them under the day's quota. The rows are the send's
// memory — a later promotion that excludes this one reads them, and a resumed
// send adds only the accounts not already queued.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const promotion = await prisma.promotion.findUnique({ where: { id: id.data } });
  if (!promotion) return notFoundResponse();
  if (promotion.status !== "draft" && promotion.status !== "paused") {
    return invalidResponse([{ path: ["status"], message: "This promotion has already been sent." }]);
  }

  const segment = await resolvePromotionSegment({
    audience: promotionAudienceOf(promotion.audience),
    excludePromotionIds: promotion.excludePromotionIds,
  });
  if (segment.users.length === 0) {
    return invalidResponse([{ path: ["audience"], message: "Nobody is in this segment." }]);
  }

  // The people most recently using the product go first: a campaign that
  // outlasts the day's send quota reaches them before it reaches the
  // dormant.
  const ranked = byMostRecentlyActive(segment.users, await lastActiveByUser(segment.users.map((u) => u.id)));
  await prisma.promotion.update({
    data: { startedAt: promotion.startedAt ?? new Date(), status: "sending" },
    where: { id: promotion.id },
  });
  await queueEmails(
    ranked.map((user, rank) => ({
      idempotencyKey: `promotion:${promotion.id}:${user.id}`,
      kind: "promotion",
      payload: { promotionId: promotion.id },
      promotionId: promotion.id,
      rank,
      userId: user.id,
    })),
  );

  return NextResponse.json({
    promotions: await listPromotions(),
    recipients: segment.users.length,
  });
});
