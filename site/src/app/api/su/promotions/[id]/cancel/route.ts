import { NextResponse } from "next/server";
import { z } from "zod";

import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { invalidResponse } from "@/lib/config/experimentList";
import { listPromotions } from "@/lib/marketing/promotions";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

export const POST = withSuperUser(async (_request, { params }: Params) => {
  const parsed = idSchema.safeParse((await params).id);
  if (!parsed.success) return notFoundResponse();
  const promotion = await prisma.promotion.findUnique({ where: { id: parsed.data } });
  if (!promotion) return notFoundResponse();
  if (promotion.status !== "queuing" && promotion.status !== "sending") {
    return invalidResponse([{ path: ["status"], message: "This promotion is not running." }]);
  }
  await prisma.promotion.update({ data: { status: "paused" }, where: { id: promotion.id } });
  return NextResponse.json({ promotions: await listPromotions() });
});
