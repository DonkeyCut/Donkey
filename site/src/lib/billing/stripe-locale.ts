import type Stripe from "stripe";

import type { Locale } from "@/i18n/locales";

// The language Stripe's checkout and billing portal speak to a reader of each
// of ours. Both pages take these values; Stripe names Simplified Chinese "zh".
type StripeLocale = Stripe.Checkout.SessionCreateParams.Locale & Stripe.BillingPortal.SessionCreateParams.Locale;

export const STRIPE_LOCALE: Record<Locale, StripeLocale> = {
  en: "en",
  es: "es",
  "pt-BR": "pt-BR",
  fr: "fr",
  de: "de",
  ja: "ja",
  ko: "ko",
  "zh-CN": "zh",
};
