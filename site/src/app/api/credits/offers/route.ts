import { NextResponse } from "next/server";
import { z } from "zod";

import { creditStringToMicros } from "@/lib/credits/amounts";
import { createCreditOffer } from "@/lib/credits/offers";
import { maxCreditGrantDollars, maxCreditGrantExpiryDays } from "@/lib/credits/top-up";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Offers credit to an account: the amount waits until the person claims it
// from the email this sends. The target is identified by userId (offer to
// self) or by email. A single offer is capped to guard against typos. The
// caller states how long the credit lives once claimed; null keeps it forever.
const creditOfferRequestSchema = z
  .object({
    amountDollars: z.coerce.number().int().positive().max(maxCreditGrantDollars),
    description: z.string().trim().min(1).max(500).optional(),
    email: z.string().trim().email().optional(),
    expiresAfterDays: z.number().int().min(1).max(maxCreditGrantExpiryDays).nullable(),
    userId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((data) => Boolean(data.userId || data.email), {
    message: "Provide a userId or an email.",
  });

export const POST = withSuperUser(async (request) => {
  const parsed = creditOfferRequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const targetUser = await prisma.user.findUnique({
    select: { email: true, id: true, name: true },
    where: parsed.data.userId ? { id: parsed.data.userId } : { email: parsed.data.email },
  });
  if (!targetUser) return notFoundResponse();

  const offer = await createCreditOffer({
    amountMicros: creditStringToMicros(String(parsed.data.amountDollars)),
    description: parsed.data.description,
    expiresAfterDays: parsed.data.expiresAfterDays,
    offeredByUserId: request.donkey.userId,
    user: targetUser,
  });

  return NextResponse.json({
    amountDollars: parsed.data.amountDollars,
    offer: {
      emailSentAt: offer.emailSentAt?.toISOString() ?? null,
      expiresAfterDays: offer.expiresAfterDays,
      id: offer.id,
    },
    targetUser: { email: targetUser.email, id: targetUser.id },
  });
});
