import { describe, expect, test } from "bun:test";
import { knownBalance, reportBalance, useHostedBalance } from "./hosted";

// The balance the page decides from: a read from the balance route, or the
// balance a charged call reported after it.

describe("knownBalance", () => {
  test("a balance reported after the read wins", () => {
    useHostedBalance.setState({ balance: null, reportedAt: 0 });
    const readAt = Date.now() - 1000;
    reportBalance("0.000000");
    expect(knownBalance("5.000000", readAt)).toBe(0);
  });

  test("a read newer than the reported balance wins", () => {
    reportBalance("0.000000");
    expect(knownBalance("10.000000", Date.now() + 1)).toBe(10);
  });

  test("with nothing reported the read stands", () => {
    useHostedBalance.setState({ balance: null, reportedAt: 0 });
    expect(knownBalance("2.500000", 1)).toBe(2.5);
  });
});
