// The credit-grant sources that mean money changed hands: a one-time top-up
// and a Pro billing period. Audiences and the purchase metric both read them.
export const PURCHASE_SOURCES = ["stripe_topup", "pro_subscription"] as const;
