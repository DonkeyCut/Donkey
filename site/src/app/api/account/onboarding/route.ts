import { NextResponse } from "next/server";
import { z } from "zod";

import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import {
  ONBOARDING_VERSION,
  REFERRAL_OTHER_MAX_LENGTH,
  REFERRAL_SOURCES,
  isKnownReferralSource,
} from "@/lib/onboarding/sequence";
import { prisma } from "@/lib/prisma";

type OnboardingRow = {
  version: number;
  completedAt: Date | null;
  skipped: boolean;
  referralSources: string[];
  referralOther: string | null;
};

type OnboardingState = {
  version: number;
  completedAt: string | null;
  skipped: boolean;
  referralSources: string[];
  referralOther: string | null;
  // Whether the signup credit grant landed on this account. An address that
  // deleted an earlier account starts without it, and the credits slide says
  // so.
  signupCreditsGranted: boolean;
};

// An account that has never opened the sequence has no row; it reads as an
// unfinished run of the current sequence rather than as an error.
const UNSTARTED: OnboardingRow = {
  version: ONBOARDING_VERSION,
  completedAt: null,
  skipped: false,
  referralSources: [],
  referralOther: null,
};

export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const userId = request.donkey.userId;
  const row = await prisma.userOnboarding.findUnique({ where: { userId } });
  return NextResponse.json(await toState(userId, row ?? UNSTARTED));
});

const updateSchema = z
  .object({
    referralSources: z
      .array(z.string().refine(isKnownReferralSource))
      .max(REFERRAL_SOURCES.length),
    referralOther: z.string().trim().max(REFERRAL_OTHER_MAX_LENGTH).optional(),
  })
  .or(z.object({ completed: z.literal(true), skipped: z.boolean() }));

// One write for both things the sequence records: the referral answer when it's
// given, and the run's end. Either is the account's first row, so both upsert.
export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const userId = request.donkey.userId;
  const data =
    "referralSources" in parsed.data
      ? {
          referralSources: [...new Set(parsed.data.referralSources)],
          // The text only means anything as the "other" answer; without that
          // pick it stores nothing.
          referralOther:
            (parsed.data.referralSources.includes("other") &&
              parsed.data.referralOther) ||
            null,
          referralAnsweredAt: new Date(),
        }
      : {
          completedAt: new Date(),
          skipped: parsed.data.skipped,
          version: ONBOARDING_VERSION,
        };

  const row = await prisma.userOnboarding.upsert({
    where: { userId },
    create: { userId, version: ONBOARDING_VERSION, ...data },
    update: data,
  });
  return NextResponse.json(await toState(userId, row));
});

async function toState(userId: string, row: OnboardingRow): Promise<OnboardingState> {
  const grant = await prisma.userCreditGrant.findFirst({
    where: { userId, source: "signup" },
    select: { id: true },
  });
  return {
    version: row.version,
    completedAt: row.completedAt?.toISOString() ?? null,
    skipped: row.skipped,
    referralSources: row.referralSources,
    referralOther: row.referralOther,
    signupCreditsGranted: grant !== null,
  };
}
