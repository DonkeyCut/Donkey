import { NO_CREDITS_MESSAGE } from "./credits";

// The message a failed hosted call shows: sign in on 401, the credits line on
// 402, otherwise the route's own words. The provider's reason (a filtered
// prompt, a rate limit) rides under `details.message` and joins the headline;
// a rejected request names its first bad field.

const UNAUTHORIZED = 401;
const PAYMENT_REQUIRED = 402;

interface ErrorBody {
  message?: unknown;
  error?: unknown;
  details?: { message?: unknown } | null;
  issues?: { path?: unknown; message?: unknown }[];
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The error line for a hosted response that came back not ok. `signIn` is
 * what a signed-out caller reads, e.g. "Sign in to Donkey to check facts." */
export async function readHostedError(res: Response, signIn: string, fallback: string): Promise<string> {
  if (res.status === UNAUTHORIZED) {
    return signIn;
  }
  if (res.status === PAYMENT_REQUIRED) {
    return NO_CREDITS_MESSAGE;
  }

  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  const issue = body?.issues?.[0];
  const issueText = issue && text(issue.message) ? `${text(issue.path) ?? "request"}: ${text(issue.message)}` : undefined;
  const message = text(body?.message) ?? issueText ?? text(body?.error);
  const detail = text(body?.details?.message);
  if (detail && detail !== message) {
    return message ? `${message} (${detail})` : detail;
  }
  return message ?? fallback;
}
