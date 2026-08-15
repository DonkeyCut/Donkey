import { NextResponse } from "next/server";
import {
  donkeySessionUserId,
  notFoundResponse,
  unauthorizedResponse,
  withDonkeyAuth,
} from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/** Revoke a key. The row stays for the audit trail; `enabled: false` stops
 * matching live traffic immediately. */
export const DELETE = withDonkeyAuth(async (request, ctx: { params: Promise<{ id: string }> }) => {
  const userId = donkeySessionUserId(request);
  if (!userId) return unauthorizedResponse();
  const { id } = await ctx.params;
  const updated = await prisma.apikey.updateMany({
    where: { id, referenceId: userId, enabled: true },
    data: { enabled: false, updatedAt: new Date() },
  });
  if (updated.count === 0) return notFoundResponse();
  return NextResponse.json({ ok: true });
});
