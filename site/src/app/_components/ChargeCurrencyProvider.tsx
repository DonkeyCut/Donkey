"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { Currency } from "@/lib/billing/currencies";
import { useAccountCurrency } from "@/queries/billing";

// The currency every card that sells a plan prices in. The landing has it
// from its address, which the proxy picks from the visitor's country, and
// provides it below. Everywhere else a card prices for the signed-in account:
// the currency Stripe already bills it in, or its country's, from the pricing
// read the app loads as it starts. isPending holds a card until that read
// lands, so a figure never repaints in another currency.
export type ChargeCurrency = { currency: Currency; isPending: boolean };

const ChargeCurrencyContext = createContext<ChargeCurrency | null>(null);

export function ChargeCurrencyProvider({ currency, children }: { currency: Currency; children: ReactNode }) {
  return (
    <ChargeCurrencyContext.Provider value={{ currency, isPending: false }}>{children}</ChargeCurrencyContext.Provider>
  );
}

/** The currency plan prices read in. */
export function useChargeCurrency(): ChargeCurrency {
  const page = useContext(ChargeCurrencyContext);
  const account = useAccountCurrency({ enabled: page === null });
  return page ?? account;
}
