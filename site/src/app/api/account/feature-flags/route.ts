import { NextResponse } from "next/server";

import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import { isDonkeySuperUser } from "@/lib/super-user";
import { featureFlagsFor } from "@/lib/feature-flags";
import { accountFlags } from "@/lib/feature-flags-server";
import { prisma } from "@/lib/prisma";

// The signed-in account's feature flags: the registry as this role sees it,
// with each flag's enabled state. Rows exist only for flags the user has
// touched; everyone else gets the flag's registry default.
export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  return NextResponse.json({ flags: await accountFlags(request.donkey.userId) });
});

export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const body = (await request.json().catch(() => null)) as {
    flag?: string;
    enabled?: boolean;
  } | null;
  const userId = request.donkey.userId;
  const known =
    body?.flag && typeof body.enabled === "boolean"
      ? featureFlagsFor(await isDonkeySuperUser(userId)).some((f) => f.id === body.flag)
      : false;
  if (!known || !body?.flag || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "Unknown flag." }, { status: 400 });
  }
  await prisma.userFeatureFlag.upsert({
    where: { userId_flag: { userId, flag: body.flag } },
    create: { userId, flag: body.flag, enabled: body.enabled },
    update: { enabled: body.enabled },
  });
  return NextResponse.json({ ok: true, flag: body.flag, enabled: body.enabled });
});
