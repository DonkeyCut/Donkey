"use client";

// The price of the next generation, shown on its Generate button before it
// spends anything. A price above the balance disables the button; the 402 the
// server would answer is the same check, in the same micros.
import { Zap } from "lucide-react";
import { useEnvironment } from "@/cut/lib/environment";
import { useSignedIn } from "@/cut/lib/generate";
import { creditMicrosToString, creditStringToMicros } from "@/lib/credits/amounts";
import { creditsFromDollars, formatCreditCount } from "@/lib/credits/format-credits";
import type { CreditPriceSheet } from "@/lib/credits/price-sheet";
import { useCreditBalance, useCreditPriceSheet } from "@/queries/credits";
import { useLiveCreditBalance } from "./CreditsPill";

/** The button's label when the balance can't cover the price. */
export const NOT_ENOUGH_CREDITS = "Not enough credits";

export type GenerateCost = {
  /** Credits the generation costs, rounded up; null until the prices are read. */
  credits: number | null;
  /** The balance is read and falls short of the price. */
  short: boolean;
};

const UNPRICED: GenerateCost = { credits: null, short: false };

/** Prices one generation from the sheet, in micros; null leaves it unpriced.
 * The ChatGPT card carries no credit readings, so the price stays off there. */
export function useGenerateCost(price: (sheet: CreditPriceSheet) => bigint | null): GenerateCost {
  const { chatgpt } = useEnvironment();
  const enabled = useSignedIn() === true && !chatgpt;
  const sheet = useCreditPriceSheet({ enabled });
  const balance = useCreditBalance({ enabled, freshness: "reuse" });
  useLiveCreditBalance();
  if (!enabled || !sheet.data) {
    return UNPRICED;
  }

  const micros = price(sheet.data);
  if (micros === null) {
    return UNPRICED;
  }
  const credits = creditsFromDollars(creditMicrosToString(micros), "up");
  const short = balance.data ? creditStringToMicros(balance.data.balance) < micros : false;
  return { credits, short };
}

/** The price beside the button label: "⚡ 1,318". */
export function CostTag({ cost }: { cost: GenerateCost }) {
  if (cost.credits === null) {
    return null;
  }
  return (
    <span className="ml-1 inline-flex items-center gap-0.5 tabular-nums opacity-80">
      <Zap className="size-3" />
      {formatCreditCount(cost.credits)}
    </span>
  );
}
