import { expect, test } from "bun:test";

import { fromMinor, marketCurrency, toMinor } from "./currencies";

test("a country pays in its own currency, and one with none in USD", () => {
  expect(marketCurrency("DE")).toBe("eur");
  expect(marketCurrency("BR")).toBe("brl");
  expect(marketCurrency("JP")).toBe("jpy");
  expect(marketCurrency("PL")).toBe("usd");
  expect(marketCurrency(null)).toBe("usd");
});

test("minor units follow the currency", () => {
  expect(toMinor(59, "brl")).toBe(5900);
  expect(toMinor(2800, "jpy")).toBe(2800);
  expect(fromMinor(2950, "brl")).toBe(29.5);
  expect(fromMinor(26000, "krw")).toBe(26000);
});
