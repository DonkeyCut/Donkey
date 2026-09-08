import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { UnknownPlaceholderError } from "@/lib/marketing/placeholders";
import { promotionCopyOf, sendPromotionEmail } from "@/lib/marketing/promotions";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Mails the saved copy to the operator, placeholders filled with their own
// account, from the sender the promotion names. Every click sends again.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const [promotion, operator] = await Promise.all([
    prisma.promotion.findUnique({ where: { id: id.data } }),
    prisma.user.findUnique({
      select: { email: true, id: true, name: true },
      where: { id: request.donkey.userId },
    }),
  ]);
  if (!promotion || !operator) return notFoundResponse();

  try {
    await sendPromotionEmail({
      copy: promotionCopyOf(promotion),
      idempotencyKey: `promotion-test:${promotion.id}:${Date.now()}`,
      user: operator,
    });
  } catch (error) {
    if (error instanceof UnknownPlaceholderError) {
      return invalidResponse([{ path: ["body"], message: error.message }]);
    }
    throw error;
  }
  return NextResponse.json({ sentTo: operator.email });
});
