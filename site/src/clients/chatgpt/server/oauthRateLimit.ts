import { isIP } from "node:net";
import {
  checkInMemoryRateLimit,
  rateLimitResponse,
} from "@/lib/inference/rate-limit";
import { tokenHash } from "@/clients/chatgpt/server/oauthPolicy";

type OAuthOperation = "token" | "revoke" | "embed";

export class OAuthRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("OAuth request limit reached.");
  }
}

/** Limit unauthenticated traffic using the address supplied by the hosting proxy. */
export function limitOAuthSource(
  request: Request,
  operation: OAuthOperation,
  requestsPerMinute: number,
): Response | null {
  const address = request.headers.get("x-vercel-forwarded-for")?.trim();
  // Local servers lack Vercel's trusted address; their authenticated user limits still apply.
  if (!address || !isIP(address)) return null;

  const rateLimit = checkInMemoryRateLimit({
    key: `chatgpt:oauth:${operation}:source:${tokenHash(address)}`,
    limit: requestsPerMinute,
    windowMs: 60_000,
  });
  return rateLimit.ok ? null : rateLimitResponse(rateLimit.retryAfterSeconds);
}

/** Call only after the credential and its owner have been verified. */
export function enforceOAuthUserLimit(
  userId: string,
  operation: OAuthOperation,
  requestsPerMinute: number,
): void {
  const rateLimit = checkInMemoryRateLimit({
    key: `chatgpt:oauth:${operation}:user:${userId}`,
    limit: requestsPerMinute,
    windowMs: 60_000,
  });
  if (!rateLimit.ok) {
    throw new OAuthRateLimitError(rateLimit.retryAfterSeconds);
  }
}
