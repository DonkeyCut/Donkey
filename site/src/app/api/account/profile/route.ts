import { NextResponse } from "next/server";
import { z } from "zod";

import { LOCALES } from "@/i18n/locales";
import { accountProfile } from "@/lib/account-profile";
import {
  notFoundResponse,
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import { validationErrorResponse } from "@/lib/inference/responses";
import { prisma } from "@/lib/prisma";

// The visible name is the product's own field. `name` keeps whatever Google
// gave us at sign-in — billing and the provider record depend on it — so a
// user renaming themselves writes `displayName`, and clearing it falls back to
// the Google name rather than blanking the account. A request changes only
// the fields it names.
const updateProfileSchema = z.object({
  displayName: z.string().trim().max(60).nullable().optional(),
  locale: z.enum(LOCALES).optional(),
});

export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const profile = await accountProfile(request.donkey.userId);
  if (!profile) return notFoundResponse();
  return NextResponse.json(profile);
});

export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const parsed = updateProfileSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationErrorResponse(parsed.error);

  const userId = request.donkey.userId;
  const { displayName, locale } = parsed.data;
  await prisma.user.update({
    data: {
      ...(displayName !== undefined ? { displayName: displayName || null } : {}),
      ...(locale ? { locale } : {}),
    },
    where: { id: userId },
  });

  return NextResponse.json(await accountProfile(userId));
});
