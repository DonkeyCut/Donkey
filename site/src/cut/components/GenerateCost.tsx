"use client";

// Whether the balance covers the next generation, checked before it spends
// anything. A Generate button the balance can't cover opens the upgrade wall
// when pressed; the 402 the server would answer is the same check, in the
// same micros.
import { useEnvironment } from "@/cut/lib/environment";
import { useSignedIn } from "@/cut/lib/generate";
import { openUpgrade } from "@/cut/lib/upgrade";
import { creditStringToMicros } from "@/lib/credits/amounts";
import type { CreditPriceSheet } from "@/lib/credits/price-sheet";
import { useCreditBalance, useCreditPriceSheet } from "@/queries/credits";
import { useLiveCreditBalance } from "./CreditsPill";

export type GenerateCost = {
  /** The balance is read and falls short of the price. */
  short: boolean;
};

const UNPRICED: GenerateCost = { short: false };

/** Prices one generation from the sheet, in micros; null leaves it unpriced.
 * The ChatGPT card carries no credit readings, so the check stays off there. */
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
  const short = balance.data ? creditStringToMicros(balance.data.balance) < micros : false;
  return { short };
}

/** The Generate button's press: the upgrade wall when the balance falls
 * short, the generation otherwise. */
export function generateButton(cost: GenerateCost, go: () => void): { onClick: () => void } {
  return { onClick: cost.short ? () => void openUpgrade("credits") : go };
}
