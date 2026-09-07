import { describe, expect, test } from "bun:test";

import { creditStringToMicros } from "./amounts";
import { creditOutlivesWindow, crossedSpentShare, endOfUtcDay, subscribeBonusStatus } from "./subscribe-bonus";

const usd = (s: string) => creditStringToMicros(s);

describe("the subscribe bonus", () => {
  test("opens once half of the signup grant is spent", () => {
    const grant = { originalAmountMicros: usd("25"), remainingAmountMicros: usd("12.5") };
    expect(crossedSpentShare(grant, usd("0"), 50)).toBe(true);
    expect(crossedSpentShare({ ...grant, remainingAmountMicros: usd("12.51") }, usd("0"), 50)).toBe(false);
  });

  test("credit that lapsed at expiry was never spent", () => {
    const expired = { originalAmountMicros: usd("25"), remainingAmountMicros: usd("0") };
    expect(crossedSpentShare(expired, usd("20"), 50)).toBe(false);
    expect(crossedSpentShare(expired, usd("10"), 50)).toBe(true);
  });

  test("an empty grant never crosses", () => {
    expect(crossedSpentShare({ originalAmountMicros: usd("0"), remainingAmountMicros: usd("0") }, usd("0"), 50)).toBe(false);
  });

  test("the credit stays spendable through the last day", () => {
    expect(endOfUtcDay("2026-10-29").toISOString()).toBe("2026-10-29T23:59:59.999Z");
  });

  test("the offer is open until it closes, and claimed once the grant lands", () => {
    const closesAt = new Date("2026-09-08T12:00:00Z");
    const free = (at: string) => ({ now: new Date(at), pro: false });
    expect(subscribeBonusStatus({ closesAt, claimedAt: null }, free("2026-09-08T11:59:00Z"))).toBe("open");
    expect(subscribeBonusStatus({ closesAt, claimedAt: null }, free("2026-09-08T12:00:01Z"))).toBe("closed");
    expect(subscribeBonusStatus({ closesAt: null, claimedAt: null }, free("2030-01-01T00:00:00Z"))).toBe("open");
    expect(subscribeBonusStatus({ closesAt, claimedAt: new Date() }, free("2026-09-09T00:00:00Z"))).toBe("claimed");
  });

  test("an account that already holds Pro reads the offer as closed", () => {
    const closesAt = new Date("2026-09-08T12:00:00Z");
    expect(subscribeBonusStatus({ closesAt, claimedAt: null }, { now: new Date("2026-09-08T11:00:00Z"), pro: true })).toBe("closed");
  });

  test("no offer promises credit that dies inside its window", () => {
    const closesAt = new Date("2026-10-30T01:00:00Z");
    expect(creditOutlivesWindow(endOfUtcDay("2026-10-29"), closesAt)).toBe(false);
    expect(creditOutlivesWindow(endOfUtcDay("2026-10-30"), closesAt)).toBe(true);
    expect(creditOutlivesWindow(null, closesAt)).toBe(true);
  });
});
