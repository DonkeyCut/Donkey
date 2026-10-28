import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { handleCreditPaymentSucceeded } from "@/lib/billing/credit-purchases";
import { trackCheckoutPurchase } from "@/lib/billing/meta-checkout";
import { syncPlanSubscription } from "@/lib/billing/pro-subscription";
import { getStripe, stripeId } from "@/lib/billing/stripe";
import { notFoundResponse } from "@/lib/donkey-api-auth";

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
        await syncPlanSubscription(subscription);
      }
      trackCheckoutPurchase(checkoutSession);
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      // A delayed payment method settled; the purchase is reported here.
      trackCheckoutPurchase(event.data.object);
      break;
    }
    case "payment_intent.succeeded": {
      // A credit purchase charged before purchases were retired.
      await handleCreditPaymentSucceeded(event.data.object);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      await syncPlanSubscription(event.data.object);
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
        await syncPlanSubscription(subscription);
      }
      break;
    }
    default:
      break;
  }

  return NextResponse.json({ received: true });
}
