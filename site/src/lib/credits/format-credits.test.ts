import { describe, expect, test } from "bun:test";

import {
  compactCredits,
  creditsFromDollars,
  dollarsForCredits,
  formatCreditCharge,
  formatCredits,
} from "@/lib/credits/format-credits";

describe("credits display", () => {
  test("a balance rounds down and a charge rounds up", () => {
    expect(creditsFromDollars("0.4999", "down")).toBe(499);
    expect(creditsFromDollars("0.0001", "up")).toBe(1);
    expect(creditsFromDollars("0.5", "down")).toBe(500);
    expect(creditsFromDollars(0.5, "up")).toBe(500);
  });

  test("an overdraft never reads as less owed", () => {
    expect(creditsFromDollars("-0.0005", "down")).toBe(-1);
    expect(formatCredits("-2.4")).toBe("-2,400 credits");
  });

  test("labels count and pluralize", () => {
    expect(formatCredits("0.5")).toBe("500 credits");
    expect(formatCredits("0.001")).toBe("1 credit");
    expect(formatCredits(null)).toBe("—");
    expect(formatCreditCharge("0.0585")).toBe("59 credits");
    expect(formatCreditCharge("0")).toBe("0 credits");
  });

  test("the bar compacts past ten thousand", () => {
    expect(compactCredits("0.5")).toBe("500");
    expect(compactCredits("9.999")).toBe("9,999");
    expect(compactCredits("12.48")).toBe("12.4k");
    expect(compactCredits("20")).toBe("20k");
    expect(compactCredits("1234.5")).toBe("1.2M");
  });

  test("credits convert back to dollars", () => {
    expect(dollarsForCredits(5000)).toBe(5);
  });
});
