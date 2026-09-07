import { NextResponse } from "next/server";
import { audienceSchema } from "@donkeycut/abexp";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { withSuperUser } from "@/lib/donkey-api-auth";
import { resolvePromotionSegment } from "@/lib/marketing/promotions";

export const maxDuration = 120;

const segmentSchema = z
  .object({
    audience: audienceSchema,
    excludePromotionIds: z.array(z.string().min(1)).max(100),
  })
  .strict();

// How many accounts a segment reaches right now, and where the rest went.
// The dialog asks before a send; the send resolves again on its own.
export const POST = withSuperUser(async (request) => {
  const parsed = segmentSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  const { recipients, unsubscribed, alreadyReceived, outsideAudience } = await resolvePromotionSegment(parsed.data);
  return NextResponse.json({ alreadyReceived, outsideAudience, recipients, unsubscribed });
});
