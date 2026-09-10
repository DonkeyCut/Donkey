import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { deliverEmail } from "@/lib/email/outbox";
import { prisma } from "@/lib/prisma";

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Mails the saved copy to the operator, placeholders filled with their own
// account. A copy error comes back on the body field.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const [promotion, operator] = await Promise.all([
    prisma.promotion.findUnique({ select: { id: true }, where: { id: id.data } }),
    prisma.user.findUnique({ select: { email: true, id: true }, where: { id: request.donkey.userId } }),
  ]);
  if (!promotion || !operator) return notFoundResponse();

  const delivery = await deliverEmail({
    idempotencyKey: `promotion-test:${promotion.id}:${Date.now()}`,
    kind: "promotion-test",
    payload: { promotionId: promotion.id },
    userId: operator.id,
  });
  if (delivery.state === "failed") return invalidResponse([{ path: ["body"], message: delivery.error ?? "The send failed." }]);
  return NextResponse.json({ delivery: delivery.state, sentTo: operator.email });
});
