import { NextResponse } from "next/server";

import { invalidResponse } from "@/lib/config/experimentList";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { promotionDraftSchema } from "@/lib/marketing/promotionInput";
import { listPromotions, promotionSenders } from "@/lib/marketing/promotions";
import { promotionData } from "@/lib/marketing/promotionSave";
import { prisma } from "@/lib/prisma";

// Promotions: the list with the addresses the senders stand for, and a new
// draft.

export const GET = withSuperUser(async () => {
  return NextResponse.json({ promotions: await listPromotions(), senders: promotionSenders() });
});

export const POST = withSuperUser(async (request) => {
  const parsed = promotionDraftSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const promotion = await prisma.promotion.create({
    data: promotionData(parsed.data, request.donkey.userId),
    select: { id: true },
  });
  return NextResponse.json({ id: promotion.id, promotions: await listPromotions() });
});
