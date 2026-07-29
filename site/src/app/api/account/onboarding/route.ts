import { NextResponse } from "next/server";
import { z } from "zod";

import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import {
  ONBOARDING_VERSION,
  REFERRAL_SOURCES,
  isKnownReferralSource,
} from "@/lib/onboarding/sequence";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type OnboardingState = {
  version: number;
  completedAt: string | null;
  skipped: boolean;
  referralSources: string[];
};

// An account that has never opened the sequence has no row; it reads as an
// unfinished run of the current sequence rather than as an error.
const UNSTARTED: OnboardingState = {
  version: ONBOARDING_VERSION,
  completedAt: null,
  skipped: false,
  referralSources: [],
};

export const GET = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const row = await prisma.userOnboarding.findUnique({
    where: { userId: request.donkey.userId },
  });
  return NextResponse.json(row ? toState(row) : UNSTARTED);
});

const updateSchema = z
  .object({
    referralSources: z
      .array(z.string().refine(isKnownReferralSource))
      .max(REFERRAL_SOURCES.length),
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
  return NextResponse.json(toState(row));
});

function toState(row: {
  version: number;
  completedAt: Date | null;
  skipped: boolean;
  referralSources: string[];
}): OnboardingState {
  return {
    version: row.version,
    completedAt: row.completedAt?.toISOString() ?? null,
    skipped: row.skipped,
    referralSources: row.referralSources,
  };
}
