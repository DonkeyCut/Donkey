import { NextResponse } from "next/server";
import { z } from "zod";

import { starterProjectId } from "@/cut/lib/starter";
import { seedStarterProject } from "@/cut/server/cloud/starter";
import { creditMicrosToString } from "@/lib/credits/amounts";
import {
  withDonkeyAuth,
  type DonkeyAuthenticatedRequest,
} from "@/lib/donkey-api-auth";
import {
  ONBOARDING_VERSION,
  REFERRAL_OTHER_MAX_LENGTH,
  REFERRAL_SOURCES,
  TOUR_STEPS,
  isKnownReferralSource,
} from "@/lib/onboarding/sequence";
import { prisma } from "@/lib/prisma";

type OnboardingRow = {
  version: number;
  completedAt: Date | null;
  skipped: boolean;
  slidesDoneAt: Date | null;
  tourSteps: string[];
  referralSources: string[];
  referralOther: string | null;
};

type OnboardingState = {
  version: number;
  completedAt: string | null;
  skipped: boolean;
  slidesDoneAt: string | null;
  tourSteps: string[];
  // Whether the starter project exists, so the tour has somewhere to run. A
  // restart and the slides' end seed it; an account that deletes it mid-tour
  // goes on to the plans.
  starterReady: boolean;
  referralSources: string[];
  referralOther: string | null;
  // USD the signup grant landed on this account, or null when none did: the
  // address deleted an earlier account, or the setting grants nothing. The
  // credits slide names this amount.
  signupCredits: string | null;
  // When that grant stops being spendable, or null when it never does.
  signupCreditsExpiresAt: string | null;
};

// An account that has never opened the sequence has no row; it reads as an
// unfinished run of the current sequence rather than as an error.
const UNSTARTED: OnboardingRow = {
  version: ONBOARDING_VERSION,
  completedAt: null,
  skipped: false,
  slidesDoneAt: null,
  tourSteps: [],
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
  .or(z.object({ completed: z.literal(true), skipped: z.boolean() }))
  .or(z.object({ slidesDone: z.literal(true) }))
  .or(z.object({ restart: z.literal(true) }))
  .or(z.object({ tourStep: z.enum(TOUR_STEPS) }));

// One write for everything the sequence records: the referral answer when it's
// given, the slides' end, each tour step, the run's end, and a restart that
// sends a finished account through the whole run again. Any of them can be the
// account's first row, so all upsert.
export const PUT = withDonkeyAuth(async (request: DonkeyAuthenticatedRequest) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const userId = request.donkey.userId;
  const update = parsed.data;

  // A tour step appends once: a repeat send leaves the list as it is.
  if ("tourStep" in update) {
    const current = await prisma.userOnboarding.findUnique({ where: { userId } });
    const row = current?.tourSteps.includes(update.tourStep)
      ? current
      : await prisma.userOnboarding.upsert({
          where: { userId },
          create: { userId, version: ONBOARDING_VERSION, tourSteps: [update.tourStep] },
          update: { tourSteps: { push: update.tourStep } },
        });
    return NextResponse.json(await toState(userId, row));
  }

  // The tour runs on the starter project, which opens behind the slides, so a
  // restart and the slides' end put it back for an account that deleted it.
  // Seeding an existing starter is a no-op.
  if ("slidesDone" in update || "restart" in update) {
    await seedStarterProject(userId);
  }

  const data =
    "slidesDone" in update
      ? { slidesDoneAt: new Date() }
      : "restart" in update
      ? { completedAt: null, skipped: false, slidesDoneAt: null, tourSteps: [] }
      : "referralSources" in update
      ? {
          referralSources: [...new Set(update.referralSources)],
          // The text only means anything as the "other" answer; without that
          // pick it stores nothing.
          referralOther:
            (update.referralSources.includes("other") &&
              update.referralOther) ||
            null,
          referralAnsweredAt: new Date(),
        }
      : {
          completedAt: new Date(),
          skipped: update.skipped,
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
  // The expiry is shown while it is still ahead of a live grant.
  const [grant, starter] = await Promise.all([
    prisma.userCreditGrant.findFirst({
      where: { userId, source: "signup" },
      select: { expiresAt: true, originalAmountMicros: true, status: true },
    }),
    prisma.cutProject.findFirst({
      where: { id: starterProjectId(userId), userId },
      select: { id: true },
    }),
  ]);
  const expiresAt =
    grant?.status === "active" && grant.expiresAt && grant.expiresAt > new Date()
      ? grant.expiresAt
      : null;
  return {
    version: row.version,
    completedAt: row.completedAt?.toISOString() ?? null,
    skipped: row.skipped,
    slidesDoneAt: row.slidesDoneAt?.toISOString() ?? null,
    tourSteps: row.tourSteps,
    starterReady: starter !== null,
    referralSources: row.referralSources,
    referralOther: row.referralOther,
    signupCredits: grant ? creditMicrosToString(grant.originalAmountMicros) : null,
    signupCreditsExpiresAt: expiresAt?.toISOString() ?? null,
  };
}
