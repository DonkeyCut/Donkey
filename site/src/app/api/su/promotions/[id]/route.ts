import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { promotionInputSchema } from "@/lib/marketing/promotionInput";
import { listPromotions } from "@/lib/marketing/promotions";
import { copyIssue, promotionData } from "@/lib/marketing/promotionSave";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// A draft is edited in place; anything that has started sending is history
// and stays as it went out.
export const PUT = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const parsed = promotionInputSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const refused = copyIssue(parsed.data);
  if (refused) return refused;

  const existing = await prisma.promotion.findUnique({ select: { status: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  if (existing.status !== "draft") {
    return invalidResponse([{ path: ["status"], message: "A promotion that has been sent cannot change." }]);
  }
  await prisma.promotion.update({ data: promotionData(parsed.data, request.donkey.userId), where: { id: id.data } });
  return NextResponse.json({ id: id.data, promotions: await listPromotions() });
});

// Deleting a sent promotion drops its recipient rows too, so a later
// promotion can no longer skip the people it reached.
export const DELETE = withSuperUser(async (_request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const existing = await prisma.promotion.findUnique({ select: { status: true }, where: { id: id.data } });
  if (!existing) return notFoundResponse();
  if (existing.status === "queuing" || existing.status === "sending") {
    return invalidResponse([{ path: ["status"], message: "A promotion that is sending cannot be deleted." }]);
  }
  await prisma.promotion.delete({ where: { id: id.data } });
  return NextResponse.json({ promotions: await listPromotions() });
});
