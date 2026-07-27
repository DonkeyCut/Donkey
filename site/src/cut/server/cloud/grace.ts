// A Pro subscription that ends can leave more bytes in R2 than the free tier
// holds. Those accounts get a grace window before the daily sweep reclaims
// storage down to the free cap (gc.ts); the usage API surfaces the same state
// so the client can warn first.
import { isActiveProStatus } from "@/lib/billing/pro-subscription";
import { prisma } from "@/lib/prisma";
import { FREE_STORAGE_BYTES, type CutLimits } from "./limits";

const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

// Reclamation never fires before this date + grace, so accounts whose Pro
// ended long before the sweep existed still get a full warning window.
const RECLAIM_EPOCH_MS = Date.UTC(2026, 6, 26);

type SubscriptionAnchor = { status: string; currentPeriodEnd: Date | null };

/** When a lapsed subscription's storage becomes reclaimable, or null when the
 * subscription is not one we count as ended. Dunning is not churn: while
 * Stripe is still retrying the invoice (`past_due`) a recovered card puts the
 * account straight back on Pro, so the deletion clock has not started. */
export function graceDeadline(sub: SubscriptionAnchor): Date | null {
  if (!sub.currentPeriodEnd || isActiveProStatus(sub.status) || sub.status === "past_due") {
    return null;
  }
  return new Date(Math.max(sub.currentPeriodEnd.getTime(), RECLAIM_EPOCH_MS) + GRACE_MS);
}

/** Non-null when the account is out of Pro, over the free cap, and anchored to
 * an ended subscription. The caller supplies current usage and limits so one
 * read serves both this check and its own response. */
export async function graceState(
  userId: string,
  bytes: number,
  limits: CutLimits
): Promise<{ deadline: Date; overBytes: number } | null> {
  // Anyone whose quota exceeds the free cap (Pro, superuser) is not in grace.
  if (limits.storageBytes === null || limits.storageBytes > FREE_STORAGE_BYTES) return null;
  if (bytes <= FREE_STORAGE_BYTES) return null;
  const sub = await prisma.proSubscription.findUnique({ where: { userId } });
  const deadline = sub ? graceDeadline(sub) : null;
  if (!deadline) return null;
  return { deadline, overBytes: bytes - FREE_STORAGE_BYTES };
}
