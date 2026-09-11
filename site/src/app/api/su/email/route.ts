import { NextResponse } from "next/server";
import { z } from "zod";

import { invalidResponse } from "@/lib/config/experimentList";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { EMAIL_KIND_IDS } from "@/lib/email/kindIds";
import { drainKindNow, outboxOverview, retryEmail } from "@/lib/email/outbox";

// Without a queue configured (local dev) a drain runs inline before the
// response; give it room.
export const maxDuration = 300;

export const GET = withSuperUser(async () => NextResponse.json(await outboxOverview()));

const actionSchema = z.union([
  z.object({ action: z.literal("drain"), kind: z.enum(EMAIL_KIND_IDS) }).strict(),
  z.object({ action: z.literal("retry"), id: z.string().min(1) }).strict(),
]);

// Drain one kind now, or put one failed row back in the queue.
export const POST = withSuperUser(async (request) => {
  const parsed = actionSchema.safeParse(await request.json());
  if (!parsed.success) return invalidResponse(parsed.error.issues);
  if (parsed.data.action === "drain") {
    await drainKindNow(parsed.data.kind, request.donkey.userId);
  } else if (!(await retryEmail(parsed.data.id))) {
    return notFoundResponse();
  }
  return NextResponse.json(await outboxOverview());
});
