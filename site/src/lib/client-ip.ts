import { isValidIP } from "@better-auth/core/utils/ip";

// The header the host puts the caller's address in, first entry first. Vercel
// sets it on every request, and better-auth reads the same one.
const FORWARDED_FOR = "x-forwarded-for";

/** The address a request came from, or null when it carries no valid one. */
export function clientIp(headers: Headers): string | null {
  const ip = headers.get(FORWARDED_FOR)?.split(",")[0]?.trim();
  return ip && isValidIP(ip) ? ip : null;
}
