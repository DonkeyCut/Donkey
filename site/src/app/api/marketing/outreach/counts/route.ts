import { NextResponse } from "next/server";

import { withSuperUser } from "@/lib/donkey-api-auth";
import {
  CREDIT_SPENDERS_CAMPAIGN,
  OUTREACH_STATUSES,
  type OutreachStatus,
} from "@/lib/marketing/campaigns";
import { prisma } from "@/lib/prisma";

// How many rows each list holds, so the filters can say it. It is its own read
// because the number belongs to every list at once: the totals stay put while a
// list is being fetched, and one action refreshes all four.
export const GET = withSuperUser(async () => {
  const grouped = await prisma.userOutreach.groupBy({
    _count: { _all: true },
    by: ["status"],
    where: { campaign: CREDIT_SPENDERS_CAMPAIGN },
  });

  const counts = Object.fromEntries(
    OUTREACH_STATUSES.map((status) => [status, 0]),
  ) as Record<OutreachStatus, number>;
  for (const entry of grouped) {
    if ((OUTREACH_STATUSES as readonly string[]).includes(entry.status)) {
      counts[entry.status as OutreachStatus] = entry._count._all;
    }
  }

  return NextResponse.json({ counts });
});
