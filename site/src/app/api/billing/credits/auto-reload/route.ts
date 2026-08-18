import { NextResponse } from "next/server";
import { z } from "zod";

import { creditMicrosPerCredit } from "@/lib/credits/amounts";
import {
  creditTopUpMaxDollars,
  creditTopUpMinDollars,
} from "@/lib/credits/top-up";
import { withDonkeyAuth } from "@/lib/donkey-api-auth";
import { prisma } from "@/lib/prisma";

// Defaults shown before the user has saved any config.
const defaultThresholdDollars = 10;
const defaultAmountDollars = 25;

type AutoReloadRow = {
  enabled: boolean;
  thresholdMicros: bigint;
  amountMicros: bigint;
  stripePaymentMethodId: string | null;
  status: string;
  lastError: string | null;
};

function dollarsFromMicros(micros: bigint): number {
  return Number(micros / creditMicrosPerCredit);
}

function serialize(config: AutoReloadRow | null) {
  return {
    amountDollars: config ? dollarsFromMicros(config.amountMicros) : defaultAmountDollars,
    enabled: config?.enabled ?? false,
    hasPaymentMethod: Boolean(config?.stripePaymentMethodId),
    lastError: config?.lastError ?? null,
    status: config?.status ?? "idle",
    thresholdDollars: config
      ? dollarsFromMicros(config.thresholdMicros)
      : defaultThresholdDollars,
  };
}

export const GET = withDonkeyAuth(async (request) => {
  const config = await prisma.creditAutoReload.findUnique({
    where: { userId: request.donkey.userId },
  });
  return NextResponse.json(serialize(config));
});

const updateSchema = z
  .object({
    amountDollars: z.coerce
      .number()
      .int()
      .min(creditTopUpMinDollars)
      .max(creditTopUpMaxDollars),
    enabled: z.boolean(),
    thresholdDollars: z.coerce.number().int().min(0).max(creditTopUpMaxDollars),
  })
  .strict();

export const PUT = withDonkeyAuth(async (request) => {
  const parsed = updateSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: "Provide enabled, thresholdDollars, and amountDollars.",
      },
      { status: 400 },
    );
  }

  const existing = await prisma.creditAutoReload.findUnique({
    where: { userId: request.donkey.userId },
  });

  // Enabling needs a saved card, which is captured the first time the user buys
  // credits. Surface a distinct code so the UI can prompt a one-time top-up.
  if (parsed.data.enabled && !existing?.stripePaymentMethodId) {
    return NextResponse.json(
      {
        error: "no_payment_method",
        message:
          "Buy credits once to save a card, then turn on auto-reload.",
      },
      { status: 409 },
    );
  }

  const amountMicros = BigInt(parsed.data.amountDollars) * creditMicrosPerCredit;
  const thresholdMicros =
    BigInt(parsed.data.thresholdDollars) * creditMicrosPerCredit;

  await prisma.creditAutoReload.upsert({
    create: {
      amountMicros,
      enabled: parsed.data.enabled,
      thresholdMicros,
      userId: request.donkey.userId,
    },
    update: {
      amountMicros,
      enabled: parsed.data.enabled,
      thresholdMicros,
    },
    where: { userId: request.donkey.userId },
  });

  // Re-enabling clears a prior failure so the saved card is retried promptly.
  // Scoped to status "failed" so it never resets an in-flight "charging" lock —
  // clobbering that would let the next inference fire a second off-session charge.
  if (parsed.data.enabled) {
    await prisma.creditAutoReload.updateMany({
      data: { chargingPaymentIntentId: null, lastError: null, status: "idle" },
      where: { status: "failed", userId: request.donkey.userId },
    });
  }

  const config = await prisma.creditAutoReload.findUnique({
    where: { userId: request.donkey.userId },
  });
  return NextResponse.json(serialize(config));
});
