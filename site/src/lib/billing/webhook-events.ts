// Stripe events that change what the super-user analytics show: money moving
// or failing to, a subscription changing state, a checkout walked away from.
// The webhook queues a billing refresh for each; the ones without a handler
// of their own exist only for that. This list, plus the handled events, is
// what the endpoint in Stripe is subscribed to (scripts/stripe-webhook-events.ts).
export const ANALYTICS_BILLING_EVENTS = [
  "charge.failed",
  "charge.refunded",
  "charge.succeeded",
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "payment_intent.payment_failed",
  "payment_intent.succeeded",
  "refund.created",
] as const;
