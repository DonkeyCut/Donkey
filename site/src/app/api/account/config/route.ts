import { NextResponse } from "next/server";

import { contextFromRequest, getEffectiveConfig } from "@/lib/config/effective";
import { publicSubset } from "@/lib/config/resolve";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// The signed-in caller's configuration: the public settings after overrides
// and experiments, and the variant they hold in each running experiment.
// Reading is exposure — the app is about to act on these values — so the
// unexposed assignments are stamped here and named back, and the browser
// reports those first exposures to analytics.
export const GET = withDonkeyAuth(async (request) => {
  const ctx = await contextFromRequest(request);
  const config = await getEffectiveConfig(ctx);

  const unexposed = config.assignments.filter((a) => a.exposedAt === null);
  if (unexposed.length > 0) {
    await prisma.experimentAssignment.updateMany({
      where: {
        userId: ctx.userId,
        experimentId: { in: unexposed.map((a) => a.experimentId) },
        exposedAt: null,
      },
      data: { exposedAt: new Date() },
    });
  }

  return NextResponse.json({
    settings: publicSubset(config.settings),
    experiments: config.experiments,
    exposed: unexposed.map((a) => a.key),
  });
});
