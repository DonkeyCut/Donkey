// The visitor's country, as the edge reports it. Free of server imports, so
// the proxy reads it too.
const COUNTRY_HEADER = "x-vercel-ip-country";

export function countryFromHeaders(headers: Headers): string | null {
  const raw = headers.get(COUNTRY_HEADER)?.trim().toUpperCase();
  return raw && /^[A-Z]{2}$/.test(raw) ? raw : null;
}
