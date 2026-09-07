import { NextResponse } from "next/server";
import { z } from "zod";

import { creditMicrosToString, creditStringToMicros } from "@/lib/credits/amounts";
import { getCreditBalance, grantCredits } from "@/lib/credits/inference";
import {
  creditGrantExpiry,
  maxCreditGrantDollars,
  maxCreditGrantExpiryDays,
} from "@/lib/credits/top-up";
import { notFoundResponse, withSuperUser } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// The target is identified by userId (grant to self) or by email (grant to
// another user). At least one is required. A single grant is capped to guard
// against typos. The caller states how long the grant lives; null keeps it
// forever.
const creditGrantRequestSchema = z
  .object({
    amountDollars: z.coerce.number().int().positive().max(maxCreditGrantDollars),
    description: z.string().trim().min(1).max(500).optional(),
    email: z.string().trim().email().optional(),
    expiresAfterDays: z.number().int().min(1).max(maxCreditGrantExpiryDays).nullable(),
    sourceId: z.string().trim().min(1).max(160).optional(),
    userId: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((data) => Boolean(data.userId || data.email), {
    message: "Provide a userId or an email.",
  });

export const POST = withSuperUser(async (request) => {
  const parsed = creditGrantRequestSchema.safeParse(await request.json());
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
    select: {
      email: true,
      id: true,
    },
    where: parsed.data.userId
      ? { id: parsed.data.userId }
      : { email: parsed.data.email },
  });

  if (!targetUser) {
    return notFoundResponse();
  }

  const amountMicros = creditStringToMicros(String(parsed.data.amountDollars));
  const sourceId =
    parsed.data.sourceId ?? `manual-dollar:${targetUser.id}:${crypto.randomUUID()}`;
  const description =
    parsed.data.description ?? `Manual $${parsed.data.amountDollars} credit grant`;

  const grant = await grantCredits({
    amountMicros,
    description,
    expiresAt: creditGrantExpiry(parsed.data.expiresAfterDays),
    metadata: {
      amountDollars: String(parsed.data.amountDollars),
      expiresAfterDays: parsed.data.expiresAfterDays,
      grantedByUserId: request.donkey.userId,
      targetUserId: targetUser.id,
    },
    source: "manual_dollar",
    sourceId,
    userId: targetUser.id,
  });
  const balance = await getCreditBalance(targetUser.id);

  return NextResponse.json({
    amountDollars: parsed.data.amountDollars,
    creditMicrosGranted: amountMicros.toString(),
    creditsGranted: creditMicrosToString(amountMicros),
    grant: {
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      id: grant.id,
      source: grant.source,
      sourceId: grant.sourceId,
    },
    targetUser: {
      email: targetUser.email,
      id: targetUser.id,
    },
    balance,
  });
});
