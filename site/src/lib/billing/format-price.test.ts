import { expect, test } from "bun:test";

import { formatMinorPrice, formatPrice } from "./format-price";

test("whole prices carry no decimals in any currency", () => {
  expect(formatPrice(20, "usd", "en")).toBe("$20");
  expect(formatPrice(59, "brl", "pt-BR")).toBe("R$\u00a059");
  expect(formatPrice(2800, "jpy", "en")).toBe("¥2,800");
  expect(formatPrice(19, "eur", "de")).toBe("19\u00a0€");
});

test("a minor-unit price reads in its currency", () => {
  expect(formatMinorPrice(2950, "brl", "en")).toBe("R$29.50");
  expect(formatMinorPrice(1400, "jpy", "en")).toBe("¥1,400");
  expect(formatMinorPrice(1000, "usd", "en")).toBe("$10");
});
