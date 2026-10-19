// The Stripe events the webhook handles: what the endpoint in Stripe is
// subscribed to (scripts/stripe-webhook-events.ts).
export const STRIPE_WEBHOOK_EVENTS = [
  "checkout.session.async_payment_succeeded",
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
] as const;
