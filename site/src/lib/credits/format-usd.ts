// Money in a sentence: whole dollars carry no cents ("$25"), anything else
// its two ("$2.57").
export function formatUsdPlain(value: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return "$0";
  const whole = Number.isInteger(parsed);
  return parsed.toLocaleString("en-US", {
    currency: "USD",
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
    style: "currency",
  });
}
