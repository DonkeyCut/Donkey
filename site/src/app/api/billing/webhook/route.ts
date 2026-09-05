import { NextResponse } from "next/server";
import type Stripe from "stripe";

import {
  handleAutoReloadPaymentFailed,
  handleAutoReloadPaymentSucceeded,
  handleCreditTopUpCheckout,
  handleCreditTopUpPaymentSucceeded,
} from "@/lib/billing/credit-purchases";
import {
  subscriptionIsPro,
  syncProSubscription,
} from "@/lib/billing/pro-subscription";
import { getStripe, stripeId } from "@/lib/billing/stripe";
import { notFoundResponse } from "@/lib/donkey-api-auth";
import { ANALYTICS_BILLING_EVENTS } from "@/lib/billing/webhook-events";
import { enqueueJob } from "@/lib/jobs/queue";
import { prisma } from "@/lib/prisma";

const analyticsBillingEvents = new Set<string>(ANALYTICS_BILLING_EVENTS);

// Without a queue configured (local dev) a queued job runs inline before the
// response; give it room.
export const maxDuration = 300;

// Pro is the only subscription product; ignore any other Stripe subscription
// that reaches these webhook events.
async function syncSubscription(subscription: Stripe.Subscription) {
  if (subscriptionIsPro(subscription)) {
    await syncProSubscription(subscription);
  }
}

// Public, signature-verified Stripe webhook. This is an intentional exception to
// the "wrap every route with withDonkeyAuth" rule (see docs/guides/backend-apis):
// Stripe authenticates via the webhook signature, not a Donkey session.
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return notFoundResponse();
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "bad-request", message: "Missing stripe-signature." },
      { status: 400 },
    );
  }

  const stripe = getStripe();
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
  } catch (error) {
    console.error("[billing] webhook signature verification failed", error);
    return NextResponse.json(
      { error: "bad-request", message: "Invalid signature." },
      { status: 400 },
    );
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const checkoutSession = event.data.object;
      const subscriptionId = stripeId(checkoutSession.subscription);
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription);
      } else {
        // A one-time credit top-up (mode=payment) has no subscription.
        await handleCreditTopUpCheckout(stripe, checkoutSession);
      }
      break;
    }
    case "payment_intent.succeeded": {
      // Each handler no-ops unless the PaymentIntent's kind matches, so both run.
      await handleAutoReloadPaymentSucceeded(event.data.object);
      await handleCreditTopUpPaymentSucceeded(event.data.object);
      break;
    }
    case "payment_intent.payment_failed": {
      await handleAutoReloadPaymentFailed(event.data.object);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await syncSubscription(event.data.object);
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice & {
        subscription?: string | { id: string } | null;
      };
      const subscriptionId = stripeId(invoice.subscription);
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription);
      }
      break;
    }
    default:
      break;
  }

  // One checkout fans out into several of these within a second; a refresh
  // already waiting in the queue will read the state they all produced.
  if (analyticsBillingEvents.has(event.type)) {
    const waiting = await prisma.asyncJob.findFirst({
      select: { id: true },
      where: { kind: "billing-refresh", state: "queued" },
    });
    if (!waiting) await enqueueJob("billing-refresh", {}, "stripe-webhook");
  }

  return NextResponse.json({ received: true });
}
