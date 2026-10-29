// The currencies the plans sell in. USD is every plan's Stripe default; each
// other currency is a hand-set amount on the same Stripe price (its
// currency_options), so a subscription keeps its currency through every move
// between plans. A visitor's country picks the currency, and a country with
// none of its own pays in USD. Client-safe: no server imports.

export const CURRENCIES = ["usd", "eur", "gbp", "cad", "aud", "jpy", "krw", "brl", "mxn"] as const;
export type Currency = (typeof CURRENCIES)[number];

// The currencies a plan's terms set by hand; USD is its monthlyDollars.
export type LocalCurrency = Exclude<Currency, "usd">;
export const LOCAL_CURRENCIES = CURRENCIES.filter((c): c is LocalCurrency => c !== "usd");

export const DEFAULT_CURRENCY: Currency = "usd";

// Digits after the decimal point in Stripe's minor unit: ¥2,800 is 2800.
const ZERO_DECIMAL: ReadonlySet<Currency> = new Set(["jpy", "krw"]);
const CENT_DIGITS = 2;

// Countries that pay in a currency of their own. The euro covers the
// eurozone, the territories and microstates that use it.
const EURO_COUNTRIES = [
  "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT",
  "SI", "SK", "AD", "AX", "BL", "GF", "GP", "ME", "MC", "MF", "MQ", "PM", "RE", "SM", "VA", "XK", "YT",
];
const MARKET_BY_COUNTRY: ReadonlyMap<string, Currency> = new Map([
  ...EURO_COUNTRIES.map((country) => [country, "eur"] as const),
  ["GB", "gbp"],
  ["CA", "cad"],
  ["AU", "aud"],
  ["JP", "jpy"],
  ["KR", "krw"],
  ["BR", "brl"],
  ["MX", "mxn"],
]);

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

/** The currency a country's visitors see and pay in. */
export function marketCurrency(country: string | null): Currency {
  return (country && MARKET_BY_COUNTRY.get(country)) || DEFAULT_CURRENCY;
}

function minorDigits(currency: Currency): number {
  return ZERO_DECIMAL.has(currency) ? 0 : CENT_DIGITS;
}

/** An amount in Stripe's minor unit: 59 BRL → 5900, 2800 JPY → 2800. */
export function toMinor(amount: number, currency: Currency): number {
  return Math.round(amount * 10 ** minorDigits(currency));
}

/** A Stripe minor-unit amount as the currency reads it: 5900 BRL → 59. */
export function fromMinor(minor: number, currency: Currency): number {
  return minor / 10 ** minorDigits(currency);
}
