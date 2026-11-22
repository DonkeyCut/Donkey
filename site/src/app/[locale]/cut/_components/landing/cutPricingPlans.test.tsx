import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

import { ChargeCurrencyProvider } from "@/app/_components/ChargeCurrencyProvider";
import { PlanTermsProvider } from "@/app/_components/PlanTermsProvider";
import { useCutPlans } from "@/app/[locale]/cut/_components/landing/cutPricingPlans";
import type { Currency } from "@/lib/billing/currencies";
import { SETTINGS } from "@/lib/config/registry";
import common from "@/i18n/messages/en/common.json";

function Prices() {
  return <>{useCutPlans().map((plan) => plan.price).join(" | ")}</>;
}

// Made-up local prices and rates: the real ones live in the planTerms setting.
const base = SETTINGS.planTerms.default;
const terms = {
  plus: { ...base.plus, localPrices: { jpy: 600, brl: 20 } },
  pro: { ...base.pro, localPrices: { jpy: 2_400, brl: 80 } },
  max: { ...base.max, localPrices: { jpy: 6_000, brl: 200 } },
  usdRates: { jpy: 120, brl: 8 },
};

const render = (currency: Currency) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{ common }} timeZone="UTC">
        <PlanTermsProvider terms={terms}>
          <ChargeCurrencyProvider currency={currency}>
            <Prices />
          </ChargeCurrencyProvider>
        </PlanTermsProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

test("the plan cards price in the currency they were given", () => {
  expect(render("usd")).toBe("$5/month | $20/month | $49/month");
  expect(render("jpy")).toBe("¥600/month | ¥2,400/month | ¥6,000/month");
  expect(render("brl")).toBe("R$20/month | R$80/month | R$200/month");
});

test("a currency su has not priced shows USD", () => {
  expect(render("eur")).toBe("$5/month | $20/month | $49/month");
});
