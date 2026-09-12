import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { enqueueJob } from "@/lib/jobs/queue";
import { listPromotions } from "@/lib/marketing/promotions";
import { sendIssue } from "@/lib/marketing/promotionSave";
import { prisma } from "@/lib/prisma";

// Without a queue (local dev) the job's first run happens inside this
// request, so the budget matches the worker's.
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
const idSchema = z.string().trim().min(1);

// Starts a send, once the draft reads as a complete promotion: a job reads the segment a page at a time into outbox rows
// while the promotion is queuing, moves it to sending once every recipient
// is a row, and the outbox drainer mails the rows under the budget. The rows
// are the send's memory — a later promotion that excludes this one reads
// them, and a resumed send adds only the accounts not already queued.
export const POST = withSuperUser(async (request, { params }: Params) => {
  const id = idSchema.safeParse((await params).id);
  if (!id.success) return notFoundResponse();
  const promotion = await prisma.promotion.findUnique({ where: { id: id.data } });
  if (!promotion) return notFoundResponse();
  if (promotion.status !== "draft" && promotion.status !== "paused") {
    return invalidResponse([{ path: ["status"], message: "This promotion has already been sent." }]);
  }
  const refused = sendIssue(promotion);
  if (refused) return refused;

  await prisma.promotion.update({
    data: { startedAt: promotion.startedAt ?? new Date(), status: "queuing" },
    where: { id: promotion.id },
  });
  await enqueueJob("promotion-queue", { promotionId: promotion.id }, request.donkey.userId);

  return NextResponse.json({ promotions: await listPromotions() });
});
