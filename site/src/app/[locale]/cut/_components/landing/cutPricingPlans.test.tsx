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

const render = (currency: Currency) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={{ common }} timeZone="UTC">
        <PlanTermsProvider terms={SETTINGS.planTerms.default}>
          <ChargeCurrencyProvider currency={currency}>
            <Prices />
          </ChargeCurrencyProvider>
        </PlanTermsProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

test("the plan cards price in the currency they were given", () => {
  expect(render("usd")).toBe("$5/month | $20/month | $49/month");
  expect(render("jpy")).toBe("¥700/month | ¥2,800/month | ¥6,800/month");
  expect(render("brl")).toBe("R$15/month | R$59/month | R$149/month");
});
