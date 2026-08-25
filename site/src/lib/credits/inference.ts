import { NextResponse, after } from "next/server";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  creditMicrosToString,
  zeroCreditMicros,
} from "@/lib/credits/amounts";
import {
  providerCreditPricing,
  type ProviderCreditPricing,
} from "@/lib/credits/provider-pricing";
import { isJsonObject, toJsonValue } from "@/lib/inference/json";
import type { JsonObject, JsonValue } from "@/lib/inference/providers";

// UserCreditGrant.unit value. Dollar grants ("credit") feed the account
// balance and pay for hosted inference. Balance queries filter on this unit
// because historical rows carry retired units.
export const creditGrantUnit = "credit";

export const inferenceUsageRoutes = {
  assets: "/api/inference/assets/",
  assetsRefresh: "/api/inference/assets/refresh/",
  browserRun: "/api/browser/run/",
  chatCompletions: "/api/inference/chat/completions/",
  responses: "/api/inference/responses/",
} as const;

type CreditsDatabase = PrismaClient | Prisma.TransactionClient;

type CreditRateSnapshot = {
  id: string | null;
  version: number | null;
  baseCostMicros: bigint;
  inputTokenCostMicros: bigint;
  outputTokenCostMicros: bigint;
  totalTokenCostMicros: bigint;
  characterCostMicros: bigint;
  fallbackCostMicros: bigint;
  providerPricing?: ProviderCreditPricing;
};

type NormalizedUsage = {
  billableOutputTokens: bigint;
  cachedInputTokens: bigint;
  durationMillis: bigint;
  generationCount: bigint;
  inputTokens: bigint;
  inputAudioTokens: bigint;
  outputTokens: bigint;
  outputAudioTokens: bigint;
  totalTokens: bigint;
  characterCost: bigint;
};

type InferenceUsageStatus = "failed" | "succeeded";

type InferenceUsageInput = {
  userId: string;
  clientId: string | null;
  // The app conversation this call belongs to, for grouping usage history. Null
  // for background work.
  conversationId?: string | null;
  route: string;
  requestKind: string;
  provider: string;
  model: string;
  status: InferenceUsageStatus;
  usage?: JsonValue;
  errorCode?: string;
  metadata?: JsonObject;
  // "included" records the event for usage tracking without charging the
  // money-credit balance (the call is covered by a subscription). Defaults
  // to "credits".
  billingMode?: "credits" | "included";
};

type CreditPreflightInput = {
  userId: string;
  route: string;
  provider?: string;
  model?: string;
  // Opt-in: reject an unpriced (provider, model) at the preflight, before the provider runs. Only
  // safe when the billed model equals this requested model (e.g. asset generation). Routes whose
  // billed model differs from the request (a provider that pins its own model) must leave this off
  // and rely on the post-generation price resolution instead.
  enforceModelPrice?: boolean;
};

export type RecordedInferenceUsage = {
  usageEventId: string;
  creditCostMicros: bigint;
  remainingBalanceMicros: bigint;
};

export class InsufficientCreditsError extends Error {
  public constructor(
    public readonly balanceMicros: bigint,
    // The flat price the blocked generation would have charged. Set only when
    // the balance was positive and short of it, so a caller can tell "empty"
    // from "not enough for this one" and say which.
    public readonly requiredMicros?: bigint,
  ) {
    super("Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

export class CreditLimitExceededError extends Error {
  public constructor(
    public readonly limitId: string,
    public readonly maxCreditsPerPeriodMicros: bigint,
  ) {
    super("Credit limit exceeded");
    this.name = "CreditLimitExceededError";
  }
}

// A billable (route, provider, model) has no configured price — neither a code-level rate in
// provider-pricing.ts nor a DB override. We fail loudly instead of charging a guessed default,
// and we fail at the preflight (before the provider runs and bills upstream) whenever the model
// is known, so an unpriced model never produces an externally-billed-but-uncharged generation.
export class CreditRateNotConfiguredError extends Error {
  public constructor(
    public readonly route: string,
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(
      `No credit price configured for provider="${provider}" model="${model}" on route="${route}".`,
    );
    this.name = "CreditRateNotConfiguredError";
  }
}

export async function ensureCreditAccount(userId: string) {
  // Signup grants are provisioned once at user creation (see
  // provisionSignupGrants); this only guarantees the account row exists.
  return ensureCreditAccountRecord(prisma, userId);
}

export async function grantCredits(input: {
  userId: string;
  amountMicros: bigint;
  source: string;
  sourceId?: string;
  expiresAt?: Date;
  periodStart?: Date;
  periodEnd?: Date;
  description?: string;
  metadata?: JsonObject;
}) {
  if (input.amountMicros <= zeroCreditMicros) {
    throw new Error("Credit grants must be positive.");
  }

  if (input.sourceId) {
    const existing = await prisma.userCreditGrant.findFirst({
      where: {
        source: input.source,
        sourceId: input.sourceId,
        unit: creditGrantUnit,
        userId: input.userId,
      },
    });
    if (existing) {
      return existing;
    }
  }

  try {
    return await withWriteConflictRetry(() => prisma.$transaction(
      async (tx) => {
        const account = await ensureCreditAccountRecord(tx, input.userId);
        // An account already carrying an overdraft — one that predates the
        // write-off at charge time — starts from zero here, so the grant lands
        // whole. Funding $25 credits $25.
        await forgiveOverdraft(tx, account.id, input.userId, account.balanceMicros, null);
        const updatedAccount = await tx.userCreditAccount.update({
          data: {
            balanceMicros: {
              increment: input.amountMicros,
            },
            lifetimeGrantedMicros: {
              increment: input.amountMicros,
            },
          },
          where: {
            id: account.id,
          },
        });

        const grant = await tx.userCreditGrant.create({
          data: {
            accountId: account.id,
            description: input.description,
            expiresAt: input.expiresAt,
            metadata: prismaJson(input.metadata),
            originalAmountMicros: input.amountMicros,
            periodEnd: input.periodEnd,
            periodStart: input.periodStart,
            remainingAmountMicros: input.amountMicros,
            source: input.source,
            sourceId: input.sourceId,
            unit: creditGrantUnit,
            userId: input.userId,
          },
        });

        await tx.userCreditLedgerEntry.create({
          data: {
            accountId: account.id,
            amountMicros: input.amountMicros,
            balanceAfterMicros: updatedAccount.balanceMicros,
            description: input.description,
            grantId: grant.id,
            metadata: prismaJson(input.metadata),
            source: input.source,
            sourceId: input.sourceId,
            type: "grant",
            userId: input.userId,
          },
        });

        return grant;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    ));
  } catch (error) {
    if (
      input.sourceId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.userCreditGrant.findFirst({
        where: {
          source: input.source,
          sourceId: input.sourceId,
          unit: creditGrantUnit,
          userId: input.userId,
        },
      });
      if (existing) {
        return existing;
      }
    }

    throw error;
  }
}

export async function expireCredits(userId: string, now = new Date()) {
  await withWriteConflictRetry(() => prisma.$transaction(
    async (tx) => {
      const account = await ensureCreditAccountRecord(tx, userId);
      await expireCreditsForAccount(tx, account.id, userId, account.balanceMicros, now);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  ));
}

export async function assertCanUseInference(input: CreditPreflightInput) {
  await ensureCreditAccount(input.userId);
  await expireCredits(input.userId);

  const account = await prisma.userCreditAccount.findUniqueOrThrow({
    where: {
      userId: input.userId,
    },
  });

  if (account.balanceMicros <= zeroCreditMicros) {
    throw new InsufficientCreditsError(account.balanceMicros);
  }

  await assertWithinConfiguredLimits(input);
  // A flat-priced generation is held to its own price below, so a $1.33 clip
  // can no longer start on $0.30. A token-metered call still clears on any
  // positive balance — its cost isn't knowable until the model has run — and
  // whatever it overshoots is written off (forgiveOverdraft). Concurrency
  // stays open in both: the scene-run pool submits up to 6 clips at once and
  // every submit reads the balance before the first charge lands, so a nearly
  // empty account can still overshoot by the rest of the pool. The "writeoff"
  // ledger rows total what that actually costs.
  await assertModelIsAffordable(input, account.balanceMicros);

  return account;
}

// When the model that will be billed is already known at preflight, settle two things before the
// provider runs: the model has a configured price, and the balance covers it.
//
// The price check turns an unpriced model into a clean, pre-generation failure instead of an
// upstream-billed generation that throws while recording usage. The billed model isn't always
// known up front (some adapters resolve a default from an omitted model); those cases still fail
// loudly post-generation via resolveCreditRate — never via a guessed fallback.
//
// The balance check applies to models that bill a flat amount per generation (video, image,
// music): the charge is the same whatever the model does, so it is knowable here. Without it a
// $1.33 clip started on a $0.30 balance, ran, billed in full, and left $1.03 to write off.
async function assertModelIsAffordable(
  input: CreditPreflightInput,
  balanceMicros: bigint,
) {
  if (!input.enforceModelPrice) {
    return;
  }
  const provider = input.provider?.trim();
  const model = input.model?.trim();
  if (!provider || !model) {
    return;
  }

  // Throws CreditRateNotConfiguredError when no code or DB price exists (and the route isn't
  // flat-priced); recordInferenceUsage resolves the rate again in-tx to do the charging.
  const rate = await resolveCreditRate(prisma, input.route, provider, model);
  // A DB rate override replaces the code pricing wholesale and carries no flat per-generation
  // price, so an overridden model falls back to the positive-balance gate above.
  const generationCostMicros =
    rate.providerPricing?.generationCostMicros ?? zeroCreditMicros;
  if (
    generationCostMicros > zeroCreditMicros &&
    balanceMicros < generationCostMicros
  ) {
    throw new InsufficientCreditsError(balanceMicros, generationCostMicros);
  }
}

export async function requireInferenceCredits(input: CreditPreflightInput) {
  try {
    await assertCanUseInference(input);
    return {
      ok: true as const,
    };
  } catch (error) {
    const response = creditErrorResponse(error);
    if (response) {
      return {
        ok: false as const,
        response,
      };
    }

    throw error;
  }
}

// Prisma raises P2034 when a transaction is aborted by a write conflict or
// deadlock. A Serializable transaction rolls back entirely on conflict, so
// nothing partially committed and the whole body is safe to re-run. Concurrent
// writers against the same credit account routinely collide here — two
// generations at once, the parallel signup grants, simultaneous Stripe webhook
// deliveries for one checkout — so every credit transaction retries
// transparently instead of surfacing the race to its caller.
async function withWriteConflictRetry<T>(run: () => Promise<T>): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const isWriteConflict =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";
      if (!isWriteConflict || attempt >= maxAttempts) {
        throw error;
      }
    }
  }
}

export async function recordInferenceUsage(input: InferenceUsageInput) {
  const recorded = await withWriteConflictRetry(() => prisma.$transaction(
    async (tx): Promise<RecordedInferenceUsage> => {
      const included = input.billingMode === "included";
      // "included" calls never read or charge the balance, so skip the
      // grant-expiry scan; we still ensure the account row exists because the
      // usage event references it.
      const account = await ensureCreditAccountRecord(tx, input.userId);
      const balanceAfterExpiry = included
        ? account.balanceMicros
        : await expireCreditsForAccount(
            tx,
            account.id,
            input.userId,
            account.balanceMicros,
            new Date(),
          );
      const rate = !included && input.status === "succeeded"
        ? await resolveCreditRate(tx, input.route, input.provider, input.model)
        : zeroCreditRate();
      const normalizedUsage = normalizeProviderUsage(input.usage);
      const creditCostMicros = !included && input.status === "succeeded"
        ? costForUsage(rate, normalizedUsage)
        : zeroCreditMicros;
      const billingStatus = included
        ? "included"
        : billingStatusFor(input.status, creditCostMicros);
      const usageEvent = await tx.inferenceUsageEvent.create({
        data: {
          accountId: account.id,
          billingStatus,
          clientId: input.clientId,
          conversationId: input.conversationId ?? null,
          creditCostMicros,
          errorCode: input.errorCode,
          metadata: prismaJson(input.metadata),
          model: input.model,
          normalizedUsage: prismaJson(normalizedUsageJson(normalizedUsage)),
          provider: input.provider,
          providerUsage: prismaJson(input.usage),
          rateId: rate.id,
          rateVersion: rate.version,
          requestKind: input.requestKind,
          route: input.route,
          status: input.status,
          userId: input.userId,
        },
      });

      if (creditCostMicros <= zeroCreditMicros) {
        return {
          creditCostMicros,
          remainingBalanceMicros: balanceAfterExpiry,
          usageEventId: usageEvent.id,
        };
      }

      await debitGrants(tx, account.id, creditCostMicros);
      const updatedAccount = await tx.userCreditAccount.update({
        data: {
          balanceMicros: {
            decrement: creditCostMicros,
          },
          lifetimeChargedMicros: {
            increment: creditCostMicros,
          },
        },
        where: {
          id: account.id,
        },
      });

      await tx.userCreditLedgerEntry.create({
        data: {
          accountId: account.id,
          amountMicros: -creditCostMicros,
          balanceAfterMicros: updatedAccount.balanceMicros,
          source: "inference",
          sourceId: usageEvent.id,
          type: "usage",
          usageEventId: usageEvent.id,
          userId: input.userId,
        },
      });

      return {
        creditCostMicros,
        remainingBalanceMicros: await forgiveOverdraft(
          tx,
          account.id,
          input.userId,
          updatedAccount.balanceMicros,
          usageEvent.id,
        ),
        usageEventId: usageEvent.id,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  ));

  // After a real charge commits, top up the balance via auto-reload if it fell
  // below the user's threshold. Scheduled with next/server `after` so it runs
  // off the response path AND the serverless runtime keeps the function alive
  // until it finishes (an un-awaited promise can be dropped after the response).
  // The dynamic import breaks the module cycle (billing -> credits -> billing);
  // the post-charge balance is passed in so the trigger needn't re-read it.
  if (input.billingMode !== "included" && recorded.creditCostMicros > zeroCreditMicros) {
    const balanceMicros = recorded.remainingBalanceMicros;
    try {
      after(async () => {
        try {
          const { maybeTriggerCreditAutoReload } = await import(
            "@/lib/billing/credit-auto-reload"
          );
          await maybeTriggerCreditAutoReload(input.userId, balanceMicros);
        } catch (error) {
          console.error("[credit-auto-reload] trigger failed", error);
        }
      });
    } catch (error) {
      // `after` throws outside a request scope (e.g. a script/test). Don't let
      // that break usage recording — auto-reload is best-effort.
      console.error("[credit-auto-reload] could not schedule trigger", error);
    }
  }

  return recorded;
}

export async function recordFailedInferenceUsage(input: {
  userId: string;
  clientId: string | null;
  conversationId?: string | null;
  route: string;
  requestKind: string;
  provider: string;
  model: string;
  errorCode: string;
  metadata?: JsonObject;
  billingMode?: "credits" | "included";
}) {
  try {
    await recordInferenceUsage({
      ...input,
      status: "failed",
    });
  } catch (error) {
    console.error("[inference-usage] failed to record failed inference usage", {
      error,
      errorCode: input.errorCode,
      model: input.model,
      provider: input.provider,
      requestKind: input.requestKind,
      route: input.route,
    });
  }
}

export async function getCreditBalance(userId: string) {
  await ensureCreditAccount(userId);
  await expireCredits(userId);

  const account = await prisma.userCreditAccount.findUniqueOrThrow({
    where: {
      userId,
    },
  });
  const now = new Date();
  const recentSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [grants, limits, recentUsageEvents] = await Promise.all([
    prisma.userCreditGrant.findMany({
      orderBy: [
        {
          expiresAt: "asc",
        },
        {
          createdAt: "asc",
        },
      ],
      take: 50,
      where: {
        remainingAmountMicros: {
          gt: zeroCreditMicros,
        },
        status: "active",
        // Dollar grants only; historical rows can carry retired units.
        unit: creditGrantUnit,
        userId,
        OR: [
          {
            expiresAt: null,
          },
          {
            expiresAt: {
              gt: now,
            },
          },
        ],
      },
    }),
    prisma.userCreditLimit.findMany({
      orderBy: {
        createdAt: "desc",
      },
      where: {
        active: true,
        userId,
        AND: [
          {
            OR: [
              {
                periodStart: null,
              },
              {
                periodStart: {
                  lte: now,
                },
              },
            ],
          },
          {
            OR: [
              {
                periodEnd: null,
              },
              {
                periodEnd: {
                  gt: now,
                },
              },
            ],
          },
        ],
      },
    }),
    prisma.inferenceUsageEvent.findMany({
      orderBy: {
        createdAt: "desc",
      },
      select: {
        creditCostMicros: true,
        createdAt: true,
        model: true,
        provider: true,
        route: true,
        status: true,
      },
      take: 100,
      where: {
        createdAt: {
          gte: recentSince,
        },
        userId,
      },
    }),
  ]);

  return {
    balance: creditMicrosToString(account.balanceMicros),
    balanceMicros: account.balanceMicros.toString(),
    lifetimeCharged: creditMicrosToString(account.lifetimeChargedMicros),
    lifetimeGranted: creditMicrosToString(account.lifetimeGrantedMicros),
    activeGrants: grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      sourceId: grant.sourceId,
      remaining: creditMicrosToString(grant.remainingAmountMicros),
      originalAmount: creditMicrosToString(grant.originalAmountMicros),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      periodStart: grant.periodStart?.toISOString() ?? null,
      periodEnd: grant.periodEnd?.toISOString() ?? null,
    })),
    currentLimits: limits.map((limit) => ({
      id: limit.id,
      scope: limit.scope,
      route: limit.route,
      provider: limit.provider,
      model: limit.model,
      maxCreditsPerPeriod: limit.maxCreditsPerPeriodMicros === null
        ? null
        : creditMicrosToString(limit.maxCreditsPerPeriodMicros),
      periodStart: limit.periodStart?.toISOString() ?? null,
      periodEnd: limit.periodEnd?.toISOString() ?? null,
    })),
    recentUsageTotals: recentUsageTotals(recentUsageEvents),
  };
}

export function creditUsageHeaders(recorded: RecordedInferenceUsage) {
  return {
    "X-Donkey-Credits-Charged": creditMicrosToString(recorded.creditCostMicros),
    "X-Donkey-Credits-Remaining": creditMicrosToString(recorded.remainingBalanceMicros),
  };
}

export function creditErrorResponse(error: unknown) {
  if (error instanceof InsufficientCreditsError) {
    // One message, two codes. An empty balance stops everything hosted; a
    // balance that is merely short of one flat-priced generation stops that
    // generation while chat and the other metered calls keep working, so it
    // carries its own code and the price it couldn't cover.
    return NextResponse.json(
      {
        error:
          error.requiredMicros === undefined
            ? "insufficient_credits"
            : "insufficient_credits_for_generation",
        message: "Insufficient credits",
        balance: creditMicrosToString(error.balanceMicros),
        ...(error.requiredMicros === undefined
          ? {}
          : { required: creditMicrosToString(error.requiredMicros) }),
      },
      {
        status: 402,
      },
    );
  }

  if (error instanceof CreditLimitExceededError) {
    return NextResponse.json(
      {
        error: "credit_limit_exceeded",
        message: "This account has reached a configured credit limit.",
        limitId: error.limitId,
        maxCreditsPerPeriod: creditMicrosToString(error.maxCreditsPerPeriodMicros),
      },
      {
        status: 402,
      },
    );
  }

  if (error instanceof CreditRateNotConfiguredError) {
    // A configured-pricing gap is a server-side misconfiguration, surfaced cleanly (and logged)
    // instead of crashing the request as an unhandled 500.
    console.error("[inference-credits] no credit price configured", {
      route: error.route,
      provider: error.provider,
      model: error.model,
    });
    return NextResponse.json(
      {
        error: "credit_price_not_configured",
        message: "No price is configured for the requested model.",
      },
      {
        status: 500,
      },
    );
  }

  return null;
}

async function ensureCreditAccountRecord(db: CreditsDatabase, userId: string) {
  return db.userCreditAccount.upsert({
    create: {
      userId,
    },
    update: {},
    where: {
      userId,
    },
  });
}

async function expireCreditsForAccount(
  tx: Prisma.TransactionClient,
  accountId: string,
  userId: string,
  startingBalanceMicros: bigint,
  now: Date,
) {
  let balanceMicros = startingBalanceMicros;
  const expiringGrants = await tx.userCreditGrant.findMany({
    orderBy: {
      expiresAt: "asc",
    },
    where: {
      accountId,
      expiresAt: {
        lte: now,
      },
      remainingAmountMicros: {
        gt: zeroCreditMicros,
      },
      status: "active",
      // Dollar grants only — a historical row with a retired unit must never
      // decrement balanceMicros here.
      unit: creditGrantUnit,
    },
  });

  for (const grant of expiringGrants) {
    const expiredMicros = grant.remainingAmountMicros;
    balanceMicros -= expiredMicros;
    await tx.userCreditGrant.update({
      data: {
        remainingAmountMicros: zeroCreditMicros,
        status: "expired",
      },
      where: {
        id: grant.id,
      },
    });
    await tx.userCreditAccount.update({
      data: {
        balanceMicros: {
          decrement: expiredMicros,
        },
      },
      where: {
        id: accountId,
      },
    });
    await tx.userCreditLedgerEntry.create({
      data: {
        accountId,
        amountMicros: -expiredMicros,
        balanceAfterMicros: balanceMicros,
        grantId: grant.id,
        source: grant.source,
        sourceId: grant.sourceId,
        type: "expiration",
        userId,
      },
    });
  }

  return balanceMicros;
}

// The balance never sits below zero. A charge is priced from what the provider
// actually did, so it can land on more than the account can cover — a
// token-metered call that ran long, or two generations that both cleared the
// preflight and then billed. Whatever the account couldn't pay is ours to eat,
// and eating it here is the whole point: an overdraft left on the balance would
// otherwise be silently collected from the user's next top-up, which is how
// funding $25 came to show $24.67.
//
// The write-off is booked rather than clamped. A "writeoff" ledger row keeps
// the account reconcilable (grants - charges + write-offs = balance) and makes
// the leakage a number someone can total, instead of a difference between the
// stored balance and the displayed one.
async function forgiveOverdraft(
  tx: Prisma.TransactionClient,
  accountId: string,
  userId: string,
  balanceMicros: bigint,
  usageEventId: string | null,
) {
  if (balanceMicros >= zeroCreditMicros) {
    return balanceMicros;
  }

  const forgivenMicros = -balanceMicros;
  await tx.userCreditAccount.update({
    data: {
      balanceMicros: {
        increment: forgivenMicros,
      },
    },
    where: {
      id: accountId,
    },
  });
  await tx.userCreditLedgerEntry.create({
    data: {
      accountId,
      amountMicros: forgivenMicros,
      balanceAfterMicros: zeroCreditMicros,
      description: "Overdraft written off",
      source: "inference",
      sourceId: usageEventId,
      type: "writeoff",
      usageEventId,
      userId,
    },
  });

  return zeroCreditMicros;
}

async function debitGrants(
  tx: Prisma.TransactionClient,
  accountId: string,
  creditCostMicros: bigint,
) {
  let remainingCostMicros = creditCostMicros;
  const grants = await tx.userCreditGrant.findMany({
    where: {
      accountId,
      remainingAmountMicros: {
        gt: zeroCreditMicros,
      },
      status: "active",
      // Dollar inference only spends dollar grants — a historical row with a
      // retired unit must never be debited here.
      unit: creditGrantUnit,
    },
  });

  // Consumption priority: spend the subscription / periodic allotment (any grant with an expiry or a
  // billing period) BEFORE prepaid purchased credits, which never expire. Within the expiring set the
  // soonest-to-expire is spent first so nothing is wasted; permanent purchased credits are spent last,
  // oldest first. This ordering is exactly why top-ups are granted with no expiry (see grantCredits
  // callers): a non-expiring grant sorts to the back of the queue.
  const ordered = [...grants].sort(compareGrantConsumptionOrder);

  for (const grant of ordered) {
    if (remainingCostMicros <= zeroCreditMicros) {
      return;
    }

    const debitMicros = grant.remainingAmountMicros < remainingCostMicros
      ? grant.remainingAmountMicros
      : remainingCostMicros;
    const nextRemainingMicros = grant.remainingAmountMicros - debitMicros;
    await tx.userCreditGrant.update({
      data: {
        remainingAmountMicros: nextRemainingMicros,
        status: nextRemainingMicros === zeroCreditMicros ? "exhausted" : "active",
      },
      where: {
        id: grant.id,
      },
    });
    remainingCostMicros -= debitMicros;
  }

}

type GrantConsumptionFields = {
  expiresAt: Date | null;
  periodEnd: Date | null;
  createdAt: Date;
};

// When a grant runs out (its expiry or billing-period end), as epoch millis, or null if it never
// expires. A subscription/periodic grant has one of these; a purchased top-up has neither.
function grantConsumptionDeadline(grant: GrantConsumptionFields): number | null {
  const deadline = grant.expiresAt ?? grant.periodEnd;
  return deadline ? deadline.getTime() : null;
}

// Orders grants for debit: expiring (subscription/periodic) credits ahead of non-expiring (purchased)
// ones, soonest deadline first, then oldest grant first. Keeps use-it-or-lose-it credit from being
// wasted while never-expiring purchased credit waits at the back.
function compareGrantConsumptionOrder(
  left: GrantConsumptionFields,
  right: GrantConsumptionFields,
): number {
  const leftDeadline = grantConsumptionDeadline(left);
  const rightDeadline = grantConsumptionDeadline(right);

  if (leftDeadline === null && rightDeadline !== null) {
    return 1;
  }
  if (leftDeadline !== null && rightDeadline === null) {
    return -1;
  }
  if (leftDeadline !== null && rightDeadline !== null && leftDeadline !== rightDeadline) {
    return leftDeadline - rightDeadline;
  }
  return left.createdAt.getTime() - right.createdAt.getTime();
}

async function assertWithinConfiguredLimits(input: CreditPreflightInput) {
  const now = new Date();
  const limits = await prisma.userCreditLimit.findMany({
    where: {
      active: true,
      userId: input.userId,
      maxCreditsPerPeriodMicros: {
        not: null,
      },
      AND: [
        {
          OR: [
            {
              periodStart: null,
            },
            {
              periodStart: {
                lte: now,
              },
            },
          ],
        },
        {
          OR: [
            {
              periodEnd: null,
            },
            {
              periodEnd: {
                gt: now,
              },
            },
          ],
        },
      ],
    },
  });

  for (const limit of limits) {
    if (!limitMatchesPreflight(limit, input)) {
      continue;
    }

    const charged = await prisma.inferenceUsageEvent.aggregate({
      _sum: {
        creditCostMicros: true,
      },
      where: {
        userId: input.userId,
        route: limit.route ?? undefined,
        provider: limit.provider ?? undefined,
        model: limit.model ?? undefined,
        createdAt: {
          gte: limit.periodStart ?? undefined,
          lt: limit.periodEnd ?? undefined,
        },
        status: "succeeded",
      },
    });
    const chargedMicros = charged._sum.creditCostMicros ?? zeroCreditMicros;
    if (
      limit.maxCreditsPerPeriodMicros !== null &&
      chargedMicros >= limit.maxCreditsPerPeriodMicros
    ) {
      throw new CreditLimitExceededError(limit.id, limit.maxCreditsPerPeriodMicros);
    }
  }
}

function limitMatchesPreflight(
  limit: {
    route: string | null;
    provider: string | null;
    model: string | null;
  },
  input: CreditPreflightInput,
) {
  if (limit.route && limit.route !== input.route) {
    return false;
  }
  if (limit.provider && limit.provider !== input.provider) {
    return false;
  }
  if (limit.model && limit.model !== input.model) {
    return false;
  }

  return true;
}

async function resolveCreditRate(
  db: CreditsDatabase,
  route: string,
  provider: string,
  model: string,
): Promise<CreditRateSnapshot> {
  const now = new Date();
  const rates = await db.inferenceCreditRate.findMany({
    orderBy: [
      {
        version: "desc",
      },
      {
        createdAt: "desc",
      },
    ],
    where: {
      active: true,
      validFrom: {
        lte: now,
      },
      OR: [
        {
          validUntil: null,
        },
        {
          validUntil: {
            gt: now,
          },
        },
      ],
      AND: [
        {
          OR: [
            {
              route,
              provider,
              model,
            },
            {
              route: null,
              provider,
              model,
            },
            {
              route: null,
              provider: null,
              model: null,
            },
          ],
        },
      ],
    },
  });

  const exactRate = rates.find((rate) => {
    return rate.route === route && rate.provider === provider && rate.model === model;
  });
  const providerModelRate = rates.find((rate) => {
    return rate.route === null && rate.provider === provider && rate.model === model;
  });
  const globalRate = rates.find((rate) => {
    return rate.route === null && rate.provider === null && rate.model === null;
  });
  const providerDefaultRate = defaultCreditRate(provider, model);

  if (exactRate || providerModelRate || providerDefaultRate.providerPricing) {
    return rateSnapshot(
      exactRate ?? providerModelRate,
      providerDefaultRate,
    );
  }

  if (globalRate) {
    return rateSnapshot(globalRate, providerDefaultRate);
  }

  // Every billable model must have a price — a code-level rate in provider-pricing.ts or a DB
  // override. Fail loudly instead of silently charging a default so a missing price is caught.
  throw new CreditRateNotConfiguredError(route, provider, model);
}

function rateSnapshot(
  rate: {
    id: string;
    version: number;
    baseCostMicros: bigint;
    inputTokenCostMicros: bigint;
    outputTokenCostMicros: bigint;
    totalTokenCostMicros: bigint;
    characterCostMicros: bigint;
    fallbackCostMicros: bigint;
  } | undefined,
  fallback: CreditRateSnapshot,
) {
  if (!rate) {
    return fallback;
  }

  return {
    id: rate.id,
    version: rate.version,
    baseCostMicros: rate.baseCostMicros,
    inputTokenCostMicros: rate.inputTokenCostMicros,
    outputTokenCostMicros: rate.outputTokenCostMicros,
    totalTokenCostMicros: rate.totalTokenCostMicros,
    characterCostMicros: rate.characterCostMicros,
    fallbackCostMicros: rate.fallbackCostMicros,
  };
}

function defaultCreditRate(
  provider: string,
  model: string,
): CreditRateSnapshot {
  const providerPricing = providerCreditPricing(provider, model);

  return {
    id: null,
    version: null,
    baseCostMicros: zeroCreditMicros,
    inputTokenCostMicros: zeroCreditMicros,
    outputTokenCostMicros: zeroCreditMicros,
    totalTokenCostMicros: zeroCreditMicros,
    characterCostMicros: zeroCreditMicros,
    fallbackCostMicros: zeroCreditMicros,
    providerPricing,
  };
}

function zeroCreditRate(): CreditRateSnapshot {
  return {
    id: null,
    version: null,
    baseCostMicros: zeroCreditMicros,
    inputTokenCostMicros: zeroCreditMicros,
    outputTokenCostMicros: zeroCreditMicros,
    totalTokenCostMicros: zeroCreditMicros,
    characterCostMicros: zeroCreditMicros,
    fallbackCostMicros: zeroCreditMicros,
  };
}

const unitScalePerMillion = BigInt("1000000");

function costForUsage(rate: CreditRateSnapshot, usage: NormalizedUsage) {
  if (rate.providerPricing) {
    return costForProviderPricing(rate, usage);
  }

  const hasBillableUsage =
    usage.inputTokens > zeroCreditMicros ||
    usage.outputTokens > zeroCreditMicros ||
    usage.totalTokens > zeroCreditMicros ||
    usage.characterCost > zeroCreditMicros ||
    usage.durationMillis > zeroCreditMicros ||
    usage.generationCount > zeroCreditMicros;
  if (!hasBillableUsage) {
    return rate.fallbackCostMicros;
  }

  return (
    rate.baseCostMicros +
    usage.inputTokens * rate.inputTokenCostMicros +
    usage.outputTokens * rate.outputTokenCostMicros +
    usage.totalTokens * rate.totalTokenCostMicros +
    usage.characterCost * rate.characterCostMicros
  );
}

function costForProviderPricing(
  rate: CreditRateSnapshot,
  usage: NormalizedUsage,
) {
  const pricing = providerPricingForUsage(rate.providerPricing, usage);
  if (!pricing) {
    return rate.fallbackCostMicros;
  }

  const inputAudioTokens = minBigint(usage.inputAudioTokens, usage.inputTokens);
  const outputAudioTokens = minBigint(usage.outputAudioTokens, usage.outputTokens);
  const cachedInputTokens = minBigint(
    usage.cachedInputTokens,
    usage.inputTokens - inputAudioTokens,
  );
  const uncachedInputTokens = maxBigint(
    zeroCreditMicros,
    usage.inputTokens - inputAudioTokens - cachedInputTokens,
  );
  const textOutputTokens = maxBigint(
    zeroCreditMicros,
    usage.billableOutputTokens - outputAudioTokens,
  );
  const inputTokenRate = pricing.inputTokenCostMicrosPerMillion ?? zeroCreditMicros;
  const cachedInputTokenRate =
    pricing.cachedInputTokenCostMicrosPerMillion ?? inputTokenRate;
  const outputTokenRate = pricing.outputTokenCostMicrosPerMillion ?? zeroCreditMicros;
  const inputAudioTokenRate =
    pricing.inputAudioTokenCostMicrosPerMillion ?? inputTokenRate;
  const outputAudioTokenRate =
    pricing.outputAudioTokenCostMicrosPerMillion ?? outputTokenRate;

  const tokenAndUnitCostMicros =
    perMillionCost(uncachedInputTokens, inputTokenRate) +
    perMillionCost(cachedInputTokens, cachedInputTokenRate) +
    perMillionCost(inputAudioTokens, inputAudioTokenRate) +
    perMillionCost(textOutputTokens, outputTokenRate) +
    perMillionCost(outputAudioTokens, outputAudioTokenRate) +
    usage.characterCost * (pricing.characterCostMicros ?? zeroCreditMicros) +
    usage.generationCount * (pricing.generationCostMicros ?? zeroCreditMicros);
  const durationCostMicros = ceilDivide(
    usage.durationMillis * (pricing.durationSecondCostMicros ?? zeroCreditMicros),
    BigInt(1000),
  );
  const costMicros =
    tokenAndUnitCostMicros +
    (pricing.durationCostOnlyWhenNoTokenUsage && tokenAndUnitCostMicros > zeroCreditMicros
      ? zeroCreditMicros
      : durationCostMicros);

  return costMicros > zeroCreditMicros ? costMicros : rate.fallbackCostMicros;
}

function providerPricingForUsage(
  pricing: ProviderCreditPricing | undefined,
  usage: NormalizedUsage,
) {
  if (!pricing) {
    return undefined;
  }

  const contextTokens = usage.totalTokens > zeroCreditMicros
    ? usage.totalTokens
    : usage.inputTokens + usage.outputTokens;
  if (
    pricing.longContext &&
    pricing.longContextThresholdTokens &&
    contextTokens > pricing.longContextThresholdTokens
  ) {
    return {
      ...pricing,
      ...pricing.longContext,
      longContext: undefined,
    };
  }

  return pricing;
}

function perMillionCost(units: bigint, microsPerMillion: bigint) {
  if (units <= zeroCreditMicros || microsPerMillion <= zeroCreditMicros) {
    return zeroCreditMicros;
  }

  return ceilDivide(units * microsPerMillion, unitScalePerMillion);
}

function ceilDivide(numerator: bigint, denominator: bigint) {
  if (denominator <= zeroCreditMicros) {
    throw new Error("Cannot divide by zero.");
  }
  if (numerator <= zeroCreditMicros) {
    return zeroCreditMicros;
  }

  return (numerator + denominator - BigInt(1)) / denominator;
}

function minBigint(left: bigint, right: bigint) {
  return left < right ? left : right;
}

function maxBigint(left: bigint, right: bigint) {
  return left > right ? left : right;
}

function normalizeProviderUsage(usage: JsonValue | undefined): NormalizedUsage {
  if (!usage || !isJsonObject(usage)) {
    return emptyNormalizedUsage();
  }

  const inputTokens = bigintFromJson(
    usage.input_tokens,
    usage.inputTokens,
    usage.promptTokenCount,
    usage.prompt_tokens,
  );
  const outputTokens = bigintFromJson(
    usage.output_tokens,
    usage.outputTokens,
    usage.candidatesTokenCount,
    usage.completion_tokens,
  );
  const totalTokens = bigintFromJson(
    usage.total_tokens,
    usage.totalTokens,
    usage.totalTokenCount,
  );
  const promptTokenDetails =
    usage.promptTokensDetails ?? usage.prompt_tokens_details;
  const candidateTokenDetails =
    usage.candidatesTokensDetails ?? usage.candidates_tokens_details;
  const inputAudioTokens = bigintFromJson(
    nestedJsonValue(usage, "input_tokens_details", "audio_tokens"),
    nestedJsonValue(usage, "inputTokensDetails", "audioTokens"),
    nestedJsonValue(usage, "prompt_tokens_details", "audio_tokens"),
    nestedJsonValue(usage, "promptTokensDetails", "audioTokens"),
    usage.input_audio_tokens,
    usage.inputAudioTokens,
    modalityTokenCount(promptTokenDetails, "audio"),
  );
  const outputAudioTokens = bigintFromJson(
    nestedJsonValue(usage, "output_tokens_details", "audio_tokens"),
    nestedJsonValue(usage, "outputTokensDetails", "audioTokens"),
    nestedJsonValue(usage, "completion_tokens_details", "audio_tokens"),
    nestedJsonValue(usage, "completionTokensDetails", "audioTokens"),
    usage.output_audio_tokens,
    usage.outputAudioTokens,
    modalityTokenCount(candidateTokenDetails, "audio"),
  );
  const billableOutputTokens = maxBigint(
    outputTokens,
    totalTokens - inputTokens,
  );

  return {
    billableOutputTokens,
    cachedInputTokens: bigintFromJson(
      nestedJsonValue(usage, "input_tokens_details", "cached_tokens"),
      nestedJsonValue(usage, "inputTokensDetails", "cachedTokens"),
      usage.cached_input_tokens,
      usage.cachedInputTokens,
      usage.cachedContentTokenCount,
    ),
    characterCost: bigintFromJson(
      usage.characterCost,
      usage.character_cost,
      usage.characters,
    ),
    durationMillis: bigintFromJson(
      usage.durationMillis,
      usage.duration_millis,
      usage.durationMS,
      usage.duration_ms,
      usage.audioDurationMillis,
      usage.audio_duration_millis,
    ),
    generationCount: bigintFromJson(
      usage.generationCount,
      usage.generation_count,
      usage.generations,
    ),
    inputAudioTokens,
    inputTokens,
    outputAudioTokens,
    outputTokens,
    totalTokens,
  };
}

function emptyNormalizedUsage(): NormalizedUsage {
  return {
    billableOutputTokens: zeroCreditMicros,
    cachedInputTokens: zeroCreditMicros,
    characterCost: zeroCreditMicros,
    durationMillis: zeroCreditMicros,
    generationCount: zeroCreditMicros,
    inputAudioTokens: zeroCreditMicros,
    inputTokens: zeroCreditMicros,
    outputAudioTokens: zeroCreditMicros,
    outputTokens: zeroCreditMicros,
    totalTokens: zeroCreditMicros,
  };
}

function normalizedUsageJson(usage: NormalizedUsage): JsonObject {
  return {
    billableOutputTokens: usage.billableOutputTokens.toString(),
    cachedInputTokens: usage.cachedInputTokens.toString(),
    characterCost: usage.characterCost.toString(),
    durationMillis: usage.durationMillis.toString(),
    generationCount: usage.generationCount.toString(),
    inputAudioTokens: usage.inputAudioTokens.toString(),
    inputTokens: usage.inputTokens.toString(),
    outputAudioTokens: usage.outputAudioTokens.toString(),
    outputTokens: usage.outputTokens.toString(),
    totalTokens: usage.totalTokens.toString(),
  };
}

// The token/usage numbers the usage UI surfaces to explain a call's cost. Read
// here, right next to normalizedUsageJson which writes them, so the field names
// stay in sync — renaming a field updates both in one place.
export type InferenceUsageBreakdown = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  generationCount: number;
  durationMillis: number;
};

export function readInferenceUsageBreakdown(
  normalizedUsage: unknown,
): InferenceUsageBreakdown {
  const source =
    normalizedUsage &&
    typeof normalizedUsage === "object" &&
    !Array.isArray(normalizedUsage)
      ? (normalizedUsage as Record<string, unknown>)
      : {};
  // Values are written as stringified BigInts (see normalizedUsageJson).
  const num = (key: keyof InferenceUsageBreakdown): number => {
    const value = source[key];
    const parsed =
      typeof value === "string"
        ? Number(value)
        : typeof value === "number"
          ? value
          : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    cachedInputTokens: num("cachedInputTokens"),
    durationMillis: num("durationMillis"),
    generationCount: num("generationCount"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    totalTokens: num("totalTokens"),
  };
}

function nestedJsonValue(
  value: JsonObject,
  objectKey: string,
  nestedKey: string,
): JsonValue | undefined {
  const nested = value[objectKey];
  if (!isJsonObject(nested)) {
    return undefined;
  }

  return nested[nestedKey];
}

function modalityTokenCount(value: JsonValue | undefined, modality: string) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  let tokens = zeroCreditMicros;
  for (const item of value) {
    if (!isJsonObject(item)) {
      continue;
    }
    const itemModality = stringFromJson(item.modality ?? item.type);
    if (itemModality?.toLowerCase() !== modality) {
      continue;
    }
    tokens += bigintFromJson(item.tokenCount, item.token_count, item.tokens);
  }

  return tokens;
}

function bigintFromJson(...values: (JsonValue | bigint | undefined)[]) {
  for (const value of values) {
    if (typeof value === "bigint" && value >= zeroCreditMicros) {
      return value;
    }

    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return BigInt(value);
    }

    if (typeof value === "string" && /^\d+$/u.test(value)) {
      return BigInt(value);
    }
  }

  return zeroCreditMicros;
}

function stringFromJson(value: JsonValue | undefined) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function billingStatusFor(status: InferenceUsageStatus, creditCostMicros: bigint) {
  if (status === "failed") {
    return "failed";
  }

  return creditCostMicros > zeroCreditMicros ? "charged" : "zero_cost";
}

function prismaJson(value: JsonValue | undefined): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return toJsonValue(value) as Prisma.InputJsonValue;
}

function recentUsageTotals(
  events: {
    creditCostMicros: bigint;
    model: string;
    provider: string;
    route: string;
    status: string;
  }[],
) {
  const byKey = new Map<string, {
    count: number;
    creditCostMicros: bigint;
    failedCount: number;
    model: string;
    provider: string;
    route: string;
  }>();

  for (const event of events) {
    const key = [event.route, event.provider, event.model].join("\u0000");
    const current = byKey.get(key) ?? {
      count: 0,
      creditCostMicros: zeroCreditMicros,
      failedCount: 0,
      model: event.model,
      provider: event.provider,
      route: event.route,
    };
    current.count += 1;
    current.creditCostMicros += event.creditCostMicros;
    if (event.status === "failed") {
      current.failedCount += 1;
    }
    byKey.set(key, current);
  }

  return [...byKey.values()].map((total) => ({
    count: total.count,
    creditsCharged: creditMicrosToString(total.creditCostMicros),
    failedCount: total.failedCount,
    model: total.model,
    provider: total.provider,
    route: total.route,
  }));
}
