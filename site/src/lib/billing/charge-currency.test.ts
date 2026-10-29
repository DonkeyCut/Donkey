import { expect, test } from "bun:test";

import { currencyFor } from "./charge-currency";

test("an account Stripe already bills keeps its currency anywhere", () => {
  expect(currencyFor("usd", "BR")).toBe("usd");
  expect(currencyFor("eur", "US")).toBe("eur");
});

test("an account never billed pays in its country's currency", () => {
  expect(currencyFor(null, "BR")).toBe("brl");
  expect(currencyFor(null, "PL")).toBe("usd");
});

test("a customer billed in a currency no plan sells in is refused", () => {
  expect(() => currencyFor("inr", "IN")).toThrow();
});
