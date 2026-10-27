import { describe, expect, test } from "bun:test";

import {
  compactCredits,
  creditsFromDollars,
  dollarsForCredits,
  formatCreditCharge,
  formatCredits,
} from "@/lib/credits/format-credits";
import { formatUsdPlain } from "@/lib/credits/format-usd";
import { formatCreditExpiry } from "@/lib/credits/top-up";

describe("credits display", () => {
  test("a balance rounds down and a charge rounds up", () => {
    expect(creditsFromDollars("0.4999", "down")).toBe(499);
    expect(creditsFromDollars("0.0001", "up")).toBe(1);
    expect(creditsFromDollars("0.5", "down")).toBe(500);
    expect(creditsFromDollars(0.5, "up")).toBe(500);
  });

  test("an overdraft never reads as less owed", () => {
    expect(creditsFromDollars("-0.0005", "down")).toBe(-1);
    expect(formatCredits("-2.4", "en")).toBe("-2,400 credits");
  });

  test("labels count and pluralize", () => {
    expect(formatCredits("0.5", "en")).toBe("500 credits");
    expect(formatCredits("0.001", "en")).toBe("1 credit");
    expect(formatCredits(null, "en")).toBe("—");
    expect(formatCreditCharge("0.0585", "en")).toBe("59 credits");
    expect(formatCreditCharge("0", "en")).toBe("0 credits");
  });

  test("the bar compacts past ten thousand", () => {
    expect(compactCredits("0.5", "en")).toBe("500");
    expect(compactCredits("9.999", "en")).toBe("9,999");
    expect(compactCredits("12.48", "en")).toBe("12.4k");
    expect(compactCredits("20", "en")).toBe("20k");
    expect(compactCredits("1234.5", "en")).toBe("1.2M");
  });

  test("a German reader gets German digits and units", () => {
    expect(formatCredits("12.48", "de")).toBe("12.480 Credits");
    expect(formatCredits("0.001", "de")).toBe("1 Credit");
    expect(compactCredits("12.48", "de")).toBe("12,4k");
    expect(formatUsdPlain("2.5", "de")).toBe("2,50\u00a0$");
    expect(formatUsdPlain("25", "en")).toBe("$25");
    expect(formatCreditExpiry(new Date("2026-09-14T12:00:00Z"), "de")).toBe("14. September 2026");
  });

  test("credits convert back to dollars", () => {
    expect(dollarsForCredits(5000)).toBe(5);
  });
});
