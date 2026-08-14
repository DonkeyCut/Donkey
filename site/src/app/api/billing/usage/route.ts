import { NextResponse } from "next/server";

import { Prisma } from "@/generated/prisma/client";

import { creditMicrosToString } from "@/lib/credits/amounts";
import { readInferenceUsageBreakdown } from "@/lib/credits/inference";
import {
  donkeySessionUserId,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Up to 5 pages of 25 in the usage tab.
const recentLimit = 125;

const recentSelect = {
  billingStatus: true,
  conversationId: true,
  createdAt: true,
  creditCostMicros: true,
  errorCode: true,
  model: true,
  normalizedUsage: true,
  requestKind: true,
  status: true,
} satisfies Prisma.InferenceUsageEventSelect;

type RecentEvent = Prisma.InferenceUsageEventGetPayload<{
  select: typeof recentSelect;
}>;

function toRecentCall(event: RecentEvent) {
  return {
    billingStatus: event.billingStatus,
    // The app conversation this call belongs to; null for background work and
    // pre-grouping rows. The usage UI groups rows by this.
    conversationId: event.conversationId,
    // Credits are dollar-denominated (1 credit = $1), so this string is USD.
    costCredits: creditMicrosToString(event.creditCostMicros),
    createdAt: event.createdAt.toISOString(),
    errorCode: event.errorCode,
    model: event.model,
    requestKind: event.requestKind,
    status: event.status,
    // Per-call token breakdown — what actually drove the cost. Large input =
    // long question/context; large output = long answer.
    usage: readInferenceUsageBreakdown(event.normalizedUsage),
  };
}

// Recent credit-billed inference calls for the settings usage UI.
export const GET = withDonkeyAuth(async (request) => {
  const userId = donkeySessionUserId(request);
  if (!userId) {
    return unauthorizedResponse();
  }

  const recent = await prisma.inferenceUsageEvent.findMany({
    orderBy: { createdAt: "desc" },
    select: recentSelect,
    take: recentLimit,
    where: { billingStatus: { not: "included" }, userId },
  });

  return NextResponse.json({
    recent: recent.map(toRecentCall),
  });
});
