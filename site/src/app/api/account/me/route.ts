import { NextResponse } from "next/server";

import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Minimal identity for the settings UI: who am I, and am I a super user (which
// gates the manual credit-grant card). Session-only.
export const GET = withDonkeyAuth(async (request) => {
  const user = await prisma.user.findUnique({
    select: { email: true, superUser: true },
    where: { id: request.donkey.userId },
  });

  return NextResponse.json({
    email: user?.email ?? null,
    superUser: user?.superUser === true,
    userId: request.donkey.userId,
  });
});
