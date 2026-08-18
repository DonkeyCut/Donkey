import { NextResponse } from "next/server";

import { getActiveProSubscription } from "@/lib/billing/pro-subscription";
import { creditMicrosToString, zeroCreditMicros } from "@/lib/credits/amounts";
import { creditGrantUnit } from "@/lib/credits/inference";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Pro subscription status for the settings UI, plus how much of this period's
// included allowance is left — the remaining balance on the active
// "pro_subscription" grant(s).
export const GET = withDonkeyAuth(async (request) => {
  const userId = request.donkey.userId;
  const now = new Date();

  const [subscription, grants] = await Promise.all([
    getActiveProSubscription(userId),
    prisma.userCreditGrant.findMany({
      select: { originalAmountMicros: true, remainingAmountMicros: true },
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        source: "pro_subscription",
        status: "active",
        unit: creditGrantUnit,
        userId,
      },
    }),
  ]);

  const allowanceRemainingMicros = grants.reduce(
    (sum, grant) => sum + grant.remainingAmountMicros,
    zeroCreditMicros,
  );
  // Denominator = what was actually granted this period, so "X of Y left" stays
  // consistent even if the price changed mid-period (the grant is frozen per
  // period). Fall back to the configured allowance before the first grant lands.
  const allowanceGrantedMicros = grants.reduce(
    (sum, grant) => sum + grant.originalAmountMicros,
    zeroCreditMicros,
  );
  const monthlyAllowanceMicros =
    allowanceGrantedMicros > zeroCreditMicros
      ? allowanceGrantedMicros
      : (subscription?.monthlyAllowanceMicros ?? zeroCreditMicros);

  return NextResponse.json({
    allowanceRemaining: creditMicrosToString(allowanceRemainingMicros),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
    isActive: Boolean(subscription),
    monthlyAllowance: subscription
      ? creditMicrosToString(monthlyAllowanceMicros)
      : null,
    status: subscription?.status ?? null,
  });
});
