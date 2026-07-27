import { NextResponse } from "next/server";

import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import { ACCOUNT_FEATURE_FLAGS, isKnownFeatureFlag } from "@/lib/feature-flags";
import { prisma } from "@/lib/prisma";

// The signed-in account's feature flags: the full registry with each flag's
// enabled state. Rows exist only for flags the user has touched; everyone else
// gets the flag's registry default.
export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const rows = await prisma.userFeatureFlag.findMany({
    where: { userId: request.donkey.userId },
  });
  const enabled = new Map(rows.map((r) => [r.flag, r.enabled]));
  return NextResponse.json({
    flags: ACCOUNT_FEATURE_FLAGS.map((f) => ({
      ...f,
      enabled: enabled.get(f.id) ?? f.defaultEnabled,
    })),
  });
});

export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const body = (await request.json().catch(() => null)) as {
    flag?: string;
    enabled?: boolean;
  } | null;
  if (!body?.flag || typeof body.enabled !== "boolean" || !isKnownFeatureFlag(body.flag)) {
    return NextResponse.json({ error: "Unknown flag." }, { status: 400 });
  }
  const userId = request.donkey.userId;
  await prisma.userFeatureFlag.upsert({
    where: { userId_flag: { userId, flag: body.flag } },
    create: { userId, flag: body.flag, enabled: body.enabled },
    update: { enabled: body.enabled },
  });
  return NextResponse.json({ ok: true, flag: body.flag, enabled: body.enabled });
});
