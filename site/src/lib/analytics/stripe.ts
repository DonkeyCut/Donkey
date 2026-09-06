// The billing side of the analytics snapshot, read straight from Stripe.
// Stripe is where the money is, so its charges, refunds, subscriptions and
// abandoned checkouts are the record; every row keeps the Stripe id so the
// dashboard can link into it.

import { drainStripe, getStripe, stripeId, StripeNotConfiguredError } from "@/lib/billing/stripe";
import { subscriptionCancelScheduled, subscriptionIsPro, syncProSubscription } from "@/lib/billing/pro-subscription";
import { creditMicrosPerCent } from "@/lib/credits/amounts";
import { creditAutoReloadKind, creditTopUpKind } from "@/lib/credits/top-up";
import { type AnalyticsStripeSnapshot, utcDayOf } from "@/lib/analytics/schema";
import { prisma } from "@/lib/prisma";

const PAGE = { limit: 100 } as const;
// The credit-purchase kinds stamped on a PaymentIntent at checkout.
const TOPUP_KINDS = new Set<string>([creditTopUpKind, creditAutoReloadKind]);

const microsOf = (cents: number) => (BigInt(cents) * creditMicrosPerCent).toString();
const dayOfUnix = (seconds: number) => utcDayOf(new Date(seconds * 1000));
const isoOfUnix = (seconds: number) => new Date(seconds * 1000).toISOString();

// The dashboard for the account the key belongs to: a test-mode key names
// test-mode objects, which live under /test.
export function stripeDashboardUrl(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new StripeNotConfiguredError();
  return key.includes("_test_") ? "https://dashboard.stripe.com/test" : "https://dashboard.stripe.com";
}

/** Everything the rollup's billing section is derived from. `since` bounds
 * the window-scoped lists (refunds, declines, abandoned checkouts); charges
 * and subscriptions come whole because the funded-all-time figures need them. */
export async function pullStripeSnapshot(since: string): Promise<AnalyticsStripeSnapshot> {
  const stripe = getStripe();
  const sinceUnix = Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000);

  // A customer names its user through the metadata stamped at creation, or
  // through the customer id the user row keeps, the same two routes the
  // webhook sync resolves by.
  const customers = await drainStripe(stripe.customers.list(PAGE));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const userByCustomer = new Map(
    (
      await prisma.user.findMany({
        select: { id: true, stripeCustomerId: true },
        where: { stripeCustomerId: { in: customers.map((c) => c.id) } },
      })
    ).map((user) => [user.stripeCustomerId as string, user.id]),
  );
  const customerOf = (ref: string | { id: string } | null | undefined) => {
    const id = stripeId(ref);
    const customer = id ? customerById.get(id) : undefined;
    return {
      customerId: id,
      email: customer?.email ?? null,
      userId: customer?.metadata?.userId ?? (id ? (userByCustomer.get(id) ?? null) : null),
    };
  };

  // Stripe lists newest first. A user has one row in our database, so only
  // their newest subscription is synced into it: that row follows Stripe
  // here too, and a cancel scheduled through the portal reaches the
  // account's settings card without waiting on a webhook.
  const subscriptions: AnalyticsStripeSnapshot["subscriptions"] = [];
  const synced = new Set<string>();
  for (const sub of await drainStripe(stripe.subscriptions.list({ ...PAGE, status: "all" }))) {
    if (!subscriptionIsPro(sub)) continue;
    const who = customerOf(sub.customer);
    const owner = sub.metadata?.userId ?? who.userId ?? who.customerId ?? sub.id;
    if (!synced.has(owner)) {
      synced.add(owner);
      await syncProSubscription(sub);
    }
    subscriptions.push({
      cancelAt: sub.cancel_at !== null ? isoOfUnix(sub.cancel_at) : null,
      canceledAt: sub.canceled_at !== null ? isoOfUnix(sub.canceled_at) : null,
      cancelScheduled: subscriptionCancelScheduled(sub),
      comment: sub.cancellation_details?.comment ?? null,
      createdAt: isoOfUnix(sub.created),
      customerId: who.customerId,
      email: who.email,
      endedAt: sub.ended_at !== null ? isoOfUnix(sub.ended_at) : null,
      feedback: sub.cancellation_details?.feedback ?? null,
      id: sub.id,
      status: sub.status,
      userId: sub.metadata?.userId ?? who.userId,
    });
  }

  // A charge is a top-up when its PaymentIntent carries a credit-purchase
  // kind, Pro when its customer holds a Pro subscription, and otherwise
  // "other": money the dashboard shows as its own bucket.
  const proCustomers = new Set(subscriptions.map((sub) => sub.customerId));
  const charges: AnalyticsStripeSnapshot["charges"] = [];
  for (const charge of await drainStripe(
    stripe.charges.list({ ...PAGE, expand: ["data.payment_intent"] }),
  )) {
    if (charge.status === "pending") continue;
    const intent =
      typeof charge.payment_intent === "object" ? charge.payment_intent : null;
    const who = customerOf(charge.customer);
    charges.push({
      amountMicros: microsOf(charge.amount),
      customerId: who.customerId,
      day: dayOfUnix(charge.created),
      email: charge.billing_details?.email ?? who.email,
      failure: charge.failure_message ?? charge.failure_code,
      id: charge.id,
      kind: TOPUP_KINDS.has(intent?.metadata?.kind ?? "")
        ? "topup"
        : proCustomers.has(who.customerId)
          ? "pro"
          : "other",
      paymentIntentId: stripeId(charge.payment_intent),
      status: charge.status === "succeeded" && charge.paid ? "paid" : "declined",
      userId: intent?.metadata?.userId ?? who.userId,
    });
  }

  const refunds: AnalyticsStripeSnapshot["refunds"] = [];
  for (const refund of await drainStripe(
    stripe.refunds.list({ ...PAGE, created: { gte: sinceUnix } }),
  )) {
    if (refund.status === "failed" || refund.status === "canceled") continue;
    refunds.push({
      amountMicros: microsOf(refund.amount),
      chargeId: stripeId(refund.charge),
      day: dayOfUnix(refund.created),
      id: refund.id,
    });
  }

  // A checkout that expired unpaid is someone who opened the payment page and
  // walked away; an open session may still complete, so it waits.
  const abandonedCheckouts: AnalyticsStripeSnapshot["abandonedCheckouts"] = [];
  for (const session of await drainStripe(
    stripe.checkout.sessions.list({ ...PAGE, created: { gte: sinceUnix } }),
  )) {
    if (session.status !== "expired") continue;
    const who = customerOf(session.customer);
    abandonedCheckouts.push({
      customerId: who.customerId,
      day: dayOfUnix(session.created),
      email: session.customer_details?.email ?? who.email,
      id: session.id,
      kind: session.mode === "subscription" ? "pro" : "topup",
    });
  }

  return {
    abandonedCheckouts,
    charges,
    dashboardUrl: stripeDashboardUrl(),
    refunds,
    subscriptions,
  };
}
