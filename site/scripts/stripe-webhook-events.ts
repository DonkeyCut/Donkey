#!/usr/bin/env bun
/**
 * Points the Stripe webhook endpoint for donkeycut.com at the events the
 * handler listens for, so the endpoint in Stripe
 * matches the code. Idempotent: run it after changing the event list.
 *
 * Run from site/ with the production Stripe key in the environment:
 *   bun run scripts/stripe-webhook-events.ts
 */

import type Stripe from "stripe";

import { getStripe } from "../src/lib/billing/stripe";
import { STRIPE_WEBHOOK_EVENTS } from "../src/lib/billing/webhook-events";

const WEBHOOK_URL = "https://donkeycut.com/api/billing/webhook";

const enabledEvents = [...STRIPE_WEBHOOK_EVENTS].sort() as Stripe.WebhookEndpointUpdateParams.EnabledEvent[];

const stripe = getStripe();
const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const endpoint = endpoints.data.find((e) => e.url === WEBHOOK_URL);
if (!endpoint) {
  console.error(`No webhook endpoint for ${WEBHOOK_URL}; create it in Stripe first.`);
  process.exit(1);
}

const current = [...endpoint.enabled_events].sort();
if (current.join() === enabledEvents.join()) {
  console.log(`${endpoint.id} already listens for ${enabledEvents.length} events.`);
} else {
  await stripe.webhookEndpoints.update(endpoint.id, { enabled_events: enabledEvents });
  const added = enabledEvents.filter((e) => !current.includes(e));
  const removed = current.filter((e) => !enabledEvents.includes(e as (typeof enabledEvents)[number]));
  console.log(`${endpoint.id} updated: +${added.join(", ") || "none"}; -${removed.join(", ") || "none"}`);
}
