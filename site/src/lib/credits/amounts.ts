export const zeroCreditMicros = BigInt(0);
export const creditMicrosPerDollar = BigInt("1000000");
// $1 = 100 cents = 1,000,000 micros, so 1 cent = 10,000 micros. Single source for
// the Stripe-cents conversion used by subscription allowances and off-session charges.
export const creditMicrosPerCent = creditMicrosPerDollar / BigInt(100);

export function creditStringToMicros(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return zeroCreditMicros;
  }

  const match = /^([+-])?(\d+)(?:\.(\d{0,6}))?$/u.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid credit amount: ${trimmed}`);
  }

  const sign = match[1] === "-" ? -BigInt(1) : BigInt(1);
  const whole = BigInt(match[2]) * creditMicrosPerDollar;
  const fractional = BigInt((match[3] ?? "").padEnd(6, "0"));

  return sign * (whole + fractional);
}

export function creditMicrosToString(value: bigint) {
  const sign = value < zeroCreditMicros ? "-" : "";
  const absolute = value < zeroCreditMicros ? -value : value;
  const whole = absolute / creditMicrosPerDollar;
  const fractional = absolute % creditMicrosPerDollar;
  const fractionalText = fractional.toString().padStart(6, "0").replace(/0+$/u, "");

  return fractionalText ? `${sign}${whole}.${fractionalText}` : `${sign}${whole}`;
}
